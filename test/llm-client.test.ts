import { describe, expect, it } from 'vitest';
import { createOpenAiCompatibleClient, httpStatusOf, LLM_DEFAULTS, llmConfigFromEnv } from '../src/lib/llm-client';

const CONFIG = { apiKey: 'test-key', baseUrl: 'https://llm.example/v1', model: 'test-model' };

/** A fetch that answers like an OpenAI-compatible server streaming SSE chunks. */
function sseFetch(chunks: unknown[], seen: { url?: string; body?: Record<string, unknown>; auth?: string }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = JSON.parse(String(init?.body));
    seen.auth = new Headers(init?.headers).get('authorization') ?? undefined;
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

const chunk = (delta: Record<string, unknown>) => ({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] });

describe('llmConfigFromEnv', () => {
  it('is disabled without a key and applies Groq defaults', () => {
    expect(llmConfigFromEnv({})).toBeNull();
    expect(llmConfigFromEnv({ LLM_API_KEY: '   ' })).toBeNull();
    expect(llmConfigFromEnv({ LLM_API_KEY: 'k' })).toEqual({ apiKey: 'k', baseUrl: LLM_DEFAULTS.baseUrl, model: LLM_DEFAULTS.model });
    expect(llmConfigFromEnv({ LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm' })).toEqual({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' });
    expect(LLM_DEFAULTS).toEqual({ baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' });
  });
});

describe('createOpenAiCompatibleClient', () => {
  it('streams text and sends temperature 0, the tools and tool_choice to the configured endpoint', async () => {
    const seen: { url?: string; body?: Record<string, unknown>; auth?: string } = {};
    const client = createOpenAiCompatibleClient(CONFIG, { fetch: sseFetch([chunk({ role: 'assistant', content: 'Hel' }), chunk({ content: 'lo' })], seen) });
    const deltas: string[] = [];
    const tools = [{ type: 'function' as const, function: { name: 'org_summary', description: 'd', parameters: { type: 'object' } } }];
    const result = await client.complete({ messages: [{ role: 'user', content: 'hi' }], tools, toolChoice: 'none' }, (d) => deltas.push(d));

    expect(result).toEqual({ content: 'Hello', toolCalls: [] });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(seen.url).toBe('https://llm.example/v1/chat/completions');
    expect(seen.auth).toBe('Bearer test-key');
    expect(seen.body).toMatchObject({ model: 'test-model', temperature: 0, stream: true, tool_choice: 'none', tools });
  });

  it('stitches tool-call fragments streamed across chunks', async () => {
    const client = createOpenAiCompatibleClient(CONFIG, {
      fetch: sseFetch(
        [
          chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'pay_benchmark', arguments: '{"jobTitle":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"Data Engineer"}' } }] }),
          chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'org_summary', arguments: '{}' } }] }),
        ],
        {},
      ),
    });
    const result = await client.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], toolChoice: 'auto' });
    expect(result.toolCalls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'pay_benchmark', arguments: '{"jobTitle":"Data Engineer"}' } },
      { id: 'call_b', type: 'function', function: { name: 'org_summary', arguments: '{}' } },
    ]);
  });

  it('surfaces HTTP 429 with its status (no retries)', async () => {
    let calls = 0;
    const fetch429 = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = createOpenAiCompatibleClient(CONFIG, { fetch: fetch429 });
    const err = await client.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], toolChoice: 'auto' }).catch((e: unknown) => e);
    expect(httpStatusOf(err)).toBe(429);
    expect(calls).toBe(1);
  });
});
