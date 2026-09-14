/**
 * 真机检查:装运行时、下权重、起 server、打三个端点。联网,要显卡,手动跑。
 *
 *   tsx scripts/check-tts-runtime.ts [--root <部署根>] [--port 8099] [--keep]
 *
 * 默认把运行时与权重装在 `scratch/tts-runtime-check/` 下,不碰真部署。
 * `--keep` 跑完不删 server 进程,便于手工继续打端点。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { ModelStore, MODELS } from '../src/runtime/models.ts';
import { PINNED_RELEASE, defaultBackend, planFor } from '../src/runtime/release.ts';
import { RuntimeStore } from '../src/runtime/store.ts';

const arg = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const root = resolve(arg('--root', join(process.cwd(), 'scratch', 'tts-runtime-check')));
const port = Number(arg('--port', '8099'));
const keep = argv.includes('--keep');

const log = {
  info: (msg: string) => console.log(`  ${msg}`),
  warn: (msg: string) => console.warn(`  ! ${msg}`),
  debug: () => {},
  error: (msg: string) => console.error(`  ! ${msg}`),
  emit: () => {},
} as unknown as ConstructorParameters<typeof RuntimeStore>[1];

function step(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const release = PINNED_RELEASE;
  const plan = planFor(release, defaultBackend());
  if (!plan) throw new Error(`这个平台(${process.platform})没有现成的构建`);

  mkdirSync(root, { recursive: true });
  const runtimes = join(root, 'runtimes');
  const models = join(root, 'models', 'vtuber');

  step(`运行时 ${release} / ${plan.key}`);
  const runtimeStore = new RuntimeStore(runtimes, log);
  const dir = runtimeStore.dir(release, plan);
  if (runtimeStore.installed(dir)) {
    console.log(`  已装: ${dir}`);
  } else {
    await runtimeStore.install(release, plan);
  }
  const serverExe = join(dir, plan.serverExe);
  if (!existsSync(serverExe)) throw new Error(`装完了但没有 ${serverExe}`);
  console.log(`  ${JSON.parse(readFileSync(join(dir, 'cortico-runtime.json'), 'utf8')).installedAt}`);

  step('权重');
  const modelStore = new ModelStore(models, log);
  for (const spec of MODELS) {
    if (modelStore.present(spec.id)) {
      console.log(`  已有 ${spec.file}`);
      continue;
    }
    console.log(`  下载 ${spec.file}(约 ${(spec.approxBytes / 1e9).toFixed(2)} GB)`);
    await modelStore.download(spec.id);
  }

  step(`起 server(:${port})`);
  const proc = spawn(serverExe, [
    '--host', '127.0.0.1', '--port', String(port),
    '--voxcpm2-base-lm', modelStore.path('baseLm'),
    '--voxcpm2-acoustic', modelStore.path('acoustic'),
    '--aligner-lm', modelStore.path('alignerLm'),
    '--aligner-audio', modelStore.path('alignerAudio'),
    '--voxcpm2-n-gpu-layers', '-1', '--aligner-n-gpu-layers', '-1',
  ], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180_000;
  let health: { aligner?: boolean } | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) { health = (await res.json()) as { aligner?: boolean }; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!health) { proc.kill(); throw new Error('health 一直不通'); }
  console.log(`  health: ${JSON.stringify(health)}`);
  if (health.aligner !== true) throw new Error('对齐器没加载');

  step('流式合成');
  const t0 = Date.now();
  const stream = await fetch(`${url}/v1/audio/speech/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'voxcpm2', input: '一二三四五,上山打老虎。', voice: 'default', response_format: 'wav', seed: 42 }),
  });
  if (!stream.ok || !stream.body) throw new Error(`流式合成 ${stream.status}`);
  const reader = stream.body.getReader();
  const parts: Uint8Array[] = [];
  let ttfa: number | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfa === null && value && value.length > 44) ttfa = Date.now() - t0;
    if (value) parts.push(value);
  }
  const wav = Buffer.concat(parts);
  console.log(`  ${wav.length} 字节, 首包 ${ttfa}ms, 总 ${Date.now() - t0}ms`);

  step('对齐');
  const units = [...'一二三四五上山打老虎'];
  const t1 = Date.now();
  const alignRes = await fetch(`${url}/v1/audio/align`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: wav.toString('base64'), units }),
  });
  if (!alignRes.ok) throw new Error(`对齐 ${alignRes.status}: ${(await alignRes.text()).slice(0, 200)}`);
  const aligned = (await alignRes.json()) as { duration: number; units: { text: string; start: number; end: number }[] };
  console.log(`  ${aligned.units.length} 个单元, 时长 ${aligned.duration.toFixed(2)}s, ${Date.now() - t1}ms`);
  for (const u of aligned.units) console.log(`    ${u.start.toFixed(2)}-${u.end.toFixed(2)} ${u.text}`);

  const flat = aligned.units.flatMap((u) => [u.start, u.end]);
  const monotonic = flat.every((v, i) => i === 0 || v >= flat[i - 1] - 1e-9);
  console.log(`  非降: ${monotonic ? '是' : '否(对齐器实现有问题)'}`);

  if (!keep) proc.kill();
  console.log(`\n全部通过。装在 ${root}`);
}

main().catch((error) => {
  console.error(`\n失败: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
});
