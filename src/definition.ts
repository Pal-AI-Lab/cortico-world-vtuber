import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldDefinition } from 'cortico/world.ts';
import {
  OVERLAY_CONFIG_DEFAULTS,
  TTS_PROFILE_DEFAULTS,
  VTUBER_DEFAULTS,
  VTUBER_SECRET,
  type OverlayConfig,
  type TtsProfile,
} from './world.ts';
import { projectLegacyFields, readTtsRegistry, type TtsRegistryConfig } from './tts/config.ts';
import { VtuberWorldProxy } from './proxy.ts';
import { playbackConfigOptions } from './device-audio.ts';

/** config.json 的 `worlds.vtuber` 节。 */
export interface VtuberConfigSection {
  enabled: boolean;
  vtsWsUrl: string;
  streamPort: number;
  ttsUrl: string;
  ttsRuntimeDir: string;
  ttsRuntimeRelease: string;
  ttsBaseLmFile: string;
  ttsAcousticFile: string;
  ttsAlignerLmFile: string;
  ttsAlignerAudioFile: string;
  ttsVoicesDir: string;
  live2dDir: string;
  /** 演出包目录;空 = bot 目录下的 `vtuber-pack/`,没有则用随 World 的范例包。 */
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
  /**
   * TTS 服务注册表。缺席时按旧扁平字段在内存生成 legacy 服务(见 tts/config.ts),
   * 读操作不写盘;首次显式修改才落盘,落盘时旧字段同步为兼容投影。
   */
  tts?: TtsRegistryConfig | null;
  overlay: OverlayConfig;
}

/**
 * 首次把旧部署迁移到服务表之前留一份配置副本。
 *
 * 只做一次:配置里已经有 `tts` 就说明迁过了。备份失败就拒绝这次写入——迁移会改写
 * 旧字段的含义,没有退路时不静默动手,错误照原样给到控制台。
 */
function backupBeforeTtsMigration(ctx: { botDir: string }, cfg: VtuberConfigSection): void {
  if (cfg.tts) return;
  const source = join(ctx.botDir, 'config.json');
  if (!existsSync(source)) return;
  const target = join(ctx.botDir, `config.json.bak-tts-migration-${Date.now()}`);
  try {
    writeFileSync(target, readFileSync(source));
  } catch (err) {
    throw new Error(`迁移前的配置备份失败(${target}):${err instanceof Error ? err.message : String(err)}`);
  }
}

export const VTUBER: WorldDefinition<VtuberConfigSection> = {
  id: 'vtuber',
  label: 'VTuber 演出',
  defaults: () => ({
    ...structuredClone(VTUBER_DEFAULTS as unknown as VtuberConfigSection),
    ttsProfile: { ...TTS_PROFILE_DEFAULTS },
    overlay: structuredClone(OVERLAY_CONFIG_DEFAULTS),
  }),
  // 播放设备下拉的整张表(含"系统默认 / 不出声"固定项)。枚举本机声卡要 audify,那是本包的
  // 依赖;World 自报,宿主与 bot 都不替它答,控制台也不认识这两个 kind。
  configOptions: (kind, language) => playbackConfigOptions(kind, language),
  create: (ctx) => {
    const { cfg } = ctx;
    // 演出包三层,与环境提示词同一套规则:部署覆盖 > 人格包自带 > World 范例(packDir 为空时)。
    // `cfg.packDir` 是部署配置里手填的绝对路径,压过一切——指到仓库外的包时用它。
    const packDir = cfg.packDir.trim()
      || [join(ctx.botDir, 'vtuber-pack'), join(ctx.packageDir, 'vtuber-pack')].find((d) => existsSync(d))
      || '';
    // The child process isolates 60 Hz avatar updates from synchronous work in the main loop.
    return new VtuberWorldProxy({
      timezone: ctx.timezone,
      botName: ctx.botName,
      vtsWsUrl: cfg.vtsWsUrl,
      streamPort: cfg.streamPort,
      ttsUrl: cfg.ttsUrl,
      ttsRuntimeDir: () => cfg.ttsRuntimeDir,
      ttsRuntimeRelease: () => cfg.ttsRuntimeRelease,
      ttsBaseLmFile: () => cfg.ttsBaseLmFile,
      ttsAcousticFile: () => cfg.ttsAcousticFile,
      ttsAlignerLmFile: () => cfg.ttsAlignerLmFile,
      ttsAlignerAudioFile: () => cfg.ttsAlignerAudioFile,
      ttsVoicesDir: () => cfg.ttsVoicesDir,
      live2dDir: () => cfg.live2dDir,
      packDir,
      audioDevice: () => cfg.audioDevice,
      audioMirrorSystem: () => cfg.audioMirrorSystem,
      audioSecondary: () => cfg.audioSecondary ?? VTUBER_DEFAULTS.audioSecondary,
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
      // 注册表现读:虚拟迁移只在内存里发生,配置里没有 tts 时也照样能合成
      ttsRegistry: () => readTtsRegistry(cfg, cfg.ttsUrl),
      ttsSecrets: () => {
        const read = readTtsRegistry(cfg, cfg.ttsUrl);
        if (!read.ok) return {};
        const out: Record<string, string> = {};
        for (const service of read.registry.services) {
          if (service.auth.type !== 'bearer') continue;
          const ref = service.auth.secretRef;
          if (ref in out) continue;
          out[ref] = ctx.secret(ref);
        }
        return out;
      },
      // 新结构是唯一权威;旧扁平字段同步成它的兼容投影,避免两处各自可编辑
      onTtsRegistry: (registry) => {
        backupBeforeTtsMigration(ctx, cfg);
        ctx.persist({ tts: registry, ...projectLegacyFields(registry) } as never);
      },
      storeTtsSecret: (ref: string, value: string) => ctx.storeSecret(ref, value),
      diagDir: join(ctx.dataDir, 'vtuber-diag'),
      ttsProfile: cfg.ttsProfile,
      onTtsProfile: (profile) => ctx.persist({ ttsProfile: profile }),
      overlay: cfg.overlay,
      onOverlayConfig: (config) => ctx.persist({ overlay: config }),
      vtsAuthToken: ctx.secret(VTUBER_SECRET),
      onVtsToken: (token) => ctx.storeSecret(VTUBER_SECRET, token),
    });
  },
};
