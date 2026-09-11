import { resolveVoiceTag } from './voice-tags.ts';

export const INVALID_ACT_SCRIPT_SHAPE = 'invalid_script_shape' as const;

export type ExternalActScriptResult =
  | { ok: true; script: string; normalized: boolean }
  | { ok: false; code: typeof INVALID_ACT_SCRIPT_SHAPE };

/**
 * Normalizes the one stable external serialization mistake accepted at this boundary.
 * Ordinary scripts retain their exact bytes; all other JSON container shapes are rejected.
 */
export function normalizeExternalActScript(script: string): ExternalActScriptResult {
  const trimmed = script.trim();
  if (!trimmed) return { ok: true, script, normalized: false };

  if (trimmed.startsWith('{')) return { ok: false, code: INVALID_ACT_SCRIPT_SHAPE };
  if (!trimmed.startsWith('[')) return { ok: true, script, normalized: false };

  try {
    const value: unknown = JSON.parse(trimmed);
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
      return { ok: true, script: value[0], normalized: true };
    }
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      return { ok: false, code: INVALID_ACT_SCRIPT_SHAPE };
    }
  } catch {
    // Candidate detection below separates performance tags from damaged containers.
  }

  const voice = /^\[([^\]\n]{1,32})\]/u.exec(trimmed);
  if (voice && resolveVoiceTag(voice[1]) !== null) {
    return { ok: true, script, normalized: false };
  }

  const inner = trimmed.slice(1).trimStart();
  const jsonToken = /^(?:["'\[{\]]|-?\d|true\b|false\b|null\b)/u.test(inner);
  const closedContainer = trimmed.endsWith(']') && !trimmed.slice(1, -1).includes('\n');
  if (!inner || jsonToken || closedContainer) {
    return { ok: false, code: INVALID_ACT_SCRIPT_SHAPE };
  }
  return { ok: true, script, normalized: false };
}

/** Receipt shared by in-process and proxy boundaries. */
export function invalidActScriptShapeReceipt(): string {
  return '[vtuber_act 失败] invalid_script_shape: script 必须是普通字符串台本，不能传入被字符串包裹的数组、对象或损坏的 JSON 容器。';
}

type StreamDisposition = 'pending' | 'passthrough' | 'container';

function streamDisposition(script: string): StreamDisposition {
  const trimmed = script.trimStart();
  if (!trimmed) return 'pending';
  if (trimmed.startsWith('{')) return 'container';
  if (!trimmed.startsWith('[')) return 'passthrough';

  const inner = trimmed.slice(1).trimStart();
  if (!inner) return 'pending';
  if (/^["'\[{\]]/u.test(inner) || /^-?\d/u.test(inner)) return 'container';

  const close = inner.indexOf(']');
  if (close < 0) return 'pending';
  const token = inner.slice(0, close).trim();
  if (resolveVoiceTag(token) !== null) return 'passthrough';
  if (/^(?:true|false|null)$/u.test(token)) return 'container';
  return inner.slice(close + 1).trimStart() ? 'passthrough' : 'pending';
}

/**
 * Holds only an undecided prefix or a detected container candidate. Once a script is known
 * to be ordinary, subsequent text remains fully streaming.
 */
export class ExternalActScriptStreamNormalizer {
  private script = '';
  private pending = '';
  private disposition: StreamDisposition = 'pending';

  constructor(private readonly out: (text: string) => void) {}

  feed(text: string): void {
    this.script += text;
    if (this.disposition === 'passthrough') {
      this.out(text);
      return;
    }
    this.pending += text;
    if (this.disposition === 'container') return;
    this.disposition = streamDisposition(this.pending);
    if (this.disposition === 'passthrough') {
      this.out(this.pending);
      this.pending = '';
    }
  }

  end(): ExternalActScriptResult {
    const result = normalizeExternalActScript(this.script);
    if (this.disposition !== 'passthrough' && result.ok) this.out(result.script);
    this.pending = '';
    return result;
  }

  /** Drops bytes that were held back while their external shape was undecided. */
  abort(): void {
    this.script = '';
    this.pending = '';
    this.disposition = 'pending';
  }
}
