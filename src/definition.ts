import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IOModuleDefinition } from 'cortico/modules.ts';
import {
  OVERLAY_CONFIG_DEFAULTS,
  TTS_PROFILE_DEFAULTS,
  VTUBER_MODULE_DEFAULTS,
  VTUBER_MODULE_SECRET,
  type OverlayConfig,
  type TtsProfile,
} from './module.ts';
import { VtuberModuleProxy } from './proxy.ts';
import { playbackConfigOptions } from './device-audio.ts';

/** config.json 的 `io.vtuber` 节。 */
export interface VtuberConfigSection {
  enabled: boolean;
  vtsWsUrl: string;
  streamPort: number;
  ttsUrl: string;
  ttsBaseLmFile: string;
  ttsAcousticFile: string;
  ttsAlignerLmFile: string;
  ttsAlignerAudioFile: string;
  ttsVoicesDir: string;
  live2dDir: string;
  /** 演出包目录;空 = bot 目录下的 `vtuber-pack/`,没有则用随模组的范例包。 */
  packDir: string;
  /** 禁播词(| 分隔多条);台本流里出现的子串整段不进 TTS、不上字幕。 */
  mutedTexts: string;
  audioDevice: string;
  audioMirrorSystem: boolean;
  audioSecondary: string;
  alignEnabled: boolean;
  streamEnabled: boolean;
  speechCapSec: number;
  maxActRoundsPerTurn: number;
  silenceRemindSec: number;
  silenceRemind2Sec: number;
  silenceRemind3Sec: number;
  silenceLine1: string;
  silenceLine2: string;
  silenceLine3: string;
  obsDelaySec: number;
  delayedSources: string[];
  yieldWindowMs: number;
  yieldFadeMs: number;
  decayGazeSec: [number, number];
  decayPoseSec: [number, number];
  decayEmotionSec: [number, number];
  modelProfile: string;
  ttsProfile: TtsProfile;
  overlay: OverlayConfig;
}

export const VTUBER: IOModuleDefinition<VtuberConfigSection> = {
  id: 'vtuber',
  label: 'VTuber 演出',
  defaults: () => ({
    ...structuredClone(VTUBER_MODULE_DEFAULTS as unknown as VtuberConfigSection),
    ttsProfile: { ...TTS_PROFILE_DEFAULTS },
    overlay: structuredClone(OVERLAY_CONFIG_DEFAULTS),
  }),
  // 播放设备下拉的选项。枚举本机声卡要 audify,那是本包的依赖;模组自报,宿主与 bot 都不替它答。
  configOptions: (kind) => playbackConfigOptions(kind),
  create: (ctx) => {
    const { cfg } = ctx;
    // 演出包三层,与环境提示词同一套规则:部署覆盖 > 人格包自带 > 模组范例(packDir 为空时)。
    // `cfg.packDir` 是部署配置里手填的绝对路径,压过一切——指到仓库外的包时用它。
    const packDir = cfg.packDir.trim()
      || [join(ctx.botDir, 'vtuber-pack'), join(ctx.packageDir, 'vtuber-pack')].find((d) => existsSync(d))
      || '';
    // The child process isolates 60 Hz avatar updates from synchronous work in the main loop.
    return new VtuberModuleProxy({
      timezone: ctx.timezone,
      botName: ctx.botName,
      vtsWsUrl: cfg.vtsWsUrl,
      streamPort: cfg.streamPort,
      ttsUrl: cfg.ttsUrl,
      ttsBaseLmFile: () => cfg.ttsBaseLmFile,
      ttsAcousticFile: () => cfg.ttsAcousticFile,
      ttsAlignerLmFile: () => cfg.ttsAlignerLmFile,
      ttsAlignerAudioFile: () => cfg.ttsAlignerAudioFile,
      ttsVoicesDir: () => cfg.ttsVoicesDir,
      live2dDir: () => cfg.live2dDir,
      packDir,
      audioDevice: () => cfg.audioDevice,
      audioMirrorSystem: () => cfg.audioMirrorSystem,
      audioSecondary: () => cfg.audioSecondary ?? VTUBER_MODULE_DEFAULTS.audioSecondary,
      alignEnabled: () => cfg.alignEnabled,
      streamEnabled: () => cfg.streamEnabled,
      speechCapSec: () => cfg.speechCapSec,
      maxActRoundsPerTurn: () => cfg.maxActRoundsPerTurn,
      silenceRemindSec: () => cfg.silenceRemindSec,
      silenceRemind2Sec: () => cfg.silenceRemind2Sec,
      silenceRemind3Sec: () => cfg.silenceRemind3Sec,
      silenceLines: () => [cfg.silenceLine1, cfg.silenceLine2, cfg.silenceLine3],
      mutedText: () => cfg.mutedTexts,
      obsDelaySec: () => cfg.obsDelaySec,
      delayedSources: () => cfg.delayedSources,
      yieldWindowMs: () => cfg.yieldWindowMs,
      yieldFadeMs: () => cfg.yieldFadeMs,
      decaySec: () => ({ gaze: cfg.decayGazeSec, pose: cfg.decayPoseSec, emotion: cfg.decayEmotionSec }),
      modelProfile: () => cfg.modelProfile,
      onModelProfile: (profile) => ctx.persist({ modelProfile: profile }),
      diagDir: join(ctx.dataDir, 'vtuber-diag'),
      ttsProfile: cfg.ttsProfile,
      onTtsProfile: (profile) => ctx.persist({ ttsProfile: profile }),
      overlay: cfg.overlay,
      onOverlayConfig: (config) => ctx.persist({ overlay: config }),
      vtsAuthToken: ctx.secret(VTUBER_MODULE_SECRET),
      onVtsToken: (token) => ctx.storeSecret(VTUBER_MODULE_SECRET, token),
    });
  },
};
