/**
 * 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。
 *
 * 配置段类型一并导出,给 bot 侧在 `declares` 覆盖里写 `worlds.vtuber` 的字面量时用;
 * 除此之外本包不对外暴露内部形状——面板契约走 `consoleClient`,工具面走 World 实例。
 */

import { VTUBER } from './definition.ts';

export default VTUBER;

export { VTUBER };
export type { VtuberConfigSection } from './definition.ts';
export type { OverlayConfig, TtsProfile } from './module.ts';
