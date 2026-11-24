/**
 * Provider-neutral LLM interface for the HR assistant, plus an implementation for any
 * OpenAI-compatible chat-completions API (Groq by default). The agent loop and tests only
 * depend on `LlmClient`, so the provider can be swapped by config or faked.
 *
 * Message and tool shapes mirror the OpenAI wire format (tools, tool_calls, role "tool").
 */
import OpenAI from 'openai';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** 'none' forces a text answer (used on the last allowed iteration). */
  toolChoice: 'auto' | 'none';
  signal?: AbortSignal;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface LlmClient {
  readonly model: string;
  /** Runs one model turn. Text is streamed through `onText` as it arrives. */
  complete(request: CompletionRequest, onText?: (delta: string) => void): Promise<CompletionResult>;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const LLM_DEFAULTS = {
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'openai/gpt-oss-120b',
} as const;

/** Reads LLM_* variables. Returns null when LLM_API_KEY is missing: the assistant is then disabled. */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env.LLM_BASE_URL?.trim() || LLM_DEFAULTS.baseUrl,
    model: env.LLM_MODEL?.trim() || LLM_DEFAULTS.model,
  };
}

/** The configured client, or null when LLM_API_KEY is not set. */
export function createLlmClientFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  const config = llmConfigFromEnv(env);
  return config ? createOpenAiCompatibleClient(config) : null;
}

/** Answers are short; capping output also keeps requests inside free-tier tokens-per-minute limits. */
const MAX_OUTPUT_TOKENS = 1024;

/** `fetch` can be injected so tests exercise the real SDK without network access. */
export function createOpenAiCompatibleClient(config: LlmConfig, options: { fetch?: typeof fetch } = {}): LlmClient {
  // No SDK retries: on a free tier a 429 should surface quickly as "busy, try again", not hang for seconds.
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    maxRetries: 0,
    timeout: 30_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    model: config.model,
    async complete({ messages, tools, toolChoice, signal }, onText) {
      const stream = await client.chat.completions.create(
        {
          model: config.model,
          messages,
          tools,
          tool_choice: toolChoice,
          temperature: 0,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
        },
        { signal },
      );

      let content = '';
      const toolCalls: ToolCall[] = [];
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          onText?.(delta.content);
        }
        // Tool calls arrive as fragments keyed by index; stitch them together.
        for (const part of delta.tool_calls ?? []) {
          const call = (toolCalls[part.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (part.id) call.id = part.id;
          if (part.function?.name) call.function.name += part.function.name;
          if (part.function?.arguments) call.function.arguments += part.function.arguments;
        }
      }
      return { content, toolCalls: toolCalls.filter(Boolean) };
    },
  };
}

/** Any provider error carrying an HTTP status (the OpenAI SDK's APIError does). */
export function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}
