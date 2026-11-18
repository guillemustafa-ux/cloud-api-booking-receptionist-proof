import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { createClaudeLlm, DEFAULT_ANTHROPIC_MODEL } from '../src/llm/claude.js';
import { LlmCallError } from '../src/llm/provider.js';
import { CUSTOMER, startSide, startWorld, T0, type World } from './support/harness.js';

// The Claude adapter, driven against a local HTTP server that answers like the Messages API.
// No key and no network: the SDK is pointed at 127.0.0.1 with `baseURL`. What is pinned here is
// the adapter's own reading of a response, not Claude's behaviour.

interface Seen {
  body: any;
}

async function fakeMessagesApi(
  answers: { status: number; body: unknown }[],
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    seen.push({ body: JSON.parse(await readBody(req)) });
    const answer = answers.shift() ?? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'no answer queued' } } };
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const llm = createClaudeLlm({
    apiKey: 'test-key-not-real',
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ...(onUsage && { onUsage }),
  });
  return { llm, seen };
}

const message = (stop_reason: string, content: unknown[]) => ({
  status: 200,
  body: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_ANTHROPIC_MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});
const input = { text: "Could I book Tuesday at 3pm? I'm Ana.", from: CUSTOMER, nowIso: T0.toISOString() };

describe('Claude adapter', () => {
  it('reads the propose_booking call as the intent; the request uses one strict tool with auto tool choice', async () => {
    const { llm, seen } = await fakeMessagesApi([
      message('tool_use', [
        { type: 'tool_use', id: 'toolu_1', name: 'propose_booking', input: { kind: 'book', slot: '2026-11-10 15:00', name: 'Ana' } },
      ]),
    ]);
    await expect(llm.extractIntent(input)).resolves.toEqual({ kind: 'book', slot: '2026-11-10 15:00', name: 'Ana' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toMatchObject({
      model: DEFAULT_ANTHROPIC_MODEL,
      tool_choice: { type: 'auto' },
      tools: [{ name: 'propose_booking', strict: true }],
    });
  });

  it.each([
    ['refusal', 'stop_reason=refusal; no propose_booking call'],
    ['end_turn', 'stop_reason=end_turn; no propose_booking call'],
  ])('a %s without the tool call is read as other, with a note saying why', async (stopReason, note) => {
    const { llm } = await fakeMessagesApi([message(stopReason, [{ type: 'text', text: 'I cannot help with that.' }])]);
    await expect(llm.extractIntent(input)).resolves.toEqual({ kind: 'other', note });
  });

  it('a 500 is one request, not retried by the SDK, reported as rejected', async () => {
    const { llm, seen } = await fakeMessagesApi([{ status: 500, body: { type: 'error', error: { type: 'api_error', message: 'boom' } } }]);
    const err = await llm.extractIntent(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).outcome).toBe('rejected');
    expect(seen).toHaveLength(1);
  });

  it('reports the tokens of a response that arrived through onUsage, and none for a failed request', async () => {
    const usage: unknown[] = [];
    const ok = await fakeMessagesApi([message('end_turn', [{ type: 'text', text: 'hi' }])], (u) => usage.push(u));
    await ok.llm.extractIntent(input);
    expect(usage).toEqual([{ inputTokens: 10, outputTokens: 5 }]);

    const failing = await fakeMessagesApi([{ status: 500, body: { type: 'error', error: { type: 'api_error', message: 'boom' } } }], (u) => usage.push(u));
    await failing.llm.extractIntent(input).catch(() => undefined);
    expect(usage).toHaveLength(1);
  });
});

describe('the ledger keeps the note', () => {
  let world: World;
  beforeAll(async () => {
    world = await startWorld();
  });
  afterAll(async () => {
    await world.close();
  });

  it('honest: an other read from a refusal is stored as intent other with the note beside it', async () => {
    const run = await startSide(world, 'honest', {
      llm: { extractIntent: async () => ({ kind: 'other', note: 'stop_reason=refusal; no propose_booking call' }) },
    });
    onTestFinished(() => run.close());
    expect((await world.cloud.deliverInbound({ from: CUSTOMER, text: 'something', at: T0, id: 'wamid.HBgLNOTE00001' })).status).toBe(200);
    expect(run.rows('select status, intent_json, note from llm_calls')).toEqual([
      { status: 'done', intent_json: '{"kind":"other"}', note: 'stop_reason=refusal; no propose_booking call' },
    ]);
  });
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
