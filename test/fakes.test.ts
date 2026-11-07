import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCloudApiClient } from '../src/cloud-api-client.js';
import { LlmCallError } from '../src/llm/provider.js';
import { createSimulatedLlm } from '../src/llm/simulated.js';
import { parseIntent } from './support/fake-llm.js';
import { cloudClientOptions, CUSTOMER, GRAPH_VERSION, PHONE_NUMBER_ID, startWorld, T0, type World } from './support/harness.js';

// The fakes are part of the evidence, so their own behaviour is pinned: what the simulated LLM
// bills for each fault, and the request/response shapes the fake Cloud API speaks.

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(async () => {
  await world.close();
});

const input = { text: 'book 2026-11-12 9:30', from: CUSTOMER, nowIso: T0.toISOString() };

describe('simulated LLM', () => {
  it('parses "book <weekday|date> <HH:MM> [for <name>]" deterministically', () => {
    expect(parseIntent({ ...input, text: 'book tuesday 15:00' })).toEqual({ kind: 'book', slot: '2026-11-10 15:00' });
    expect(parseIntent({ ...input, text: 'Book Monday 09:00 for Ana Diaz' })).toEqual({ kind: 'book', slot: '2026-11-16 09:00', name: 'Ana Diaz' });
    expect(parseIntent(input)).toEqual({ kind: 'book', slot: '2026-11-12 09:30' });
    expect(parseIntent({ ...input, text: 'what time do you open?' })).toEqual({ kind: 'other' });
  });

  it('bills per request; drop-after-charge bills and answers nothing; 500 does not bill', async () => {
    world.llm.reset();
    const llm = createSimulatedLlm({ url: world.llm.url, timeoutMs: 300 });
    await expect(llm.extractIntent(input, { callKey: 'k:1' })).resolves.toEqual({ kind: 'book', slot: '2026-11-12 09:30' });
    world.llm.failNext('drop-after-charge', '500', 'delay 1000');
    await expect(llm.extractIntent(input, { callKey: 'k:2' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(llm.extractIntent(input, { callKey: 'k:3' })).rejects.toMatchObject({ outcome: 'rejected' });
    await expect(llm.extractIntent(input, { callKey: 'k:4' })).rejects.toBeInstanceOf(LlmCallError); // timed out: unknown
    expect(world.llm.requests()).toBe(4);
    expect(world.llm.billedKeys()).toEqual(['k:1', 'k:2', 'k:4']);
  });
});

describe('fake Cloud API', () => {
  it('answers a text with the documented success body and a wamid. id', async () => {
    world.cloud.reset();
    world.clock.set(T0);
    world.cloud.noteInbound(CUSTOMER, T0);
    const res = await fetch(`${world.cloud.url}/v${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-cloud-token', 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: CUSTOMER, type: 'text', text: { preview_url: false, body: 'hi' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ messaging_product: 'whatsapp', contacts: [{ input: CUSTOMER, wa_id: CUSTOMER }], messages: [{ id: expect.stringMatching(/^wamid\./) }] });
  });

  it('answers a text past 24 h with the documented error body, code 131047, type OAuthException', async () => {
    world.cloud.reset();
    world.clock.set(new Date(T0.getTime() + 25 * 3_600_000));
    world.cloud.noteInbound(CUSTOMER, T0);
    const client = createCloudApiClient(cloudClientOptions(world.cloud.url));
    const result = await client.sendText(CUSTOMER, 'late');
    expect(result).toMatchObject({ kind: 'error', status: 400, code: 131047 });
    const raw = await fetch(`${world.cloud.url}/v${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-cloud-token', 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: CUSTOMER, type: 'text', text: { body: 'late' } }),
    }).then((r) => r.json());
    expect(raw.error).toMatchObject({
      code: 131047,
      type: 'OAuthException',
      message: expect.any(String),
      error_data: { messaging_product: 'whatsapp', details: expect.any(String) },
      fbtrace_id: expect.any(String),
    });
    world.clock.set(T0);
  });

  it('refuses a request without the right Bearer token', async () => {
    world.cloud.reset();
    const client = createCloudApiClient({ ...cloudClientOptions(world.cloud.url), token: 'wrong' });
    expect(await client.sendTemplate(CUSTOMER, { name: 't', language: 'en_US', params: [] })).toMatchObject({ kind: 'error', status: 401 });
    expect(world.cloud.sends).toHaveLength(0);
  });
});
