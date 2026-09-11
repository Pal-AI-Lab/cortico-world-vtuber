/**
 * L2 流式解析器。
 *
 * 两层:
 * - JsonScriptStream:vtuber_act 的参数是 JSON 片段流,从中增量解出
 *   "script" 字符串的明文(处理转义与跨片段的 \uXXXX)。
 * - ScriptParser:逐字符扫描明文,三种行内记号:
 *   - 【…】阻断指令块:切开前后为两个 TTS 分片,Beat = 指令块 + 其后文本;
 *   - <…> 非阻断标签:不切分片,在当前分片文本里记一个锚点(charOffset),
 *     播放时按标注/估计时间点插入演出;标签原位在正文里化作一个空格;
 *   - […] VoxCPM2 语气词:白名单内的按规范写法透传进 TTS 文本(音频里是一段
 *     真实发声),表外的整块剥离。
 *   正文累计至少 40 个字符后,句末标点串结束即提前吐片送 TTS。
 *   裸半角括号通过超长、跨行和流末三条路径按字面输出。
 */
import type { PerformancePack, TagCommand } from './pack.ts';
import { resolveVoiceTag } from './voice-tags.ts';

/** beat 携带的指令 */
export type BeatCommand = TagCommand;

/** <> 非阻断标签在分片正文里的落点 */
export interface SpeechAnchor {
  /** 剥净标签后的正文里,落点之前的字符数(切子片与估计位置都用它) */
  charOffset: number;
  commands: BeatCommand[];
}

export interface SpeechPiece {
  text: string;
  /** 以省略号收尾(尾停补偿) */
  endsWithEllipsis: boolean;
  /** 片内非阻断锚点,按 charOffset 升序;text 为空时是纯锚点片(不合成) */
  anchors: SpeechAnchor[];
}

/**
 * 行内标签(<> 与 [])的缓冲上限。词表词与语气词都远短于此;超过说明是正文里的
 * 裸括号("3<5"、颜文字),整段按字面输出。【】不设上限,维持旧行为。
 */
const INLINE_TAG_MAX = 32;

/**
 * 自动切片的最小清洗后正文长度。已送入 TTS 的片段无法撤回；短句等待完整收集，长句达到阈值后提前流水化。
 */
