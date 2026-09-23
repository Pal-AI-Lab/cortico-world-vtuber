/**
 * 对一条 OpenAI 兼容 Speech 服务跑一遍真实接入检查,验证 R2/R4:外部服务不装
 * VoxCPM 运行时、不下载权重、不提供参考音频也能走完真实合成链路。
 *
 *   corepack pnpm tsx scripts/check-openai-tts.ts <baseUrl> --model=<模型名> --voice=<声音名>
 *     [--format=wav] [--pcm-rate=24000] [--pcm-channels=1] [--text=<文本>]
 *
 * 地址、模型与声音都要操作者给:它们是一条具体服务的部署事实,不写进仓库。
 * 要联网、会真的调用那条服务,所以不进自动化测试:自动测试用假 HTTP 服务
 * (见 tests/vtuber/tts-openai.test.ts)。
 *
 * 三趟都跑:非流式 wav、非流式 pcm、增量 pcm。任何一趟失败即非零退出。
 */
import { TtsServiceResolver } from '../src/tts/registry.ts';
import { decodeWav, type DecodedWav } from '../src/tts/audio.ts';
import type { TtsServiceConfig, TtsRegistryRead } from '../src/tts/config.ts';
import type { TtsPiece } from '../src/tts/types.ts';

const USAGE = `用法:tsx scripts/check-openai-tts.ts <baseUrl> --model=<模型名> --voice=<声音名>
  [--format=wav|pcm] [--pcm-rate=24000] [--pcm-channels=1|2] [--text=<文本>]`;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));
const baseUrl = (positional ?? process.env.VTUBER_TTS_BASE_URL ?? '').replace(/\/+$/, '');
const model = arg('model') ?? process.env.VTUBER_TTS_MODEL ?? '';
const voice = arg('voice') ?? process.env.VTUBER_TTS_VOICE ?? '';
if (!baseUrl) fail('缺少 Base URL(API 前缀,通常以 /v1 结尾)。');
if (!model) fail('缺少 --model。');
if (!voice) fail('缺少 --voice。');
const text = arg('text') ?? '这是一句用来检查接入链路的测试文本。';
/** raw PCM 的约定;OpenAI 官方是 24kHz 单声道 16 位小端,自部署服务按它自己的填。 */
const PCM = {
  sampleRate: Number(arg('pcm-rate') ?? 24_000),
  channels: (arg('pcm-channels') === '2' ? 2 : 1) as 1 | 2,
  encoding: 's16le' as const,
};

function service(overrides: Partial<TtsServiceConfig> = {}): TtsServiceConfig {
  return {
    id: 'smoke',
    name: `${model}/${voice}`,
    protocol: 'openai-speech',
    management: 'external',
    baseUrl,
    auth: { type: 'none' },
    model,
    voice,
    responseFormat: 'wav',
    delivery: 'auto',
    timeoutMs: 60_000,
    ...overrides,
  };
}

function resolverFor(svc: TtsServiceConfig): TtsServiceResolver {
  const registry = { version: 1, revision: 1, activeServiceId: svc.id, services: [svc] };
  const read = (): TtsRegistryRead => ({ ok: true, registry, virtual: false, notes: [] });
  return new TtsServiceResolver({ read, secrets: () => ({}) });
}

function describeAudio(decoded: DecodedWav): string {
  let peak = 0;
  for (const s of decoded.samples) peak = Math.max(peak, Math.abs(s));
  return `${Math.round(decoded.durationMs)}ms @${decoded.sampleRate}Hz 峰值 ${peak.toFixed(3)}`;
}

async function nonStreaming(label: string, svc: TtsServiceConfig): Promise<TtsPiece> {
  const t0 = Date.now();
  const resolver = resolverFor(svc);
  const piece = await resolver.adapterFor(resolver.snapshot()).synth(text);
  const decoded = decodeWav(piece.wav);
  console.log(`  ✓ ${label}:${Date.now() - t0}ms 往返,${describeAudio(decoded)},wav ${piece.wav.length} 字节`);
  if (decoded.durationMs <= 0) throw new Error(`${label} 拿到 0 时长音频`);
  return piece;
}

async function streaming(label: string, svc: TtsServiceConfig): Promise<void> {
  const resolver = resolverFor(svc);
  const adapter = resolver.adapterFor(resolver.snapshot());
  if (!adapter.synthStream) throw new Error(`${label}:这条配置不支持增量合成`);
  let chunks = 0;
  let bytes = 0;
  const t0 = Date.now();
  const piece = await adapter.synthStream(text, {
    begin: ({ sampleRate }) => {
      process.stdout.write(`  · ${label}:首块 ${Date.now() - t0}ms,采样率 ${sampleRate}Hz;`);
    },
    pcm: (chunk) => {
      chunks++;
      bytes += chunk.length;
    },
  }, { signal: new AbortController().signal });
  const decoded = decodeWav(piece.wav);
  console.log(
    `  ✓ ${label}:${Date.now() - t0}ms 收流,${chunks} 块 / ${bytes} 字节,${describeAudio(decoded)}`
    + `${piece.truncated ? '(被掐流)' : ''}`,
  );
  if (chunks === 0 || bytes === 0) throw new Error(`${label} 没有收到任何 PCM`);
  if (decoded.durationMs <= 0) throw new Error(`${label} 拿到 0 时长音频`);
}

console.log(`TTS 接入检查\n  服务:${baseUrl}\n  模型:${model}  声音:${voice}\n  文本:${text}\n`);

const failures: string[] = [];
const runs: Array<[string, () => Promise<unknown>]> = [
  ['非流式 wav', () => nonStreaming('wav', service())],
  ['非流式 pcm', () => nonStreaming('pcm', service({ responseFormat: 'pcm', pcm: { ...PCM } }))],
  ['增量 pcm(delivery=auto)', () => streaming('pcm', service({ responseFormat: 'pcm', pcm: { ...PCM } }))],
];

for (const [label, run] of runs) {
  try {
    await run();
  } catch (err) {
    failures.push(label);
    console.error(`  ✗ ${label}:${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项:${failures.join('、')}`);
  process.exit(1);
}
console.log('三趟都通过:外部服务无需 VoxCPM 运行时、权重或参考音频即可完成真实合成。');
