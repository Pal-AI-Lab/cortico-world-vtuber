import { describe, expect, it } from 'vitest';
import { StreamRedactor } from '../../src/world.ts';

/**
 * 禁播词在流式入口滤除，避免 handler 拒绝时音频已经输出；普通字符不得因过滤而无故滞留。
 */
describe('StreamRedactor:台本流的禁播词滤除', () => {
  const BANNED = '(这句已归入交接笔记)';

  function collect(banned: string[]) {
    const out: string[] = [];
    const hits: string[] = [];
    const r = new StreamRedactor(() => banned, (t) => out.push(t), (b) => hits.push(b));
    return { r, text: () => out.join(''), hits };
  }

  it('逐字符流进来的禁播词整条滤掉,前后的正常台词原样过', () => {
    const { r, text, hits } = collect([BANNED]);
    for (const ch of `你们好!${BANNED}继续挖矿~`) r.feed(ch);
    r.flush();
    expect(text()).toBe('你们好!继续挖矿~');
    expect(hits).toEqual([BANNED]);
  });

  it('只是前缀相同、中途岔开的台词一个字都不丢', () => {
    const { r, text, hits } = collect([BANNED]);
    r.feed('(这句已');
    r.feed('经说完啦)收工!');
    r.flush();
    expect(text()).toBe('(这句已经说完啦)收工!');
    expect(hits).toEqual([]);
  });

  it('流断在禁播词前缀上:flush 把扣住的尾巴放行', () => {
    const { r, text } = collect([BANNED]);
    r.feed('晚安(这句已');
    r.flush();
    expect(text()).toBe('晚安(这句已');
  });

  it('断流丢弃仍扣着的禁播词前缀', () => {
    const { r, text } = collect([BANNED]);
    r.feed('晚安(这句已');
    r.discard();
    expect(text()).toBe('晚安');
  });

  it('与前缀无关的字符即刻放行,不为滤词扣流', () => {
    const { r, text } = collect([BANNED]);
    r.feed('挖到钻石啦');
    expect(text()).toBe('挖到钻石啦'); // 不等 flush
  });

  it('禁播词表为空:纯直通', () => {
    const { r, text } = collect([]);
    r.feed(BANNED);
    expect(text()).toBe(BANNED);
  });
});
