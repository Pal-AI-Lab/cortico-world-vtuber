import { afterEach, expect, it, vi } from 'vitest';
import type { WorldHost } from 'cortico/core/types.ts';
import type { EngineRequest } from '../../src/ipc.ts';
import { VtuberModuleProxy } from '../../src/proxy.ts';

afterEach(() => vi.useRealTimers());

it('引擎已接收请求但不回执时记故障并取消等待，不重发演出', async () => {
  vi.useFakeTimers();
  const sent: Array<{ t: string }> = [];
  const errors: Array<{ message: string; data: unknown }> = [];
  const proxy = new VtuberModuleProxy({});
  const inner = proxy as unknown as {
    child: { connected: boolean; pid: number; send(message: { t: string }): void };
    host: WorldHost;
    pending: Map<number, unknown>;
    rpc(req: EngineRequest, timeoutMs: number): Promise<unknown>;
  };
  inner.child = { connected: true, pid: 123, send: (message) => { sent.push(message); } };
  inner.host = {
    log: { error: (message: string, data: unknown) => { errors.push({ message, data }); } },
  } as unknown as WorldHost;
  const waiting = inner.rpc({
    kind: 'tool', name: 'vtuber_act', args: { script: '已经递交的演出' }, round: null,
    role: 'main', callId: 'unanswered-act',
  }, 20_000);
  const rejected = expect(waiting).rejects.toThrow('20s 未回执');
  await vi.advanceTimersByTimeAsync(20_000);
  await rejected;
  expect(inner.pending.size).toBe(0);
  expect(sent.map((message) => message.t)).toEqual(['req', 'cancel']);
  expect(errors).toHaveLength(1);
  expect(errors[0].data).toMatchObject({
    kind: 'tool', tool: 'vtuber_act', callId: 'unanswered-act', timeoutMs: 20_000,
    childPid: 123, connected: true,
  });
});
