/**
 * 接线自检:逐个注入演出包声明的参数,读回 Live2D 输出参数,量出实际接到了哪、斜率多少。
 *
 * `InputParameterListRequest` 只报告模型接受的输入参数,不提供输入到输出的映射。
 * 自检以已知输入量的输出响应判定接线;无响应表示接线未生效。
 *
 * 测量排除两类非接线响应:
 * 1. **物理余振**:头发/兽耳/翅膀的物理在任何头部运动后会晃好几秒,读回时几十
 *    个参数都在动。靠幅度阈值筛掉。
 * 2. **自走参数**:呼吸(UseBreathing)和 idle 动画驱动的参数与注入无关地一直
 *    在变,固定基线会把它们算成响应。靠**两档幅度**筛:真接线的响应与注入量
 *    成正比(半幅进去、半幅出来),自走的不成比例。
 */
import type { VtsClient } from '../vts-client.ts';
import type { PerformancePack } from '../pack.ts';

/** 探针幅度:包里没写 probe 时取量程最大绝对值的 2/3,离钳位边界留余量 */
function probeAmplitude(range: readonly [number, number], probe: number | undefined): number {
  if (probe !== undefined) return probe;
  return Math.round(Math.max(Math.abs(range[0]), Math.abs(range[1])) * (2 / 3) * 100) / 100;
}

/** 物理余振在 0.05 以下;真接线的响应是 1~3 量级 */
const MOVE_THRESHOLD = 0.05;
/** 半幅响应与全幅一半的相对偏差容许量 */
const PROPORTIONALITY_TOLERANCE = 0.35;
/**
 * 相对强度筛选保留最强响应 8% 以上的参数。
 * 该阈值排除可越过绝对门限的物理联动,同时保留一对多接线中的弱输出。
 */
const RELATIVE_FLOOR = 0.08;
/** 全零基线下变化超过此值的参数视为自由运行。 */
const VOLATILE_EPSILON = 0.02;
/** 取样窗口覆盖呼吸与 idle 动画周期所需的样本数。 */
const VOLATILITY_SAMPLES = 4;
/** 每档保持多久再读:够 VTS 最大平滑(50)走完 */
const SETTLE_MS = 1200;
const INJECT_HZ_MS = 33;

export interface WiringHit {
  /** 跟着动的 Live2D 输出参数 */
  param: string;
  /** 注入 1 单位输入量 → 输出变化多少 */
  gain: number;
  /** 输入为 0 时该输出参数停在哪(中性位换算要用) */
  atZero: number;
}

export interface WiringRow {
  id: string;
  status: 'bound' | 'dead' | 'no-input';
  /** 按响应幅度降序 */
  hits: WiringHit[];
  /** 缺了会失去什么(取自演出包的参数声明) */
  losesIfMissing: string;
}

export interface WiringReport {
  vtsModelName: string;
  rows: WiringRow[];
  /** VTS 压根不认识的输入参数名:注入它们会让整条注入请求被拒(453) */
  unknownInputs: string[];
  /** 接线断开的参数 —— 这些就是该写进档案 unsupported/aliasTo 的 */
  dead: string[];
  startedAt: string;
  elapsedMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 自检期间必须暂停 L4 发帧，否则混音台数据会覆盖探针。 */
export async function runWiringSelfCheck(
  vts: VtsClient,
  pack: PerformancePack,
  opts: { onProgress?: (done: number, total: number, id: string) => void } = {},
): Promise<WiringReport> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const model = await vts.currentModel();
  const known = await vts.inputParameterNames();

  const probes = Object.entries(pack.params).map(([id, spec]) => ({
    id,
    amp: probeAmplitude(spec.range, spec.probe),
    loses: spec.losesIfMissing ?? '',
  }));
  const usable = probes.filter((p) => known.has(p.id));
  const unknownInputs = probes.filter((p) => !known.has(p.id)).map((p) => p.id);

  /** 持续注入一组值直到 stop() */
  const holdWhile = (values: Array<{ id: string; value: number }>): (() => void) => {
    const send = (): void => {
      void vts.injectParameters(values.map((v) => ({ ...v, weight: 1 })), 'set').catch(() => {});
    };
    send();
    const timer = setInterval(send, INJECT_HZ_MS);
    return () => clearInterval(timer);
  };

  const readOut = async (): Promise<Map<string, number>> => {
    const list = await vts.live2dParameters();
    return new Map(list.map((p) => [p.name, p.value]));
  };

