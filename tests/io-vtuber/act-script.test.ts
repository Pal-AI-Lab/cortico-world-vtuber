import { describe, expect, it } from 'vitest';
import {
  ExternalActScriptStreamNormalizer,
  normalizeExternalActScript,
} from '../../src/io-vtuber/act-script.ts';

describe('normalizeExternalActScript', () => {
  it('keeps ordinary scripts and performance voice tags byte-for-byte', () => {
    const ordinary = '  【点头】大家好。\n';
    expect(normalizeExternalActScript(ordinary)).toEqual({
      ok: true,
      script: ordinary,
      normalized: false,
    });
    expect(normalizeExternalActScript('[sigh]先缓一口气。')).toEqual({
      ok: true,
      script: '[sigh]先缓一口气。',
      normalized: false,
    });
  });

  it('narrowly unwraps one JSON string element with unicode and escaped quotes', () => {
    expect(normalizeExternalActScript('  ["她说：\\"你好🌙\\""]  ')).toEqual({
      ok: true,
      script: '她说："你好🌙"',
      normalized: true,
    });
  });

  it.each([
    '[]',
    '["一","二"]',
    '[1]',
    '[{"script":"台词"}]',
    '{"script":"台词"}',
    '["没有闭合"',
    "['不是 JSON']",
  ])('rejects unsupported or damaged container %s', (script) => {
    expect(normalizeExternalActScript(script)).toEqual({ ok: false, code: 'invalid_script_shape' });
  });
});

describe('ExternalActScriptStreamNormalizer', () => {
  it('buffers a fragmented string-array candidate until end and emits only decoded text', () => {
    const emitted: string[] = [];
    const stream = new ExternalActScriptStreamNormalizer((text) => emitted.push(text));
    for (const fragment of ['  [', '"你', '好\\"', '月亮', '🌙"', ']  ']) {
      stream.feed(fragment);
      expect(emitted).toEqual([]);
    }
    expect(stream.end()).toEqual({ ok: true, script: '你好"月亮🌙', normalized: true });
    expect(emitted).toEqual(['你好"月亮🌙']);
  });

  it('never emits fragments from an invalid candidate', () => {
    const emitted: string[] = [];
    const stream = new ExternalActScriptStreamNormalizer((text) => emitted.push(text));
    for (const fragment of ['["第一段"', ',"第二段"', ']']) stream.feed(fragment);
    expect(emitted).toEqual([]);
    expect(stream.end()).toEqual({ ok: false, code: 'invalid_script_shape' });
    expect(emitted).toEqual([]);
  });

  it('releases a complete voice tag and keeps the rest streaming', () => {
    const emitted: string[] = [];
    const stream = new ExternalActScriptStreamNormalizer((text) => emitted.push(text));
    stream.feed('[si');
    expect(emitted).toEqual([]);
    stream.feed('gh]');
    expect(emitted.join('')).toBe('[sigh]');
    stream.feed('继续说。');
    expect(emitted.join('')).toBe('[sigh]继续说。');
    expect(stream.end()).toEqual({ ok: true, script: '[sigh]继续说。', normalized: false });
  });

  it('drops an undecided container candidate on abort', () => {
    const emitted: string[] = [];
    const stream = new ExternalActScriptStreamNormalizer((text) => emitted.push(text));
    stream.feed('["不会播出。"]');
    stream.abort();
    expect(emitted).toEqual([]);
  });
});
