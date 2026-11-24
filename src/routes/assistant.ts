import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { rateLimit, type RateLimitOptions } from '../lib/rate-limit';
import type { AssistantEvent, AssistantService } from '../services/assistant-service';

export const chatBodySchema = z.object({
  messages: z
    .array(
      z
        .object({
          role: z.enum(['user', 'assistant']),
          content: z.string().trim().min(1, 'Message is empty').max(2000, 'Message is too long (max 2000 characters)'),
        })
        .strict(),
    )
    .min(1, 'At least one message is required')
    .max(20, 'Too many messages (max 20). Start a new chat.')
    .refine((m) => m.at(-1)?.role === 'user', 'The last message must be from the user'),
});

class AssistantDisabledError extends AppError {
  constructor() {
    super(503, 'ASSISTANT_DISABLED', 'The AI assistant is not configured. Set LLM_API_KEY on the server to enable it.');
  }
}

/** SSE frame: `event: <type>` + JSON payload. */
function frame({ type, ...payload }: AssistantEvent): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function assistantRouter(service: AssistantService | null, limits: RateLimitOptions = { max: 20, windowMs: 60_000 }): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    res.json({ enabled: service !== null, model: service?.model ?? '' });
  });

  /**
   * Streams the answer as Server-Sent Events: tool_call, text_delta, done, error.
   * The body is validated before the stream starts, so bad requests get a normal JSON 400.
   */
  router.post('/chat', rateLimit(limits), async (req, res) => {
    if (!service) throw new AssistantDisabledError();
    const { messages } = chatBodySchema.parse(req.body);

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't let proxies buffer the stream
    });
    res.flushHeaders();

    // Stop calling the model (and spending quota) if the browser goes away.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    await service.chat(messages, {
      signal: abort.signal,
      onEvent: (event) => {
        if (abort.signal.aborted) return;
        res.write(frame(event));
      },
    });
    res.end();
  });

  return router;
}
