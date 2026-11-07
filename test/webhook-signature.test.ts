import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { sign } from '../src/signature.js';
import { APP_SECRET, count, CUSTOMER, startSide, startWorld, T0, VERIFY_TOKEN, type World } from './support/harness.js';

// S1: the GET verification handshake, and the signature of every POST checked over the raw
// bytes before anything else happens. A rejected POST leaves no inbox row, makes no LLM request
// and sends no message.

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(async () => {
  await world.close();
});

async function honest(opts: { appSecret?: string | null } = {}) {
  const run = await startSide(world, 'honest', opts);
  onTestFinished(() => run.close());
  return run;
}

const body = () => world.cloud.inboundPayload({ from: CUSTOMER, text: 'book tuesday 15:00', at: T0, id: 'wamid.SIG000001' });

describe('GET /webhook verification', () => {
  it('answers 200 with hub.challenge as the body when mode is subscribe and the token matches', async () => {
    const run = await honest();
    const res = await fetch(`${run.url}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1158201444');
  });

  it.each([
    ['wrong token', `hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`],
    ['missing token', `hub.mode=subscribe&hub.challenge=42`],
    ['mode other than subscribe', `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`],
  ])('answers 403 on a %s and echoes nothing', async (_name, query) => {
    const run = await honest();
    const res = await fetch(`${run.url}/webhook?${query}`);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('');
    expect(count(run, 'inbox')).toBe(0);
  });
});

describe('POST /webhook signature', () => {
  it('accepts a correctly signed delivery (baseline for the rejections below)', async () => {
    const run = await honest();
    const raw = body();
    expect(await world.cloud.deliverRaw(raw, sign(APP_SECRET, raw))).toBe(200);
    expect(count(run, 'inbox')).toBe(1);
    expect(world.llm.requests()).toBe(1);
  });

  it.each([
    ['missing header', (raw: Buffer) => [raw, undefined] as const],
    ['empty header', (raw: Buffer) => [raw, ''] as const],
    ['wrong hmac', (raw: Buffer) => [raw, `sha256=${'0'.repeat(64)}`] as const],
    ['body changed after signing', (raw: Buffer) => [Buffer.from(raw.toString().replace('15:00', '16:00')), sign(APP_SECRET, raw)] as const],
    ['signed with another secret', (raw: Buffer) => [raw, sign('another-secret', raw)] as const],
    ['header without the sha256= prefix', (raw: Buffer) => [raw, sign(APP_SECRET, raw).slice('sha256='.length)] as const],
  ])('rejects %s with 401: no inbox row, 0 LLM requests, 0 messages sent', async (_name, forge) => {
    const run = await honest();
    const [raw, signature] = forge(body());
    expect(await world.cloud.deliverRaw(raw, signature)).toBe(401);
    expect(count(run, 'inbox')).toBe(0);
    expect(count(run, 'llm_calls')).toBe(0);
    expect(world.llm.requests()).toBe(0);
    expect(world.cloud.sends).toHaveLength(0);
  });

  it('a receiver with no APP_SECRET configured accepts nothing, not even a delivery signed with an empty key', async () => {
    const run = await honest({ appSecret: null });
    const raw = body();
    for (const signature of [sign(APP_SECRET, raw), sign('', raw)]) {
      expect(await world.cloud.deliverRaw(raw, signature)).toBe(401);
    }
    expect(count(run, 'inbox')).toBe(0);
    expect(world.llm.requests()).toBe(0);
    expect(world.cloud.sends).toHaveLength(0);
  });
});
