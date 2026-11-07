import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { count, CUSTOMER, signedDelivery, startSide, startWorld, T0, type Side, type World } from './support/harness.js';

// S2: a redelivered webhook neither books twice nor pays the LLM twice. Every scenario runs the
// honest receptionist and its naive twin through the same signed HTTP deliveries and asserts what
// the fake LLM billed, what the database holds and what the fake Cloud API was asked to send.

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(async () => {
  await world.close();
});

async function side(s: Side, opts: { llmTimeoutMs?: number } = {}) {
  const run = await startSide(world, s, opts);
  onTestFinished(() => run.close());
  return run;
}

const BOOK = { from: CUSTOMER, text: 'book tuesday 15:00 for Ana', at: T0, id: 'wamid.HBgLIN000001' };
// Replies are texts the fake Cloud API accepted; a refused text or a fallback template is not a reply here.
const replies = () => world.cloud.sends.filter((m) => m.type === 'text' && m.outcome === 'accepted');

describe('(a) one inbound booking request', () => {
  it('(a) honest: 1 charge, 1 booking, 1 reply as text', async () => {
    const run = await side('honest');
    const d = await world.cloud.deliverInbound(BOOK);
    expect(d.status).toBe(200);
    expect(world.llm.charges()).toBe(1);
    expect(world.llm.billedKeys()).toEqual(['wamid.HBgLIN000001:1']);
    expect(run.rows('select inbound_message_id, slot, name from bookings')).toEqual([
      { inbound_message_id: 'wamid.HBgLIN000001', slot: '2026-11-10 15:00', name: 'Ana' },
    ]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatchObject({ type: 'text', body: 'Booked: 2026-11-10 15:00 for Ana. Reply here if you need to change it.' });
    expect(run.rows('select status, deliveries from inbox')).toEqual([{ status: 'done', deliveries: 1 }]);
    expect(run.rows('select kind, type, status from outbound')).toEqual([{ kind: 'reply', type: 'text', status: 'sent' }]);
  });

  it('(a) naive: 1 charge, 1 booking, 1 reply', async () => {
    const run = await side('naive');
    expect((await world.cloud.deliverInbound(BOOK)).status).toBe(200);
    expect(world.llm.charges()).toBe(1);
    expect(count(run, 'bookings')).toBe(1);
    expect(replies()).toHaveLength(1);
  });
});

describe('(b) the same POST, same bytes and signature, delivered 5 times', () => {
  async function fiveTimes() {
    const first = await world.cloud.deliverInbound(BOOK);
    const statuses = [first.status];
    for (let i = 0; i < 4; i++) statuses.push((await world.cloud.redeliver(first)).status);
    return statuses;
  }

  it('(b) honest: 1 charge, 1 booking, 1 reply; the inbox row counts 5 deliveries', async () => {
    const run = await side('honest');
    const statuses = await fiveTimes();
    expect(world.llm.charges()).toBe(1);
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    expect(count(run, 'bookings')).toBe(1);
    expect(replies()).toHaveLength(1);
    expect(run.rows('select deliveries from inbox')).toEqual([{ deliveries: 5 }]);
    expect(count(run, 'llm_calls')).toBe(1);
  });

  it('(b) naive: 5 charges, 5 bookings, 5 replies', async () => {
    const run = await side('naive');
    expect(await fiveTimes()).toEqual([200, 200, 200, 200, 200]);
    expect(world.llm.charges()).toBe(5);
    expect(count(run, 'bookings')).toBe(5);
    expect(replies()).toHaveLength(5);
  });
});

describe('(c) two simultaneous deliveries of the same POST', () => {
  async function both() {
    world.cloud.noteInbound(BOOK.from, BOOK.at);
    const d = signedDelivery(world.cloud.inboundPayload(BOOK));
    return (await Promise.all([world.cloud.redeliver(d), world.cloud.redeliver(d)])).map((r) => r.status);
  }

  it('(c) honest: 1 charge, 1 booking, 1 reply', async () => {
    const run = await side('honest');
    const statuses = await both();
    expect(world.llm.charges()).toBe(1);
    expect(statuses).toEqual([200, 200]);
    expect(count(run, 'bookings')).toBe(1);
    expect(replies()).toHaveLength(1);
    expect(run.rows('select deliveries from inbox')).toEqual([{ deliveries: 2 }]);
  });

  it('(c) naive: 2 charges, 2 bookings, 2 replies', async () => {
    const run = await side('naive');
    expect(await both()).toEqual([200, 200]);
    expect(world.llm.charges()).toBe(2);
    expect(count(run, 'bookings')).toBe(2);
    expect(replies()).toHaveLength(2);
  });
});

describe('(e) the LLM bills, then the connection drops before the answer', () => {
  it('(e) honest: 1 charge, call unknown, message unconfirmed, 0 bookings; the redelivery pays nothing', async () => {
    const run = await side('honest');
    world.llm.failNext('drop-after-charge');
    const first = await world.cloud.deliverInbound(BOOK);
    expect(first.status).toBe(200);
    expect((await world.cloud.redeliver(first)).status).toBe(200);
    expect(world.llm.charges()).toBe(1);
    expect(run.rows('select call_key, status from llm_calls')).toEqual([{ call_key: 'wamid.HBgLIN000001:1', status: 'unknown' }]);
    expect(run.rows('select status, deliveries from inbox')).toEqual([{ status: 'unconfirmed', deliveries: 2 }]);
    expect(count(run, 'bookings')).toBe(0);
    expect(world.cloud.sends).toHaveLength(0);
  });

  it('(e) naive: the first delivery answers 500, the redelivery pays again: 2 charges, 1 booking', async () => {
    const run = await side('naive');
    world.llm.failNext('drop-after-charge');
    const first = await world.cloud.deliverInbound(BOOK);
    expect(first.status).toBe(500);
    expect((await world.cloud.redeliver(first)).status).toBe(200);
    expect(world.llm.charges()).toBe(2);
    expect(count(run, 'bookings')).toBe(1);
    expect(replies()).toHaveLength(1);
  });
});

describe('(f) the LLM answers 500 (not billed), then succeeds', () => {
  it('(f) honest: attempt 1 failed, attempt 2 done, 1 charge, 1 booking', async () => {
    const run = await side('honest');
    world.llm.failNext('500');
    expect((await world.cloud.deliverInbound(BOOK)).status).toBe(200);
    expect(world.llm.requests()).toBe(2);
    expect(world.llm.charges()).toBe(1);
    expect(run.rows('select call_key, status from llm_calls order by attempt')).toEqual([
      { call_key: 'wamid.HBgLIN000001:1', status: 'failed' },
      { call_key: 'wamid.HBgLIN000001:2', status: 'done' },
    ]);
    expect(count(run, 'bookings')).toBe(1);
    expect(replies()).toHaveLength(1);
  });

  it('(f) naive: answers 500, the redelivery succeeds: 1 charge, 1 booking', async () => {
    const run = await side('naive');
    world.llm.failNext('500');
    const first = await world.cloud.deliverInbound(BOOK);
    expect(first.status).toBe(500);
    expect((await world.cloud.redeliver(first)).status).toBe(200);
    expect(world.llm.charges()).toBe(1);
    expect(count(run, 'bookings')).toBe(1);
  });
});

describe('(g) defense in depth', () => {
  it('(g) honest: the database refuses a second booking for the same inbound message', async () => {
    const run = await side('honest');
    await world.cloud.deliverInbound(BOOK);
    const db = new Database(run.dbPath);
    onTestFinished(() => void db.close());
    const insert = () =>
      db
        .prepare('insert into bookings (inbound_message_id, wa_id, slot, created_at) values (?, ?, ?, ?)')
        .run('wamid.HBgLIN000001', CUSTOMER, '2026-11-10 16:00', T0.toISOString());
    expect(insert).toThrow(/UNIQUE constraint failed: bookings.inbound_message_id/);
    expect(count(run, 'bookings')).toBe(1);
  });
});