  const settleAt = async (probeId: string | null, amp: number): Promise<Map<string, number>> => {
    const values = usable.map((p) => ({ id: p.id, value: p.id === probeId ? amp : 0 }));
    const stop = holdWhile(values);
    await sleep(SETTLE_MS);
    const out = await readOut();
    stop();
    return out;
  };

  /*
   * 先识别由呼吸或 idle 动画驱动的自由运行参数。
   * 全零输入下仍变化的参数不计为探针响应,防止建立无关映射。
   */
  const freeRunning = new Set<string>();
  {
    const zeros = usable.map((p) => ({ id: p.id, value: 0 }));
    const stop = holdWhile(zeros);
    const samples: Array<Map<string, number>> = [];
    for (let i = 0; i < VOLATILITY_SAMPLES; i++) {
      await sleep(SETTLE_MS);
      samples.push(await readOut());
    }
    stop();
    for (const name of samples[0].keys()) {
      const vals = samples.map((s) => s.get(name) ?? 0);
      if (Math.max(...vals) - Math.min(...vals) > VOLATILE_EPSILON) freeRunning.add(name);
    }
  }

  const rows: WiringRow[] = [];
  for (const [i, probe] of probes.entries()) {
    opts.onProgress?.(i, probes.length, probe.id);
    if (!known.has(probe.id)) {
      rows.push({ id: probe.id, status: 'no-input', hits: [], losesIfMissing: probe.loses });
      continue;
    }
    // 基线每轮重取:呼吸是时变的,共用一个基线会把它算成响应
    const base = await settleAt(null, 0);
    const full = await settleAt(probe.id, probe.amp);
    const half = await settleAt(probe.id, probe.amp / 2);

    const hits: WiringHit[] = [];
    for (const [name, v] of full) {
      if (freeRunning.has(name)) continue;
      const b = base.get(name) ?? 0;
      const d1 = v - b;
      if (Math.abs(d1) < MOVE_THRESHOLD) continue;
      const d2 = (half.get(name) ?? 0) - b;
      // 正比筛:真接线的半幅响应是全幅的一半
      if (Math.abs(d1 - 2 * d2) > PROPORTIONALITY_TOLERANCE * Math.abs(d1)) continue;
      hits.push({ param: name, gain: d1 / probe.amp, atZero: b });
    }
    hits.sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain));
    // 物理余振比有效接线响应低两个数量级;按相对强度过滤。
    const top = hits.length > 0 ? Math.abs(hits[0].gain) : 0;
    const strong = hits.filter((x) => Math.abs(x.gain) >= top * RELATIVE_FLOOR);
    rows.push({
      id: probe.id,
      status: strong.length > 0 ? 'bound' : 'dead',
      hits: strong.slice(0, 5),
      losesIfMissing: probe.loses,
    });
  }
  opts.onProgress?.(probes.length, probes.length, '');

  // 探测结束后将所有参数复位为零。
  const stop = holdWhile(usable.map((p) => ({ id: p.id, value: 0 })));
  await sleep(200);
  stop();

  return {
    vtsModelName: model?.name ?? '',
    rows,
    unknownInputs,
    dead: rows.filter((r) => r.status === 'dead').map((r) => r.id),
    startedAt,
    elapsedMs: Date.now() - t0,
  };
}

/** 控制台与日志共用的接线报告文本格式。 */
export function formatWiringReport(r: WiringReport): string {
  const lines: string[] = [
    `模型「${r.vtsModelName || '(未加载)'}」接线自检 · ${(r.elapsedMs / 1000).toFixed(1)}s`,
  ];
  for (const row of r.rows) {
    if (row.status === 'no-input') {
      lines.push(`  ✗ ${row.id.padEnd(13)} VTS 无此输入参数`);
    } else if (row.status === 'dead') {
      lines.push(`  ✗ ${row.id.padEnd(13)} 接线断开(注入零响应)—— 失去:${row.losesIfMissing}`);
    } else {
      const h = row.hits.map((x) => `${x.param} ×${x.gain.toFixed(3)}${x.atZero ? ` @0=${x.atZero.toFixed(2)}` : ''}`);
      lines.push(`  ✓ ${row.id.padEnd(13)} ${h.join('  ')}`);
    }
  }
  if (r.dead.length > 0) {
    lines.push(`断开 ${r.dead.length} 项:${r.dead.join('、')} —— 写进模型档案的 unsupported 或 aliasTo`);
  }
  return lines.join('\n');
}
