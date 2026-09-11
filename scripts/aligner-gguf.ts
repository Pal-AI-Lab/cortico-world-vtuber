/**
 * Qwen3-ForcedAligner-0.6B(HF safetensors)→ GGUF。
 *
 *   tsx scripts/aligner-gguf.ts [--src <目录>] [--out <目录>]
 *
 * 产出两个文件:
 * - Qwen3-Aligner-LM-Q8_0.gguf    llama.cpp `qwen3` 架构的 0.6B 主干 + 词表
 * - Qwen3-Aligner-Audio-F16.gguf  mtmd/clip 的 `qwen3a` 音频塔 + 多模态投影 + 时间桶头
 *
 * 主干权重矩阵使用 Q8_0,归一化层保留 F32,显存约为 F16 方案的一半。分类输出的
 * 时间桶宽为几十毫秒。音频塔与多模态投影使用 F16,时间桶头 `score.weight` 使用 F32。
 *
 * 时间桶头(score.weight,5000×1024)与音频 GGUF 同存。主干加载器拒绝额外张量;
 * 音频加载器允许未知张量,对齐器按名称读取该张量。
 *
 * 原始权重不含音频塔位置编码。转换器按 Whisper 正弦公式生成 1500×d_model 矩阵;
 * qwen3a 图使用前 13 行。
 */
