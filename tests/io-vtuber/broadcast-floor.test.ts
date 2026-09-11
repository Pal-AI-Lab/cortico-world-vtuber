import { describe, it, expect } from 'vitest';
import type { EventEnvelope, EventStoreReader } from '../../src/core/types.ts';
import { broadcastFloorMs } from '../../src/io-vtuber/module.ts';

/** cursor 从 1 起的假事件库 */
function storeOf(events: Array<{ source: string; tsOffsetMs: number }>, now: number): EventStoreReader {
  const rows: EventEnvelope[] = events.map((e, i) => ({
    cursor: i + 1,
    type: `${e.source}.event`,
    ts: new Date(now + e.tsOffsetMs).toISOString(),
    source: e.source,
    origin: 'external',
    text: 'x',
  }));
  return {
    get: (cursor) => rows[cursor - 1],
    latestCursor: () => rows.length,
    range: () => rows,
    around: () => rows,
    grep: () => [],
  };
}

describe('broadcastFloorMs(防先知穿帮)', () => {
  const now = 1_700_000_000_000;

  it('延迟源近期事件抬高地板 = 事件时刻 + N + ε;取多事件的最大值', () => {
    const store = storeOf(
      [
        { source: 'pvz', tsOffsetMs: -1800 },
        { source: 'pvz', tsOffsetMs: -500 },
      ],
      now,
    );
    const floor = broadcastFloorMs(store, ['pvz'], 2000, now);
    expect(floor).toBeGreaterThan(now);
    expect(floor).toBe(now - 500 + 2000 + 60);
  });

  it('非延迟源的事件不设地板;扫描在 now−N 之前的事件处停下', () => {
    const store = storeOf(
      [
        { source: 'pvz', tsOffsetMs: -30_000 }, // 早于 now−N:地板已在过去
        { source: 'qq', tsOffsetMs: -100 },
      ],
      now,
    );
    expect(broadcastFloorMs(store, ['pvz'], 2000, now)).toBe(0);
  });

  it('未标定(N=0)或无延迟源:恒 0,不扫库', () => {
    const store = storeOf([{ source: 'pvz', tsOffsetMs: -100 }], now);
    expect(broadcastFloorMs(store, [], 2000, now)).toBe(0);
    expect(broadcastFloorMs(store, ['pvz'], 0, now)).toBe(0);
  });
});
