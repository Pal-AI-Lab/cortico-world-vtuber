/** 草稿试听的凭据只用于本次请求；不写配置或宿主密钥。 */
import { normalizeService, type TtsRegistryRead, type TtsServiceConfig } from './config.ts';

export function prepareTtsAudition(
  draft: unknown,
  read: TtsRegistryRead,
  apiKey?: string,
): { service: TtsServiceConfig; apiKey?: string } | { error: string } {
  if (typeof draft !== 'object' || draft === null) return { error: '服务配置必须是一个对象。' };
  const raw = draft as Record<string, unknown>;
  const saved = read.ok ? read.registry.services.find((s) => s.id === raw.id) : undefined;
  const auth = raw.auth as { type?: string } | undefined;
  const service = normalizeService(auth?.type === 'bearer' ? {
    ...raw,
    auth: {
      type: 'bearer',
      secretRef: saved?.auth.type === 'bearer' ? saved.auth.secretRef : 'VTUBER_TTS_AUDITION',
    },
  } : raw);
  if ('error' in service) return service;
  if (service.auth.type === 'none') return { service };
  if (apiKey?.trim()) return { service, apiKey: apiKey.trim() };
  // 与保存服务时相同：修改目标主机，不沿用旧主机的已存凭据。
  const sameOrigin = saved?.auth.type === 'bearer'
    && new URL(saved.baseUrl).origin === new URL(service.baseUrl).origin;
  return { service, ...(sameOrigin ? {} : { apiKey: '' }) };
}
