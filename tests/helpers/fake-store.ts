/**
 * 内存事件库。框架 `tests/web/fakes.ts` 里那份的最小子集:本包的 web 测试只拿它
 * 给 `WebApp` 当事件面,不用那边的 fake host。
 */

import type {
  EventEnvelope, EventGrepHit, EventGrepQuery, EventRangeQuery, EventStore,
} from 'cortico/core/types.ts';

export class FakeStore implements EventStore {
  events: EventEnvelope[] = [];

  append(e: Omit<EventEnvelope, 'cursor'>): EventEnvelope {
    const ev: EventEnvelope = { ...e, cursor: this.events.length + 1 };
    this.events.push(ev);
    return ev;
  }

  get(cursor: number): EventEnvelope | undefined {
    return this.events.find((e) => e.cursor === cursor);
  }

  latestCursor(): number {
    return this.events.length ? this.events[this.events.length - 1].cursor : 0;
  }

  range(q: EventRangeQuery): EventEnvelope[] {
    let out = this.events.filter((e) =>
      (q.fromCursor === undefined || e.cursor >= q.fromCursor) &&
      (q.toCursor === undefined || e.cursor <= q.toCursor) &&
      (q.fromTs === undefined || e.ts >= q.fromTs) &&
      (q.toTs === undefined || e.ts <= q.toTs) &&
      (q.senderKey === undefined || e.senderKey === q.senderKey) &&
      (q.source === undefined || e.source === q.source));
    if (q.limit !== undefined && out.length > q.limit) out = out.slice(out.length - q.limit);
    return out;
  }

  around(cursor: number, before: number, after: number): EventEnvelope[] {
    const idx = this.events.findIndex((e) => e.cursor === cursor);
    if (idx < 0) return [];
    return this.events.slice(Math.max(0, idx - before), Math.min(this.events.length, idx + after + 1));
  }

  grep(q: EventGrepQuery): EventGrepHit[] {
    const hits: EventGrepHit[] = [];
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (!e.text.includes(q.keyword)) continue;
      if (q.senderKey !== undefined && e.senderKey !== q.senderKey) continue;
      if (q.source !== undefined && e.source !== q.source) continue;
      if (q.fromTs !== undefined && e.ts < q.fromTs) continue;
      if (q.toTs !== undefined && e.ts > q.toTs) continue;
      hits.push({
        hitCursor: e.cursor,
        events: this.events.slice(Math.max(0, i - q.context), Math.min(this.events.length, i + q.context + 1)),
      });
      if (q.limit !== undefined && hits.length >= q.limit) break;
    }
    return hits;
  }
}
