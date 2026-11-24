/**
 * "Ask HR Assistant" agent loop: model -> requested tools -> results back to the model -> repeat,
 * at most `maxIterations` model calls. The last call is made with tool_choice "none" so the model
 * must answer with what it has. Numbers only ever come from tools, never from the prompt.
 */
import type { DB } from '../db/connection';
import { httpStatusOf, type ChatMessage, type LlmClient } from '../lib/llm-client';
import { buildSystemPrompt } from './assistant-prompt';
import { createAssistantTools } from './assistant-tools';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolUse {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export type AssistantEvent =
  | ({ type: 'tool_call' } & ToolUse)
  | { type: 'text_delta'; text: string }
  | { type: 'done'; answer: string; toolsUsed: ToolUse[] }
  | { type: 'error'; code: AssistantErrorCode; message: string };

export type AssistantErrorCode = 'LLM_BUSY' | 'LLM_TOO_LARGE' | 'LLM_AUTH' | 'LLM_MODEL_UNAVAILABLE' | 'LLM_ERROR' | 'ABORTED';

export type AssistantResult =
  | { ok: true; answer: string; toolsUsed: ToolUse[] }
  | { ok: false; code: AssistantErrorCode; message: string; toolsUsed: ToolUse[] };

export interface AssistantOptions {
  db: DB;
  llm: LlmClient;
  maxIterations?: number;
  /** Only the most recent messages are sent to the model, to save tokens. */
  historyLimit?: number;
  now?: () => Date;
}

export const MAX_ITERATIONS = 4;
export const HISTORY_LIMIT = 10;
export const BUSY_MESSAGE = 'The AI assistant is busy, please try again in a minute.';
export const GAVE_UP_MESSAGE =
  "I couldn't finish answering within the allowed number of lookups. Try asking a more specific question.";

function describeError(err: unknown, model: string, signal?: AbortSignal): { code: AssistantErrorCode; message: string } {
  if (signal?.aborted) return { code: 'ABORTED', message: 'Request cancelled.' };
  const status = httpStatusOf(err);
  if (status === 429) return { code: 'LLM_BUSY', message: BUSY_MESSAGE };
  if (status === 413) return { code: 'LLM_TOO_LARGE', message: 'This conversation is too long for the AI assistant. Start a new chat and try again.' };
  if (status === 404) {
    // Providers retire models; make that obvious instead of a generic failure.
    return { code: 'LLM_MODEL_UNAVAILABLE', message: `The AI model "${model}" is not available from the provider. Set LLM_MODEL on the server to a current tool-calling model.` };
  }
  if (status === 401 || status === 403) {
    return { code: 'LLM_AUTH', message: 'The AI assistant is not configured correctly. Check LLM_API_KEY on the server.' };
  }
  return { code: 'LLM_ERROR', message: "The AI assistant couldn't answer right now. Please try again." };
}

export function createAssistantService({ db, llm, maxIterations = MAX_ITERATIONS, historyLimit = HISTORY_LIMIT, now = () => new Date() }: AssistantOptions) {
  const tools = createAssistantTools(db);

  return {
    model: llm.model,

    async chat(
      messages: ConversationMessage[],
      { onEvent = () => {}, signal }: { onEvent?: (event: AssistantEvent) => void; signal?: AbortSignal } = {},
    ): Promise<AssistantResult> {
      const conversation: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(db, now()) },
        ...messages.slice(-historyLimit).map((m) => ({ role: m.role, content: m.content })),
      ];
      const toolsUsed: ToolUse[] = [];

      try {
        for (let iteration = 0; iteration < maxIterations; iteration++) {
          const isLast = iteration === maxIterations - 1;
          const turn = await llm.complete(
            { messages: conversation, tools: tools.specs, toolChoice: isLast ? 'none' : 'auto', signal },
            (text) => onEvent({ type: 'text_delta', text }),
          );

          if (turn.toolCalls.length === 0) {
            onEvent({ type: 'done', answer: turn.content, toolsUsed });
            return { ok: true, answer: turn.content, toolsUsed };
          }
          if (isLast) break; // the model ignored tool_choice "none"

          const calls = turn.toolCalls.map((c, i) => ({ ...c, id: c.id || `call_${iteration}_${i}` }));
          conversation.push({ role: 'assistant', content: turn.content || null, tool_calls: calls });
          for (const call of calls) {
            const outcome = tools.execute(call.function.name, call.function.arguments);
            const use: ToolUse = { name: outcome.name, args: outcome.args, ok: outcome.ok };
            toolsUsed.push(use);
            onEvent({ type: 'tool_call', ...use });
            conversation.push({ role: 'tool', tool_call_id: call.id, content: outcome.content });
          }
        }
        onEvent({ type: 'done', answer: GAVE_UP_MESSAGE, toolsUsed });
        return { ok: true, answer: GAVE_UP_MESSAGE, toolsUsed };
      } catch (err) {
        const { code, message } = describeError(err, llm.model, signal);
        // Log the provider error, never the conversation: it contains salary data.
        if (code === 'LLM_ERROR' || code === 'LLM_MODEL_UNAVAILABLE') console.error('Assistant LLM call failed:', (err as Error)?.message ?? err);
        onEvent({ type: 'error', code, message });
        return { ok: false, code, message, toolsUsed };
      }
    },
  };
}

export type AssistantService = ReturnType<typeof createAssistantService>;
