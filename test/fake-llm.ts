import type { CompletionRequest, CompletionResult, LlmClient } from '../src/lib/llm-client';

export type ScriptedTurn =
  | { text: string }
  | { tools: { name: string; args?: unknown; rawArgs?: string }[]; text?: string }
  | { throw: unknown };

export function fakeLlm(script: ScriptedTurn[], model = 'fake-model') {
  const requests: CompletionRequest[] = [];
  const client: LlmClient = {
    model,
    async complete(request, onText): Promise<CompletionResult> {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const turn = script[Math.min(requests.length - 1, script.length - 1)]!;
      if ('throw' in turn) throw turn.throw;
      const text = 'text' in turn && turn.text ? turn.text : '';
      if (text) {
        onText?.(text.slice(0, Math.ceil(text.length / 2)));
        onText?.(text.slice(Math.ceil(text.length / 2)));
      }
      const toolCalls =
        'tools' in turn
          ? turn.tools.map((t, i) => ({
              id: `call_${requests.length}_${i}`,
              type: 'function' as const,
              function: { name: t.name, arguments: t.rawArgs ?? JSON.stringify(t.args ?? {}) },
            }))
          : [];
      return { content: text, toolCalls };
    },
  };
  return { client, requests };
}

export function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}
