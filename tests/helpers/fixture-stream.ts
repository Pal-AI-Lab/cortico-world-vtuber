/**
 * 把老式的逐段增量(`LLMDelta`)翻成 Open Responses 的事件流,供测试给 `OutputTap`
 * 喂真事件序列。框架 `tests/core/fixture-protocol.ts` 里那份的最小子集:本包只用
 * `legacyTap`,它只依赖 `FixtureStream`,其余(fixture 客户端、core 假件、
 * ContextRecord 互转)都与演出 World 无关。
 */

import type { LLMUsage, OutputTap } from 'cortico/core/types.ts';
import { createResponse, type OutputItem, type Request, type StreamEvent } from 'cortico/protocol/open-responses/index.ts';

export type LLMDelta =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call.begin'; index: number; id: string; name: string }
  | { type: 'tool_call.delta'; index: number; argsFragment: string }
  | { type: 'tool_call.end'; index: number };

export interface FixtureTap {
  onDelta(delta: LLMDelta): void;
  externalizes?(delta: LLMDelta): boolean;
  onRoundEnd?(): void;
  onAbort?(reason: string): void;
}

let groupSeq = 0;

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 脚本化的增量走真实的 Item 生命周期,包括逐次调用的提前完成。 */
export class FixtureStream {
  readonly response;
  private sequence = 0;
  private readonly output: any[] = [];
  private readonly calls = new Map<number, number>();
  private readonly texts = new Map<string, number>();

  constructor(request: Request, private readonly emit: (event: StreamEvent) => void) {
    this.response = createResponse(`resp_fixture_${++groupSeq}`, request);
    this.send({ type: 'response.created', response: this.response });
  }

  private send(event: Record<string, unknown>): void {
    this.emit(structuredClone({ ...event, sequence_number: this.sequence++ }) as StreamEvent);
  }

  feed(delta: LLMDelta): void {
    if (delta.type === 'reasoning' || delta.type === 'content') {
      let index = this.texts.get(delta.type);
      const reason = delta.type === 'reasoning';
      if (index === undefined) {
        index = this.output.length;
        const item = reason ? { type: 'reasoning', id: `rs_${index}`, summary: [], content: [] }
          : { type: 'message', id: `msg_${index}`, role: 'assistant', status: 'in_progress', content: [] };
        this.output.push(item); this.texts.set(delta.type, index);
        this.send({ type: 'response.output_item.added', output_index: index, item });
        const part = reason ? { type: 'reasoning_text', text: '' } : { type: 'output_text', text: '', annotations: [] };
        this.send({ type: 'response.content_part.added', output_index: index, item_id: item.id, content_index: 0, part });
        item.content.push(part as never);
      }
      const item = this.output[index];
      this.send({ type: reason ? 'response.reasoning.delta' : 'response.output_text.delta', output_index: index, item_id: item.id, content_index: 0, delta: delta.text, logprobs: [] });
      item.content[0].text += delta.text;
      return;
    }
    if (delta.type === 'tool_call.begin') {
      // 老式夹具把推理与正文全排在工具调用之前。
      this.closeTexts();
      const index = this.output.length;
      this.calls.set(delta.index, index);
      const item = { type: 'function_call', id: `fc_${index}`, call_id: delta.id, name: delta.name, arguments: '', status: 'in_progress' };
      this.output.push(item); this.send({ type: 'response.output_item.added', output_index: index, item });
      return;
    }
    const index = this.calls.get(delta.index);
    if (index === undefined) return;
    const item = this.output[index];
    if (delta.type === 'tool_call.delta') {
      this.send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: delta.argsFragment });
      item.arguments += delta.argsFragment;
    } else {
      this.send({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments });
      item.status = 'completed';
      this.send({ type: 'response.output_item.done', output_index: index, item });
    }
  }

  private closeTexts(): void {
    for (const index of this.texts.values()) {
      const item = this.output[index];
      this.send({ type: 'response.content_part.done', output_index: index, item_id: item.id, content_index: 0, part: item.content[0] });
      if (item.type === 'message') item.status = 'completed';
      this.send({ type: 'response.output_item.done', output_index: index, item });
    }
    this.texts.clear();
  }

  finish(usage: LLMUsage | undefined): void {
    this.closeTexts();
    this.response.output = this.output as OutputItem[];
    this.response.status = 'completed';
    if (usage) {
      this.response.usage = {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.promptTokens + usage.completionTokens,
        input_tokens_details: { cached_tokens: usage.cacheHitTokens },
        output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
      };
    }
    this.send({ type: 'response.completed', response: this.response });
  }
}

/** 给一个吃事件的 `OutputTap` 套上老式增量接口;`vtuber_act` 那一路按外化处理。 */
export function legacyTap(tap: OutputTap): FixtureTap {
  let stream = new FixtureStream({} as Request, (event) => tap.onEvent(event));
  return {
    onDelta: (delta) => stream.feed(delta),
    onRoundEnd: () => { tap.onRoundEnd?.(); stream = new FixtureStream({} as Request, (event) => tap.onEvent(event)); },
    onAbort: (reason) => { tap.onAbort?.(reason); stream = new FixtureStream({} as Request, (event) => tap.onEvent(event)); },
    externalizes: (delta) => delta.type === 'tool_call.begin' && delta.name === 'vtuber_act',
  };
}
