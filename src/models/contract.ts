/**
 * L4 模型档案将演出包的语义参数换算为模型输入量;上层语义不随模型变化。
 * 档案是模型目录里的 `cortico.profile.json`(见 `registry.ts`),编写规则见
 * `LIVE2D-ADAPTATION.md`。参数集由演出包声明(`params.json`),档案只对
 * 包里有的参数换算。VTS API 不返回 `ParameterSettings`,因此接受注入不能
 * 证明输入已连接到 Live2D 参数。不支持的参数在 L4 丢弃并报告,上层词表保持不变。
 */

/**
 * 语义值按 `clamp(neutral + value × scale, lo, hi)` 换算为实机输入量。
 * `aliasTo` 指定目标输入;多路语义映射到同一输入时取均值。
 */
export interface ParamWiring {
  /** 缺省 0 */
  neutral?: number;
  /** 缺省 1 */
  scale?: number;
  /** 缺省不钳 */
  clamp?: readonly [number, number];
  /** 模型把这一轴反向接线时置 true */
  invert?: boolean;
  /** 改发到这些输入参数;多路并一路时取均值 */
  aliasTo?: readonly string[];
}

/** 一个 FX 标签在本模型上的实现:表情文件 + 自动关闭时长。 */
export interface FxEntry {
  file: string;
  durationMs: number;
}

export interface ModelProfile {
  /** 档案 id,也是配置 `worlds.vtuber.modelProfile` 的取值 */
  id: string;
  /** 控制台显示名 */
  label: string;
  /** 渲染后端。当前只有 VTube Studio。 */
  backend: 'vts';
  /**
   * VTS 侧的模型名(`CurrentModelRequest.modelName`,即 `.vtube.json` 的 `Name`)。
   * `auto` 定档按它匹配;空串表示不参与自动匹配,仅供默认档案使用。
   */
  vtsModelName: string;
  /** 逐参数换算;未列出的参数原样直发 */
  wiring: Readonly<Record<string, ParamWiring>>;
  /** 这个模型演不出来的语义参数:注入前丢弃,并提醒一次 */
  unsupported: readonly string[];
  /**
   * FX 标签 id(演出包 fx 通道的 clipId)→ 实现。null 或未列出 = 这个模型没有
   * 这个特效(丢弃并提醒一次)。
   */
  fx: Readonly<Record<string, FxEntry | null>>;
  /** 启动复位时要保留的表情文件(装扮类,不是反应残留) */
  keepExpressions: readonly string[];
  /**
   * 模型自带的 idle 动画会不会眨眼。false 时 L3 在空闲期写入中性眼睑并排眨眼;
   * 注入期间 idle 动画不再拥有眼睑参数。
   */
  idleBlinks: boolean;
  /** 给控制台看的一句话:这个模型有什么已知的表现力缺口 */
  caveat?: string;
}

/**
 * 默认档案:没有匹配到任何模型时使用。
 *
 * 换算取 Live2D 标准接线的通行值:嘴角/眉毛/眼睑三类的映射中性在输入半程
 * (in[0,1] → out[-1,1] 或 [0,2]),这是 Cubism 模板的默认接法。眼球横轴取反:
 * VTS 摄像头追踪的 `EyeRightX` 是镜像空间的量,模型作者通常反向映射回 `ParamEyeBallX`。
 * 没有任何 FX:未识别的模型不能拿别家的表情文件名去开。
 */
export const DEFAULT_PROFILE: ModelProfile = {
  id: 'VTS-Default',
  label: '通用(未识别的模型)',
  backend: 'vts',
  vtsModelName: '',
  wiring: {
    MouthSmile: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    BrowLeftY: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    BrowRightY: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    EyeOpenLeft: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    EyeOpenRight: { neutral: 0.5, scale: 0.5, clamp: [0, 1] },
    EyeLeftX: { invert: true },
    EyeRightX: { invert: true },
  },
  unsupported: [],
  fx: {},
  keepExpressions: [],
  idleBlinks: false,
  caveat: '按 Live2D 标准接线猜的换算,没有特效。按 LIVE2D-ADAPTATION.md 给这个模型写一份档案。',
};

/** 语义值 → 实机输入量。返回 null 表示这个参数在本模型上不可达。 */
export function toWire(
  profile: ModelProfile,
  id: string,
  value: number,
): { targets: readonly string[]; value: number } | null {
  if (profile.unsupported.includes(id)) return null;
  const w = profile.wiring[id];
  if (!w) return { targets: [id], value };
  const neutral = w.neutral ?? 0;
  const scale = w.scale ?? 1;
  const signed = w.invert ? -value : value;
  let out = neutral + signed * scale;
  if (w.clamp) out = Math.min(w.clamp[1], Math.max(w.clamp[0], out));
  return { targets: w.aliasTo ?? [id], value: out };
}

/** FX 标签在本模型上的实现;null = 没有这个特效 */
export function fxFor(profile: ModelProfile, clipId: string): FxEntry | null {
  return profile.fx[clipId] ?? null;
}