import { closeSync, createWriteStream, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { argv } from 'node:process';

// ─── GGUF 写入 ────────────────────────────────────────────────────────────

const GGUF_MAGIC = 0x46554747; // "GGUF"
const GGUF_VERSION = 3;
const GGUF_ALIGNMENT = 32;

/** gguf_metadata_value_type */
const enum KvType {
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
}

/** ggml_type,只用到这三个 */
const enum GgmlType {
  F32 = 0,
  F16 = 1,
  Q8_0 = 8,
}

/** block_q8_0:32 个元素共用一个 f16 缩放,后跟 32 个 int8 */
const QK8_0 = 32;
const Q8_0_BLOCK_BYTES = 34;

type KvValue =
  | { t: KvType.UINT32 | KvType.INT32; v: number }
  | { t: KvType.FLOAT32; v: number }
  | { t: KvType.BOOL; v: boolean }
  | { t: KvType.STRING; v: string }
  | { t: KvType.ARRAY; elem: KvType; v: readonly (string | number)[] };

/** 张量的数据由 fill 现算现写,避免把 1.8GB 权重整个读进内存 */
interface TensorPlan {
  name: string;
  /** ggml 序(ne[0] 最快变);由 torch 形状反转而来 */
  ne: number[];
  type: GgmlType;
  nbytes: number;
  write: (out: NodeJS.WritableStream) => Promise<void>;
}

function u64(n: number): Buffer {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function gstr(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([u64(body.length), body]);
}

function kvValueBytes(v: KvValue): Buffer {
  const tag = Buffer.allocUnsafe(4);
  tag.writeUInt32LE(v.t);
  switch (v.t) {
    case KvType.UINT32: {
      const b = Buffer.allocUnsafe(4);
      b.writeUInt32LE(v.v);
      return Buffer.concat([tag, b]);
    }
    case KvType.INT32: {
      const b = Buffer.allocUnsafe(4);
      b.writeInt32LE(v.v);
      return Buffer.concat([tag, b]);
    }
    case KvType.FLOAT32: {
      const b = Buffer.allocUnsafe(4);
      b.writeFloatLE(v.v);
      return Buffer.concat([tag, b]);
    }
    case KvType.BOOL:
      return Buffer.concat([tag, Buffer.from([v.v ? 1 : 0])]);
    case KvType.STRING:
      return Buffer.concat([tag, gstr(v.v)]);
    case KvType.ARRAY: {
      const head = Buffer.allocUnsafe(4);
      head.writeUInt32LE(v.elem);
      const parts: Buffer[] = [tag, head, u64(v.v.length)];
      if (v.elem === KvType.STRING) {
        for (const s of v.v) parts.push(gstr(s as string));
      } else {
        const width = 4;
        const buf = Buffer.allocUnsafe(v.v.length * width);
        for (let i = 0; i < v.v.length; i++) {
          if (v.elem === KvType.INT32) buf.writeInt32LE(v.v[i] as number, i * width);
          else buf.writeUInt32LE(v.v[i] as number, i * width);
        }
        parts.push(buf);
      }
      return Buffer.concat(parts);
    }
  }
}

function padTo(n: number, align: number): number {
  return (align - (n % align)) % align;
}

async function writeGguf(path: string, kv: Map<string, KvValue>, tensors: TensorPlan[]): Promise<void> {
  const head: Buffer[] = [];
  const magic = Buffer.allocUnsafe(8);
  magic.writeUInt32LE(GGUF_MAGIC, 0);
  magic.writeUInt32LE(GGUF_VERSION, 4);
  head.push(magic, u64(tensors.length), u64(kv.size));
  for (const [k, v] of kv) head.push(gstr(k), kvValueBytes(v));

  // 张量 offset 相对数据段起点,而数据段起点取决于信息段长度。
  // 信息段长度用零 offset 计算，随后回填实际值。
  const infoBytes = (offsets: number[]): Buffer => {
    const parts: Buffer[] = [];
    tensors.forEach((t, i) => {
      const dims = Buffer.allocUnsafe(4);
      dims.writeUInt32LE(t.ne.length);
      const typ = Buffer.allocUnsafe(4);
      typ.writeUInt32LE(t.type);
      parts.push(gstr(t.name), dims, ...t.ne.map(u64), typ, u64(offsets[i]));
    });
    return Buffer.concat(parts);
  };

  const offsets: number[] = [];
  let cursor = 0;
  for (const t of tensors) {
    offsets.push(cursor);
    cursor += t.nbytes + padTo(t.nbytes, GGUF_ALIGNMENT);
  }

  const headBuf = Buffer.concat([...head, infoBytes(offsets)]);
  const dataStart = headBuf.length + padTo(headBuf.length, GGUF_ALIGNMENT);

  const out = createWriteStream(path);
  const done = new Promise<void>((res, rej) => {
    out.on('finish', res);
    out.on('error', rej);
  });
  out.write(headBuf);
  out.write(Buffer.alloc(dataStart - headBuf.length));
  for (const t of tensors) {
    await t.write(out);
    const pad = padTo(t.nbytes, GGUF_ALIGNMENT);
    if (pad) out.write(Buffer.alloc(pad));
  }
  out.end();
  await done;
}

// ─── bf16 → f16 / f32 ─────────────────────────────────────────────────────

/**
 * bf16 与 f32 共享指数域,左移 16 位就是精确的 f32;f16 指数只有 5 位,
 * 小于 2^-14 的权重在 F16 量化后成为次正规数。
 */
function bf16BitsToF16Bits(b: number): number {
  return f32BitsToF16Bits((b << 16) >>> 0);
}

function f32ToF16Bits(v: number): number {
  floatView[0] = v;
  return f32BitsToF16Bits(bitsView[0]);
}

function f32BitsToF16Bits(x: number): number {
  const sign = (x >>> 16) & 0x8000;
  const abs = x & 0x7fffffff;
  if (abs >= 0x47800000) return sign | (abs > 0x7f800000 ? 0x7e00 : 0x7c00);
  if (abs < 0x38800000) {
    const shift = 126 - (abs >>> 23);
    if (shift > 24) return sign;
    const man = (abs & 0x7fffff) | 0x800000;
    return sign | ((man + (1 << (shift - 1))) >>> shift);
  }
  return sign | (((abs - 0x38000000 + 0x1000) >>> 13) & 0x7fff);
}

function bf16ToF32(b: number): number {
  bitsView[0] = (b << 16) >>> 0;
  return floatView[0];
}

const scratch = new ArrayBuffer(4);
const bitsView = new Uint32Array(scratch);
const floatView = new Float32Array(scratch);

// ─── safetensors 读取 ─────────────────────────────────────────────────────

interface StEntry {
  dtype: string;
  shape: number[];
  data_offsets: [number, number];
}

class SafeTensors {
  private readonly fd: number;
  private readonly base: number;
  readonly index: Record<string, StEntry>;

  constructor(readonly path: string) {
    this.fd = openSync(path, 'r');
    const lenBuf = Buffer.allocUnsafe(8);
    readSync(this.fd, lenBuf, 0, 8, 0);
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    const header = Buffer.allocUnsafe(headerLen);
    readSync(this.fd, header, 0, headerLen, 8);
    const parsed = JSON.parse(header.toString('utf8')) as Record<string, StEntry>;
    delete (parsed as Record<string, unknown>).__metadata__;
    this.index = parsed;
    this.base = 8 + headerLen;
  }

  get(name: string): StEntry {
    const e = this.index[name];
    if (!e) throw new Error(`safetensors 缺张量: ${name}`);
    if (e.dtype !== 'BF16') throw new Error(`${name} 不是 BF16 而是 ${e.dtype}`);
    return e;
  }

  /** 按 bf16 原始 uint16 位读回;张量最大 311MB,单次读得下 */
  readBits(name: string): Uint16Array {
    const e = this.get(name);
    const [lo, hi] = e.data_offsets;
    // allocUnsafeSlow 不走内存池,byteOffset 必为 0,Uint16Array 才能贴着它建
    const buf = Buffer.allocUnsafeSlow(hi - lo);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(this.fd, buf, read, buf.length - read, this.base + lo + read);
      if (n <= 0) throw new Error(`读 ${name} 提前结束`);
      read += n;
    }
    return new Uint16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  }

  close(): void {
    closeSync(this.fd);
  }
}

// ─── 张量计划 ─────────────────────────────────────────────────────────────

/** 分块写,避免为一个 311MB 张量再额外分配一份等大缓冲。是 32 的倍数,不切断 q8 块 */
const CHUNK_ELEMS = 1 << 22;

function encodeChunk(bits: Uint16Array, off: number, end: number, type: GgmlType): Buffer {
  if (type === GgmlType.Q8_0) {
    const blocks = (end - off) / QK8_0;
    const buf = Buffer.allocUnsafe(blocks * Q8_0_BLOCK_BYTES);
    const block = new Float32Array(QK8_0);
    for (let b = 0; b < blocks; b++) {
      let amax = 0;
      for (let i = 0; i < QK8_0; i++) {
        const v = bf16ToF32(bits[off + b * QK8_0 + i]);
        block[i] = v;
        if (Math.abs(v) > amax) amax = Math.abs(v);
      }
      const d = amax / 127;
      const inv = d ? 1 / d : 0;
      const p = b * Q8_0_BLOCK_BYTES;
      buf.writeUInt16LE(f32ToF16Bits(d), p);
      for (let i = 0; i < QK8_0; i++) {
        // ggml 用 roundf,半数远离零;JS 的 Math.round 对负数是往 +∞ 取
        const q = block[i] * inv;
        buf.writeInt8(q < 0 ? -Math.round(-q) : Math.round(q), p + 2 + i);
      }
    }
    return buf;
  }
  const width = type === GgmlType.F16 ? 2 : 4;
  const buf = Buffer.allocUnsafe((end - off) * width);
  for (let i = off; i < end; i++) {
    if (type === GgmlType.F16) buf.writeUInt16LE(bf16BitsToF16Bits(bits[i]), (i - off) * 2);
    else buf.writeFloatLE(bf16ToF32(bits[i]), (i - off) * 4);
  }
  return buf;
}

function planFrom(st: SafeTensors, src: string, name: string, type: GgmlType): TensorPlan {
  const e = st.get(src);
  const nelem = e.shape.reduce((a, b) => a * b, 1);
  // q8 块沿 ne[0] 切,也就是 torch 的最后一维(内存里连续的那一维)
  if (type === GgmlType.Q8_0 && e.shape[e.shape.length - 1] % QK8_0 !== 0) {
    throw new Error(`${src} 末维 ${e.shape[e.shape.length - 1]} 不是 ${QK8_0} 的倍数,量化不了`);
  }
  const nbytes =
    type === GgmlType.Q8_0
      ? (nelem / QK8_0) * Q8_0_BLOCK_BYTES
      : nelem * (type === GgmlType.F16 ? 2 : 4);
  return {
    name,
    ne: [...e.shape].reverse(),
    type,
    nbytes,
    write: async (out) => {
      const bits = st.readBits(src);
      for (let off = 0; off < bits.length; off += CHUNK_ELEMS) {
        const end = Math.min(off + CHUNK_ELEMS, bits.length);
        if (!out.write(encodeChunk(bits, off, end, type))) {
          await new Promise<void>((r) => out.once('drain', r));
        }
      }
    },
  };
}

function planRaw(name: string, ne: number[], data: Float32Array): TensorPlan {
  return {
    name,
    ne,
    type: GgmlType.F32,
    nbytes: data.length * 4,
    write: async (out) => {
      const buf = Buffer.allocUnsafe(data.length * 4);
      for (let i = 0; i < data.length; i++) buf.writeFloatLE(data[i], i * 4);
      out.write(buf);
    },
  };
}

/** Whisper 的 SinusoidsPositionEmbedding,行=位置,列=通道 */
function sinusoidPositions(length: number, channels: number): Float32Array {
  const half = channels / 2;
  const logInc = Math.log(10000) / (half - 1);
  const out = new Float32Array(length * channels);
  for (let p = 0; p < length; p++) {
    for (let i = 0; i < half; i++) {
      const t = p * Math.exp(-logInc * i);
      out[p * channels + i] = Math.sin(t);
      out[p * channels + half + i] = Math.cos(t);
    }
  }
  return out;
}

// ─── 词表 ─────────────────────────────────────────────────────────────────

/** llama.cpp 的 llama_token_attr 里用到的几类 */
const TOKEN_NORMAL = 1;
const TOKEN_CONTROL = 3;
const TOKEN_USER_DEFINED = 4;
const TOKEN_UNUSED = 5;

interface Vocab {
  tokens: string[];
  types: number[];
  merges: string[];
}

function buildVocab(tokenizerPath: string, vocabSize: number): Vocab {
  const tk = JSON.parse(readFileSync(tokenizerPath, 'utf8')) as {
    model: { vocab: Record<string, number>; merges: (string | [string, string])[] };
    added_tokens: { id: number; content: string; special: boolean }[];
  };
  const tokens = new Array<string>(vocabSize);
  const types = new Array<number>(vocabSize).fill(TOKEN_UNUSED);
  for (const [tok, id] of Object.entries(tk.model.vocab)) {
    tokens[id] = tok;
    types[id] = TOKEN_NORMAL;
  }
  for (const a of tk.added_tokens) {
    tokens[a.id] = a.content;
    types[a.id] = a.special ? TOKEN_CONTROL : TOKEN_USER_DEFINED;
  }
  // 嵌入矩阵行数比词表多,空出来的位置补占位符,llama.cpp 按 UNUSED 跳过
  for (let i = 0; i < vocabSize; i++) if (tokens[i] === undefined) tokens[i] = `[PAD${i}]`;
  const merges = tk.model.merges.map((m) => (typeof m === 'string' ? m : `${m[0]} ${m[1]}`));
  return { tokens, types, merges };
}

// ─── 主流程 ───────────────────────────────────────────────────────────────

interface AlignerConfig {
  audio_config: {
    d_model: number;
    encoder_ffn_dim: number;
    encoder_layers: number;
    encoder_attention_heads: number;
    num_mel_bins: number;
    output_dim: number;
  };
  text_config: {
    hidden_size: number;
    intermediate_size: number;
    num_hidden_layers: number;
    num_attention_heads: number;
    num_key_value_heads: number;
    head_dim: number;
    rms_norm_eps: number;
    max_position_embeddings: number;
    vocab_size: number;
    rope_parameters: { rope_theta: number };
  };
  timestamp_segment_time: number;
  timestamp_token_id: number;
  audio_token_id: number;
  id2label: Record<string, string>;
}

function lmTensors(st: SafeTensors, cfg: AlignerConfig): TensorPlan[] {
  const p = 'model.language_model.';
  const q = GgmlType.Q8_0;
  const out: TensorPlan[] = [planFrom(st, `${p}embed_tokens.weight`, 'token_embd.weight', q)];
  for (let i = 0; i < cfg.text_config.num_hidden_layers; i++) {
    const s = `${p}layers.${i}.`;
    const d = `blk.${i}.`;
    out.push(
      planFrom(st, `${s}input_layernorm.weight`, `${d}attn_norm.weight`, GgmlType.F32),
      planFrom(st, `${s}self_attn.q_proj.weight`, `${d}attn_q.weight`, q),
      planFrom(st, `${s}self_attn.k_proj.weight`, `${d}attn_k.weight`, q),
      planFrom(st, `${s}self_attn.v_proj.weight`, `${d}attn_v.weight`, q),
      planFrom(st, `${s}self_attn.o_proj.weight`, `${d}attn_output.weight`, q),
      planFrom(st, `${s}self_attn.q_norm.weight`, `${d}attn_q_norm.weight`, GgmlType.F32),
      planFrom(st, `${s}self_attn.k_norm.weight`, `${d}attn_k_norm.weight`, GgmlType.F32),
      planFrom(st, `${s}post_attention_layernorm.weight`, `${d}ffn_norm.weight`, GgmlType.F32),
      planFrom(st, `${s}mlp.gate_proj.weight`, `${d}ffn_gate.weight`, q),
      planFrom(st, `${s}mlp.up_proj.weight`, `${d}ffn_up.weight`, q),
      planFrom(st, `${s}mlp.down_proj.weight`, `${d}ffn_down.weight`, q),
    );
  }
  out.push(planFrom(st, `${p}norm.weight`, 'output_norm.weight', GgmlType.F32));
  return out;
}

function lmKv(cfg: AlignerConfig, vocab: Vocab): Map<string, KvValue> {
  const t = cfg.text_config;
  const kv = new Map<string, KvValue>();
  kv.set('general.architecture', { t: KvType.STRING, v: 'qwen3' });
  kv.set('general.type', { t: KvType.STRING, v: 'model' });
  kv.set('general.name', { t: KvType.STRING, v: 'Qwen3-ForcedAligner-0.6B' });
  kv.set('general.file_type', { t: KvType.UINT32, v: 7 }); // LLAMA_FTYPE_MOSTLY_Q8_0
  kv.set('general.alignment', { t: KvType.UINT32, v: GGUF_ALIGNMENT });
  kv.set('qwen3.block_count', { t: KvType.UINT32, v: t.num_hidden_layers });
  kv.set('qwen3.context_length', { t: KvType.UINT32, v: t.max_position_embeddings });
  kv.set('qwen3.embedding_length', { t: KvType.UINT32, v: t.hidden_size });
  kv.set('qwen3.feed_forward_length', { t: KvType.UINT32, v: t.intermediate_size });
  kv.set('qwen3.attention.head_count', { t: KvType.UINT32, v: t.num_attention_heads });
  kv.set('qwen3.attention.head_count_kv', { t: KvType.UINT32, v: t.num_key_value_heads });
  kv.set('qwen3.attention.key_length', { t: KvType.UINT32, v: t.head_dim });
  kv.set('qwen3.attention.value_length', { t: KvType.UINT32, v: t.head_dim });
  kv.set('qwen3.attention.layer_norm_rms_epsilon', { t: KvType.FLOAT32, v: t.rms_norm_eps });
  kv.set('qwen3.rope.freq_base', { t: KvType.FLOAT32, v: t.rope_parameters.rope_theta });
  kv.set('tokenizer.ggml.model', { t: KvType.STRING, v: 'gpt2' });
  kv.set('tokenizer.ggml.pre', { t: KvType.STRING, v: 'qwen2' });
  kv.set('tokenizer.ggml.tokens', { t: KvType.ARRAY, elem: KvType.STRING, v: vocab.tokens });
  kv.set('tokenizer.ggml.token_type', { t: KvType.ARRAY, elem: KvType.INT32, v: vocab.types });
  kv.set('tokenizer.ggml.merges', { t: KvType.ARRAY, elem: KvType.STRING, v: vocab.merges });
  kv.set('tokenizer.ggml.eos_token_id', { t: KvType.UINT32, v: 151645 });
  kv.set('tokenizer.ggml.padding_token_id', { t: KvType.UINT32, v: 151643 });
  kv.set('tokenizer.ggml.add_bos_token', { t: KvType.BOOL, v: false });
  kv.set('tokenizer.ggml.add_eos_token', { t: KvType.BOOL, v: false });
  return kv;
}

function audioTensors(st: SafeTensors, cfg: AlignerConfig): TensorPlan[] {
  const p = 'model.audio_tower.';
  const a = cfg.audio_config;
  const out: TensorPlan[] = [
    planRaw('a.position_embd.weight', [a.d_model, 1500], sinusoidPositions(1500, a.d_model)),
  ];
  for (const i of [1, 2, 3]) {
    out.push(
      planFrom(st, `${p}conv2d${i}.weight`, `a.conv2d.${i}.weight`, GgmlType.F16),
      planFrom(st, `${p}conv2d${i}.bias`, `a.conv2d.${i}.bias`, GgmlType.F32),
    );
  }
  out.push(planFrom(st, `${p}conv_out.weight`, 'a.conv_out.weight', GgmlType.F16));
  for (let i = 0; i < a.encoder_layers; i++) {
    const s = `${p}layers.${i}.`;
    const d = `a.blk.${i}.`;
    out.push(
      planFrom(st, `${s}self_attn_layer_norm.weight`, `${d}ln1.weight`, GgmlType.F32),
      planFrom(st, `${s}self_attn_layer_norm.bias`, `${d}ln1.bias`, GgmlType.F32),
      planFrom(st, `${s}self_attn.q_proj.weight`, `${d}attn_q.weight`, GgmlType.F16),
      planFrom(st, `${s}self_attn.q_proj.bias`, `${d}attn_q.bias`, GgmlType.F32),
      planFrom(st, `${s}self_attn.k_proj.weight`, `${d}attn_k.weight`, GgmlType.F16),
      planFrom(st, `${s}self_attn.k_proj.bias`, `${d}attn_k.bias`, GgmlType.F32),
      planFrom(st, `${s}self_attn.v_proj.weight`, `${d}attn_v.weight`, GgmlType.F16),
      planFrom(st, `${s}self_attn.v_proj.bias`, `${d}attn_v.bias`, GgmlType.F32),
      planFrom(st, `${s}self_attn.out_proj.weight`, `${d}attn_out.weight`, GgmlType.F16),
      planFrom(st, `${s}self_attn.out_proj.bias`, `${d}attn_out.bias`, GgmlType.F32),
      planFrom(st, `${s}final_layer_norm.weight`, `${d}ln2.weight`, GgmlType.F32),
      planFrom(st, `${s}final_layer_norm.bias`, `${d}ln2.bias`, GgmlType.F32),
      planFrom(st, `${s}fc1.weight`, `${d}ffn_up.weight`, GgmlType.F16),
      planFrom(st, `${s}fc1.bias`, `${d}ffn_up.bias`, GgmlType.F32),
      planFrom(st, `${s}fc2.weight`, `${d}ffn_down.weight`, GgmlType.F16),
      planFrom(st, `${s}fc2.bias`, `${d}ffn_down.bias`, GgmlType.F32),
    );
  }
  out.push(
    planFrom(st, `${p}ln_post.weight`, 'a.post_ln.weight', GgmlType.F32),
    planFrom(st, `${p}ln_post.bias`, 'a.post_ln.bias', GgmlType.F32),
    planFrom(st, 'model.multi_modal_projector.linear_1.weight', 'mm.a.mlp.1.weight', GgmlType.F16),
    planFrom(st, 'model.multi_modal_projector.linear_1.bias', 'mm.a.mlp.1.bias', GgmlType.F32),
    planFrom(st, 'model.multi_modal_projector.linear_2.weight', 'mm.a.mlp.2.weight', GgmlType.F16),
    planFrom(st, 'model.multi_modal_projector.linear_2.bias', 'mm.a.mlp.2.bias', GgmlType.F32),
    planFrom(st, 'score.weight', 'score.weight', GgmlType.F32),
  );
  return out;
}

function audioKv(cfg: AlignerConfig): Map<string, KvValue> {
  const a = cfg.audio_config;
  const kv = new Map<string, KvValue>();
  kv.set('general.architecture', { t: KvType.STRING, v: 'clip' });
  kv.set('general.type', { t: KvType.STRING, v: 'clip-vision-model' });
  kv.set('general.name', { t: KvType.STRING, v: 'Qwen3-ForcedAligner-0.6B audio tower' });
  kv.set('general.file_type', { t: KvType.UINT32, v: 1 });
  kv.set('general.alignment', { t: KvType.UINT32, v: GGUF_ALIGNMENT });
  kv.set('clip.has_audio_encoder', { t: KvType.BOOL, v: true });
  kv.set('clip.has_vision_encoder', { t: KvType.BOOL, v: false });
  kv.set('clip.projector_type', { t: KvType.STRING, v: 'qwen3a' });
  kv.set('clip.audio.embedding_length', { t: KvType.UINT32, v: a.d_model });
  kv.set('clip.audio.feed_forward_length', { t: KvType.UINT32, v: a.encoder_ffn_dim });
  kv.set('clip.audio.block_count', { t: KvType.UINT32, v: a.encoder_layers });
  kv.set('clip.audio.projection_dim', { t: KvType.UINT32, v: a.output_dim });
  kv.set('clip.audio.attention.head_count', { t: KvType.UINT32, v: a.encoder_attention_heads });
  kv.set('clip.audio.attention.layer_norm_epsilon', { t: KvType.FLOAT32, v: 1e-5 });
  kv.set('clip.audio.num_mel_bins', { t: KvType.UINT32, v: a.num_mel_bins });
  // 对齐器自己读的两个数:时间桶宽度(毫秒)与 <timestamp> 的 token id
  kv.set('aligner.timestamp_segment_ms', { t: KvType.UINT32, v: cfg.timestamp_segment_time });
  kv.set('aligner.timestamp_token_id', { t: KvType.UINT32, v: cfg.timestamp_token_id });
  kv.set('aligner.n_buckets', { t: KvType.UINT32, v: Object.keys(cfg.id2label).length });
  return kv;
}

function arg(flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const here = resolve(import.meta.dirname, '..');
  const models = join(here, '..', 'Cortico-Resources', 'models', 'vtuber-tts');
  const src = resolve(arg('--src', join(models, 'aligner')));
  const out = resolve(arg('--out', models));
  mkdirSync(out, { recursive: true });

  const cfg = JSON.parse(readFileSync(join(src, 'config.json'), 'utf8')) as AlignerConfig;
  const st = new SafeTensors(join(src, 'model.safetensors'));
  const vocab = buildVocab(join(src, 'tokenizer.json'), cfg.text_config.vocab_size);

  const jobs: [string, Map<string, KvValue>, TensorPlan[]][] = [
    ['Qwen3-Aligner-LM-Q8_0.gguf', lmKv(cfg, vocab), lmTensors(st, cfg)],
    ['Qwen3-Aligner-Audio-F16.gguf', audioKv(cfg), audioTensors(st, cfg)],
  ];
  for (const [name, kv, tensors] of jobs) {
    const path = join(out, name);
    const t0 = Date.now();
    await writeGguf(path, kv, tensors);
    const mb = (statSync(path).size / 1024 / 1024).toFixed(0);
    console.log(`${basename(path)}  ${tensors.length} 张量  ${mb} MB  ${Date.now() - t0}ms`);
  }
  st.close();
}

await main();
