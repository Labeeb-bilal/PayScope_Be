import { describe, expect, it, vi } from 'vitest';
import {
  BUSY_MESSAGE, createAssistantService, GAVE_UP_MESSAGE, MAX_ITERATIONS, type AssistantEvent,
} from '../src/services/assistant-service';
import { createInsightsService } from '../src/services/insights-service';
import { fakeLlm, httpError } from './fake-llm';
import { employeeInput, setup } from './helpers';

function seeded() {
  const ctx = setup();
  for (const salary of [400_000, 420_000, 440_000]) {
    ctx.service.create(employeeInput({ jobTitle: 'Data Engineer', level: 'L3', countryCode: 'AE', salary }));
  }
  return ctx;
}

const ask = (content: string) => [{ role: 'user' as const, content }];

describe('assistant agent loop', () => {
  it('runs a requested tool, passes its result back, then returns the final answer', async () => {
    const { db } = seeded();
    const llm = fakeLlm([
      { tools: [{ name: 'pay_benchmark', args: { jobTitle: 'Data Engineer', level: 'Senior', country: 'UAE' } }] },
      { text: 'The median is **AED 420,000**.' },
    ]);
    const events: AssistantEvent[] = [];
    const result = await createAssistantService({ db, llm: llm.client }).chat(ask('What do we pay a Senior Data Engineer in the UAE?'), {
      onEvent: (e) => events.push(e),
    });

    expect(result).toEqual({
      ok: true,
      answer: 'The median is **AED 420,000**.',
      toolsUsed: [{ name: 'pay_benchmark', args: { jobTitle: 'Data Engineer', level: 'L3', country: 'AE' }, ok: true }],
    });

    // Second request carries the assistant tool call and the tool result with the real numbers.
    expect(llm.requests).toHaveLength(2);
    const [, second] = llm.requests;
    const toolMessage = second!.messages.at(-1)!;
    expect(second!.messages.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1_0', function: { name: 'pay_benchmark' } }] });
    expect(toolMessage).toMatchObject({ role: 'tool', tool_call_id: 'call_1_0' });
    const expected = createInsightsService(db).benchmark({ jobTitle: 'Data Engineer', level: 'L3', country: 'AE' });
    expect(JSON.parse((toolMessage as { content: string }).content)).toEqual(expected);

    expect(events.map((e) => e.type)).toEqual(['tool_call', 'text_delta', 'text_delta', 'done']);
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')).toBe(result.ok && result.answer);
  });

  it('sends the system prompt first and offers the tools with tool_choice auto', async () => {
    const { db } = seeded();
    const llm = fakeLlm([{ text: 'Hi' }]);
    await createAssistantService({ db, llm: llm.client }).chat(ask('hello'));
    const [request] = llm.requests;
    expect(request!.messages[0]).toMatchObject({ role: 'system' });
    expect(request!.messages[0]!.content).toContain('Never estimate');
    expect(request!.tools.length).toBeGreaterThan(0);
    expect(request!.toolChoice).toBe('auto');
  });

  it('stops after the maximum number of iterations, forcing a text answer on the last one', async () => {
    const { db } = seeded();
    const llm = fakeLlm([{ tools: [{ name: 'org_summary' }] }]); // never stops asking for tools
    const result = await createAssistantService({ db, llm: llm.client }).chat(ask('loop forever'));
    expect(llm.requests).toHaveLength(MAX_ITERATIONS);
    expect(llm.requests.map((r) => r.toolChoice)).toEqual([...Array(MAX_ITERATIONS - 1).fill('auto'), 'none']);
    expect(result).toMatchObject({ ok: true, answer: GAVE_UP_MESSAGE });
    expect(result.toolsUsed).toHaveLength(MAX_ITERATIONS - 1);
  });

  it('handles an unknown tool by telling the model, then continues', async () => {
    const { db } = seeded();
    const llm = fakeLlm([{ tools: [{ name: 'give_everyone_a_raise', args: { pct: 50 } }] }, { text: 'I can only read data.' }]);
    const result = await createAssistantService({ db, llm: llm.client }).chat(ask('Give everyone a raise'));
    expect(result).toMatchObject({ ok: true, answer: 'I can only read data.' });
    expect(result.toolsUsed).toEqual([{ name: 'give_everyone_a_raise', args: {}, ok: false }]);
    const toolMessage = llm.requests[1]!.messages.at(-1) as { content: string };
    expect(JSON.parse(toolMessage.content).error).toMatch(/Unknown tool "give_everyone_a_raise"/);
  });

  it('passes validation errors back to the model so it can retry with fixed arguments', async () => {
    const { db } = seeded();
    const llm = fakeLlm([
      { tools: [{ name: 'pay_benchmark', args: { jobTitle: 'Senior Data Engineer' } }] },
      { tools: [{ name: 'pay_benchmark', args: { jobTitle: 'Data Engineer', level: 'L3' } }] },
      { text: 'Done.' },
    ]);
    const result = await createAssistantService({ db, llm: llm.client }).chat(ask('benchmark'));
    expect(result.toolsUsed.map((t) => t.ok)).toEqual([false, true]);
    const firstToolResult = llm.requests[1]!.messages.at(-1) as { content: string };
    expect(JSON.parse(firstToolResult.content).error).toMatch(/Invalid arguments for pay_benchmark: jobTitle/);
  });

  it('runs several tool calls from one turn, in order', async () => {
    const { db } = seeded();
    const llm = fakeLlm([{ tools: [{ name: 'org_summary' }, { name: 'pay_by_level' }] }, { text: 'ok' }]);
    const result = await createAssistantService({ db, llm: llm.client }).chat(ask('overview'));
    expect(result.toolsUsed.map((t) => t.name)).toEqual(['org_summary', 'pay_by_level']);
    const roles = llm.requests[1]!.messages.slice(-3).map((m) => m.role);
    expect(roles).toEqual(['assistant', 'tool', 'tool']);
  });

  it('maps HTTP 429 from the provider to the friendly "busy" error', async () => {
    const { db } = seeded();
    const llm = fakeLlm([{ throw: httpError(429, 'Rate limit reached for model') }]);
    const events: AssistantEvent[] = [];
    const result = await createAssistantService({ db, llm: llm.client }).chat(ask('hi'), { onEvent: (e) => events.push(e) });
    expect(result).toEqual({ ok: false, code: 'LLM_BUSY', message: BUSY_MESSAGE, toolsUsed: [] });
    expect(BUSY_MESSAGE).toBe('The AI assistant is busy, please try again in a minute.');
    expect(events).toEqual([{ type: 'error', code: 'LLM_BUSY', message: BUSY_MESSAGE }]);
  });

  it('maps other provider failures without leaking details', async () => {
    const { db } = seeded();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const svc = (err: unknown) => createAssistantService({ db, llm: fakeLlm([{ throw: err }]).client }).chat(ask('hi'));
    expect(await svc(httpError(401))).toMatchObject({ ok: false, code: 'LLM_AUTH' });
    expect(await svc(httpError(413))).toMatchObject({ ok: false, code: 'LLM_TOO_LARGE' });
    expect(await svc(httpError(404, 'model_not_found'))).toMatchObject({
      ok: false, code: 'LLM_MODEL_UNAVAILABLE', message: expect.stringMatching(/"fake-model" is not available.*LLM_MODEL/),
    });
    const generic = await svc(new Error('socket hang up at 10.0.0.1'));
    expect(generic).toMatchObject({ ok: false, code: 'LLM_ERROR' });
    expect(generic.ok === false && generic.message).not.toContain('10.0.0.1');
    spy.mockRestore();
  });

  it('sends only the most recent messages to the model', async () => {
    const { db } = seeded();
    const llm = fakeLlm([{ text: 'ok' }]);
    const history = Array.from({ length: 15 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}` }));
    await createAssistantService({ db, llm: llm.client }).chat(history);
    const sent = llm.requests[0]!.messages.slice(1).map((m) => m.content);
    expect(sent).toEqual(history.slice(-10).map((m) => m.content));
  });
});