const SENTENCE_FLUSH_MIN_CHARS = 40;
/** 句末标点；连续标点与其后的闭引号归入同一片。 */
const SENTENCE_END = /[。！？!?…]/u;
const SENTENCE_TRAILER = /[。！？!?…"'”’」』）》】）)\]]/u;

/**
 * 摘除台本里没命中词表的标记,返回清洗后的台本与摘掉的词。
 *
 * 清理结果用于执行参数；原始调用保留，工具回执说明被忽略的标记。
 *
 * 逐词过词表,一块里一个都没剩就把整块删掉;[] 过语气词白名单,表外整块删掉。
 * 行内标记的匹配跟着解析器的保险走:不跨行、内容不超过 INLINE_TAG_MAX,否则正文里
 * 的裸括号("3<5"、颜文字)会被误解析为标记。
 */
export function stripUnknownTags(script: string, pack: PerformancePack): { script: string; dropped: string[] } {
  const dropped: string[] = [];
  const re = new RegExp(
    `【([^】【]*)】|<([^>\\n]{0,${INLINE_TAG_MAX}})>|\\[([^\\]\\n]{0,${INLINE_TAG_MAX}})\\]`,
    'g',
  );
  const cleaned = script.replace(re, (_whole, block?: string, inline?: string, voice?: string) => {
    if (voice !== undefined) {
      const tag = resolveVoiceTag(voice);
      if (tag) return `[${tag}]`;
      dropped.push(`[${voice}]`);
      return '';
    }
    const inner = block ?? inline ?? '';
    const kept: string[] = [];
    for (const raw of inner.split(/[,，、]/)) {
      const word = raw.trim();
      if (!word) continue;
      if (pack.resolveTag(word)) kept.push(word);
      else dropped.push(word);
    }
    if (kept.length === 0) return '';
    return block !== undefined ? `【${kept.join(',')}】` : `<${kept.join(',')}>`;
  });
  return { script: cleaned, dropped };
}

export interface Beat {
  index: number;
  commands: BeatCommand[];
  /** 指令块出现在行首(其前文以换行收尾,boundary_base 取换行档) */
  atLineStart: boolean;
  /** 指令块独占一行(其后紧跟换行):演出先行,speech_onset 不打折 */
  aloneOnLine: boolean;
}

export interface ParserSink {
  /** beat 开始,标签已解析(文本随后经 onSpeech 到达) */
  onBeat(beat: Beat): void;
  /** beat 内新切出一个语音片(可立即送 TTS 预合成) */
  onSpeech(beatIndex: number, piece: SpeechPiece): void;
  /** 流关闭时完成 script 解析并输出剩余文本。 */
  onEnd(): void;
}

/** 明文脚本 → beat/speech 事件流 */
export class ScriptParser {
  private beatIndex = -1;
  private beatOpen = false;
  /** 增量清洗后的正文(空白已折叠、开头省略号已剥),锚点 charOffset 以它计 */
  private speechBuf = '';
  private pendingAnchors: SpeechAnchor[] = [];
  private tagBuf: string | null = null;
  /** <> 缓冲及原始开括号,供字面输出时还原全角或半角。 */
  private angleBuf: string | null = null;
  private angleOpenCh = '<';
  /** [] 缓冲(VoxCPM2 语气词) */
  private squareBuf: string | null = null;
  /** 上一个输出字符是否为换行,用于计算下一指令块的 atLineStart。 */
  private lastWasNewline = true;
  /** 当前 beat 的指令块后是否还没出现过非空白文本 */
  private noTextSinceTag = false;
  private pendingBeat: Beat | null = null;
  /** 已达到自动切片门槛,等待句末标点串与闭引号收完。 */
  private sentenceFlushPending = false;

  constructor(
    private readonly sink: ParserSink,
    private readonly pack: PerformancePack,
  ) {}

  feed(text: string): void {
    for (const ch of text) this.feedChar(ch);
  }

  end(): void {
    // 流末丢弃残缺【】;半开的 < 与 [ 按字面输出。
    this.tagBuf = null;
    this.spillAngle();
    this.spillSquare();
    this.flushSpeech();
    // 收尾的孤立标签:没有后续文本,按"演出先行"处理
    if (this.pendingBeat && this.noTextSinceTag) this.pendingBeat.aloneOnLine = true;
    this.emitPendingBeat();
    this.sink.onEnd();
  }

  private feedChar(ch: string): void {
    if (this.sentenceFlushPending && !SENTENCE_TRAILER.test(ch)) this.flushSpeech();
    if (this.tagBuf !== null) {
      if (ch === '】') {
        const inner = this.tagBuf;
        this.tagBuf = null;
        this.openBeat(inner);
      } else if (ch === '【') {
        // 上一块没闭合:丢弃,以本字符重开
        this.tagBuf = '';
      } else {
        this.tagBuf += ch;
      }
      return;
    }
    if (this.angleBuf !== null) {
      if (ch === '>' || ch === '＞') {
        const inner = this.angleBuf;
        this.angleBuf = null;
        this.closeAnchor(inner);
      } else if (ch === '<' || ch === '＜') {
        this.spillAngle();
        this.angleBuf = '';
        this.angleOpenCh = ch;
      } else if (ch === '\n' || ch === '【' || this.angleBuf.length >= INLINE_TAG_MAX) {
        this.spillAngle();
        this.feedChar(ch);
      } else {
        this.angleBuf += ch;
      }
      return;
    }
    if (this.squareBuf !== null) {
      if (ch === ']') {
        const inner = this.squareBuf;
        this.squareBuf = null;
        const tag = resolveVoiceTag(inner);
        // 白名单语气词按规范写法进正文;表外整块剥离
        if (tag) for (const c of `[${tag}]`) this.emitText(c);
      } else if (ch === '[') {
        this.spillSquare();
        this.squareBuf = '';
      } else if (ch === '\n' || ch === '【' || this.squareBuf.length >= INLINE_TAG_MAX) {
        this.spillSquare();
        this.feedChar(ch);
      } else {
        this.squareBuf += ch;
      }
      return;
    }
    if (ch === '【') {
      this.flushSpeech();
      this.tagBuf = '';
      return;
    }
    if (ch === '<' || ch === '＜') {
      this.angleBuf = '';
      this.angleOpenCh = ch;
      return;
    }
    if (ch === '[') {
      this.squareBuf = '';
      return;
    }
    this.emitText(ch);
  }

  /** 正文字符:pending beat 出闸 + 增量清洗入缓冲 */
  private emitText(ch: string): void {
    if (this.pendingBeat && this.noTextSinceTag) {
      if (ch === '\n') {
        this.pendingBeat.aloneOnLine = true;
        this.emitPendingBeat();
        this.lastWasNewline = true;
        return;
      }
      if (!/\s/.test(ch)) {
        this.emitPendingBeat();
      }
    }
    this.appendClean(ch);
    if (this.speechBuf.length >= SENTENCE_FLUSH_MIN_CHARS && SENTENCE_END.test(ch)) {
      this.sentenceFlushPending = true;
    }
    this.lastWasNewline = ch === '\n';
  }

  /** 与旧的 flush 期正则(\s+→空格、剥开头 […\s]+)等价,但增量进行以便锚点定位 */
  private appendClean(ch: string): void {
    if (/\s/.test(ch)) {
      if (this.speechBuf && !this.speechBuf.endsWith(' ')) this.speechBuf += ' ';
      return;
    }
    if (this.speechBuf === '' && ch === '…') return;
    this.speechBuf += ch;
  }

  /** 将半开的 <> 作为正文输出。 */
  private spillAngle(): void {
    if (this.angleBuf === null) return;
    const buf = this.angleBuf;
    this.angleBuf = null;
    for (const c of this.angleOpenCh + buf) this.emitText(c);
  }

  /** 将半开的 [] 作为正文输出。 */
  private spillSquare(): void {
    if (this.squareBuf === null) return;
    const buf = this.squareBuf;
    this.squareBuf = null;
    for (const c of '[' + buf) this.emitText(c);
  }

  /**
   * <> 闭合:词表词记为当前位置的非阻断锚点;全未知则不留锚点。
   * 标签本身在正文里化作一个空格——模型习惯把 <> 放在句界当分隔符,
   * 摘除后无痕拼接会让 TTS 连读;一个空格换一丝自然的间隙(与前后空白折叠)。
   */
  private closeAnchor(inner: string): void {
    const commands: BeatCommand[] = [];
    for (const w of inner.split(/[,，、]/)) {
      const cmd = this.pack.resolveTag(w);
      if (!cmd) continue;
      commands.push(cmd);
    }
    if (commands.length > 0) {
      this.pendingAnchors.push({ charOffset: this.speechBuf.length, commands });
    }
    this.appendClean(' ');
  }

  /** 指令块闭合:解析词、开新 beat */
  private openBeat(inner: string): void {
    const words = inner.split(/[,，、]/);
    const commands: BeatCommand[] = [];
    for (const w of words) {
      const cmd = this.pack.resolveTag(w);
      if (!cmd) continue; // 未知标签静默丢弃
      commands.push(cmd);
    }
    this.beatIndex++;
    this.pendingBeat = {
      index: this.beatIndex,
      commands,
      atLineStart: this.lastWasNewline,
      aloneOnLine: false,
    };
    this.noTextSinceTag = true;
    this.lastWasNewline = false;
    this.beatOpen = true;
  }

  private emitPendingBeat(): void {
    if (!this.pendingBeat) return;
    const b = this.pendingBeat;
    this.pendingBeat = null;
    this.noTextSinceTag = false;
    this.sink.onBeat(b);
  }

  /** 标签边界、达标句末或流末:把当前缓冲吐成一片 TTS(可为只带锚点的空文本片) */
  private flushSpeech(): void {
    const text = this.speechBuf.replace(/ +$/, '');
    const anchors = this.pendingAnchors;
    this.speechBuf = '';
    this.pendingAnchors = [];
    this.sentenceFlushPending = false;
    if (!text && anchors.length === 0) return;
    for (const a of anchors) a.charOffset = Math.min(a.charOffset, text.length);
    // 脚本以文本开头(第一个指令块之前):补一个无标签 beat
    if (!this.beatOpen) {
      this.beatIndex++;
      this.beatOpen = true;
      this.sink.onBeat({ index: this.beatIndex, commands: [], atLineStart: true, aloneOnLine: false });
    }
    this.emitPendingBeat();
    this.sink.onSpeech(this.beatIndex, {
      text,
      endsWithEllipsis: /(……|…|\.\.\.)$/.test(text),
      anchors,
    });
  }
}

/** Incrementally extracts the first `script` string from fragmented `vtuber_act` arguments. */
export class JsonScriptStream {
  private phase:
    | 'seek-root' | 'seek-key' | 'in-key' | 'seek-colon' | 'seek-value'
    | 'skip-string' | 'skip-composite' | 'skip-primitive' | 'seek-separator'
    | 'in-string' | 'done' = 'seek-root';
  private keyRaw = '';
  private keyEscaped = false;
  private currentKey = '';
  private skipDepth = 0;
  private skipInString = false;
  private skipEscaped = false;
  private escapeBuf: string | null = null;

  constructor(private readonly onText: (text: string) => void) {}

  feed(fragment: string): void {
    if (this.phase === 'done') return;
    if (this.phase === 'in-string') this.decodeString(fragment);
    else this.scanHeader(fragment);
  }

  /** 流结束:半截转义序列丢弃 */
  end(): void {
    this.phase = 'done';
  }

  /** 只认顶层对象的 script 键；其他值按 JSON 词法跳过，不把嵌套同名键送去 TTS。 */
  private scanHeader(fragment: string): void {
    for (let i = 0; i < fragment.length && this.phase !== 'done'; i++) {
      const ch = fragment[i];
      if (this.phase === 'seek-root') {
        if (/\s/.test(ch)) continue;
        this.phase = ch === '{' ? 'seek-key' : 'done';
        continue;
      }
      if (this.phase === 'seek-key') {
        if (/\s/.test(ch)) continue;
        if (ch === '}') { this.phase = 'done'; continue; }
        if (ch !== '"') { this.phase = 'done'; continue; }
        this.keyRaw = '';
        this.keyEscaped = false;
        this.phase = 'in-key';
        continue;
      }
      if (this.phase === 'in-key') {
        if (this.keyEscaped) {
          this.keyRaw += ch;
          this.keyEscaped = false;
        } else if (ch === '\\') {
          this.keyRaw += ch;
          this.keyEscaped = true;
        } else if (ch === '"') {
          try {
            this.currentKey = JSON.parse(`"${this.keyRaw}"`) as string;
            this.phase = 'seek-colon';
          } catch {
            this.phase = 'done';
          }
        } else {
          this.keyRaw += ch;
        }
        continue;
      }
      if (this.phase === 'seek-colon') {
        if (/\s/.test(ch)) continue;
        this.phase = ch === ':' ? 'seek-value' : 'done';
        continue;
      }
      if (this.phase === 'seek-value') {
        if (/\s/.test(ch)) continue;
        if (this.currentKey === 'script') {
          if (ch !== '"') { this.phase = 'done'; continue; }
          this.phase = 'in-string';
          const rest = fragment.slice(i + 1);
          if (rest) this.decodeString(rest);
          return;
        }
        if (ch === '"') {
          this.skipEscaped = false;
          this.phase = 'skip-string';
        } else if (ch === '{' || ch === '[') {
          this.skipDepth = 1;
          this.skipInString = false;
          this.skipEscaped = false;
          this.phase = 'skip-composite';
        } else if (ch === ',' || ch === '}') {
          this.phase = 'done';
        } else {
          this.phase = 'skip-primitive';
        }
        continue;
      }
      if (this.phase === 'skip-string') {
        if (this.skipEscaped) this.skipEscaped = false;
        else if (ch === '\\') this.skipEscaped = true;
        else if (ch === '"') this.phase = 'seek-separator';
        continue;
      }
      if (this.phase === 'skip-composite') {
        if (this.skipInString) {
          if (this.skipEscaped) this.skipEscaped = false;
          else if (ch === '\\') this.skipEscaped = true;
          else if (ch === '"') this.skipInString = false;
        } else if (ch === '"') {
          this.skipInString = true;
        } else if (ch === '{' || ch === '[') {
          this.skipDepth++;
        } else if (ch === '}' || ch === ']') {
          this.skipDepth--;
          if (this.skipDepth === 0) this.phase = 'seek-separator';
        }
        continue;
      }
      if (this.phase === 'skip-primitive') {
        if (ch === ',') this.phase = 'seek-key';
        else if (ch === '}') this.phase = 'done';
        continue;
      }
      if (this.phase === 'seek-separator') {
        if (/\s/.test(ch)) continue;
        if (ch === ',') this.phase = 'seek-key';
        else this.phase = 'done';
      }
    }
  }

  private decodeString(fragment: string): void {
    let out = '';
    let i = 0;
    // 接上一片段没凑齐的转义序列
    if (this.escapeBuf !== null) {
      const need = this.escapeBuf.startsWith('u') ? 5 - this.escapeBuf.length : 1;
      const take = fragment.slice(0, need);
      this.escapeBuf += take;
      i = take.length;
      const done = this.tryFinishEscape();
      if (done === null) {
        if (i < fragment.length) return; // 不可能:凑齐了但没解出,丢弃
        if (this.escapeBuf !== null) return; // 还没凑齐,等下一片段
      } else {
        out += done;
      }
    }
    for (; i < fragment.length; i++) {
      const ch = fragment[i];
      if (this.escapeBuf !== null) {
        this.escapeBuf += ch;
        const done = this.tryFinishEscape();
        if (done !== null) out += done;
        continue;
      }
      if (ch === '\\') {
        this.escapeBuf = '';
        continue;
      }
      if (ch === '"') {
        this.phase = 'done';
        break;
      }
      out += ch;
    }
    if (out) this.onText(out);
  }

  /** escapeBuf 凑齐则解码并清空;没凑齐返回 null */
  private tryFinishEscape(): string | null {
    const buf = this.escapeBuf;
    if (buf === null || buf.length === 0) return null;
    const head = buf[0];
    if (head === 'u') {
      if (buf.length < 5) return null;
      this.escapeBuf = null;
      const code = Number.parseInt(buf.slice(1, 5), 16);
      return Number.isNaN(code) ? '' : String.fromCharCode(code);
    }
    this.escapeBuf = null;
    switch (head) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      default: return head; // \" \\ \/ 与未知转义:字面
    }
  }
}
