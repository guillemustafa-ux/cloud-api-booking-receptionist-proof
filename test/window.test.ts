import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { inspectDb } from '../src/honest/inspect.js';
import { RE_ENGAGEMENT_DETAILS } from './support/fake-cloud-api.js';
import { count, CUSTOMER, hours, minutes, signedDelivery, startSide, startWorld, T0, TEMPLATE_LANGUAGE, TEMPLATE_NAME, type Running, type Side, type World } from './support/harness.js';

// S3: inside the 24-hour customer service window the receptionist sends a free-form text;
// outside it, the approved template. Error 131047 is handled on both documented paths
// (a synchronous Graph API error and a failed `statuses` webhook) and stays visible.

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(async () => {
  await world.close();
});

const SLOT = '2026-11-10 15:00';
const REMINDER = `Reminder: your booking is on ${SLOT}.`;
const TEMPLATE = { name: TEMPLATE_NAME, language: TEMPLATE_LANGUAGE, params: [SLOT] };

/** A side with one booking made from a customer message at T0 (its reply already sent). */
async function booked(s: Side): Promise<Running> {
  const run = await startSide(world, s);
  onTestFinished(() => run.close());
  expect((await world.cloud.deliverInbound({ from: CUSTOMER, text: 'book tuesday 15:00', at: T0 })).status).toBe(200);
  expect(world.cloud.sends).toMatchObject([{ type: 'text', outcome: 'accepted' }]);
  return run;
}

const after = (ms: number) => world.clock.set(new Date(T0.getTime() + ms));
const sendsAfterReply = () => world.cloud.sends.slice(1);

/**
 * The receiver's own record says the window is still open while Meta's view says it closed:
 * the test writes a later last_inbound_at into the receiver's database to create the disagreement.
 */
function receiverBelievesWindowOpen(run: Running) {
  const db = new Database(run.dbPath);
  db.prepare('update conversations set last_inbound_at = ? where wa_id = ?').run(new Date(T0.getTime() + hours(20)).toISOString(), CUSTOMER);
  db.close();
}

describe('(h)-(i) the window decides text or template', () => {
  it('(h) honest: a reminder 23 h 59 m after the last inbound message goes out as text', async () => {
    const run = await booked('honest');
    after(hours(23) + minutes(59));
    await run.receptionist.sendReminders();
    expect(sendsAfterReply()).toEqual([{ to: CUSTOMER, type: 'text', body: REMINDER, outcome: 'accepted', wamid: expect.stringMatching(/^wamid\./) }]);
    expect(run.rows(`select type, status from outbound where kind = 'reminder'`)).toEqual([{ type: 'text', status: 'sent' }]);
  });

  it('(i) honest: a reminder 24 h 01 m after goes out as the template, the slot as its body parameter', async () => {
    const run = await booked('honest');
    after(hours(24) + minutes(1));
    await run.receptionist.sendReminders();
    expect(sendsAfterReply()).toEqual([{ to: CUSTOMER, type: 'template', template: TEMPLATE, outcome: 'accepted', wamid: expect.stringMatching(/^wamid\./) }]);
    expect(run.rows(`select type, template_name, body, status from outbound where kind = 'reminder'`)).toEqual([
      { type: 'template', template_name: TEMPLATE_NAME, body: SLOT, status: 'sent' },
    ]);
  });

  it('(h2) honest: 24 h minus 1 ms after the last inbound message is still inside: text', async () => {
    const run = await booked('honest');
    after(hours(24) - 1);
    await run.receptionist.sendReminders();
    expect(sendsAfterReply().map((m) => [m.type, m.outcome])).toEqual([['text', 'accepted']]);
  });

  it('(i2) honest: at exactly 24 h the window counts as closed: the template', async () => {
    const run = await booked('honest');
    after(hours(24));
    await run.receptionist.sendReminders();
    expect(sendsAfterReply().map((m) => [m.type, m.outcome])).toEqual([['template', 'accepted']]);
  });

  it('(i) naive: 24 h 01 m after it still sends text; the 131047 refusal throws and nothing records it', async () => {
    const run = await booked('naive');
    after(hours(24) + minutes(1));
    await expect(run.receptionist.sendReminders()).rejects.toThrow(/131047/);
    expect(sendsAfterReply()).toEqual([{ to: CUSTOMER, type: 'text', body: REMINDER, outcome: 'rejected-131047' }]);
    expect(run.rows(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`)).toEqual([{ name: 'bookings' }]);
  });

  it('(l) honest: last_inbound_at follows every inbound messages[].timestamp, and never moves back', async () => {
    const run = await booked('honest');
    const later = new Date(T0.getTime() + hours(2));
    await world.cloud.deliverInbound({ from: CUSTOMER, text: 'thanks', at: later });
    expect(run.rows('select last_inbound_at from conversations')).toEqual([{ last_inbound_at: later.toISOString() }]);
    await world.cloud.deliverInbound({ from: CUSTOMER, text: 'an older message delivered late', at: new Date(T0.getTime() + hours(1)) });
    expect(run.rows('select last_inbound_at from conversations')).toEqual([{ last_inbound_at: later.toISOString() }]);
  });
});

describe('(j) synchronous 131047: the Graph API answers 400', () => {
  it('(j) honest: the failed text is recorded with error_code 131047 and ONE template follows, linked by fallback_of', async () => {
    const run = await booked('honest');
    receiverBelievesWindowOpen(run);
    after(hours(25));
    await run.receptionist.sendReminders();

    expect(sendsAfterReply()).toEqual([
      { to: CUSTOMER, type: 'text', body: REMINDER, outcome: 'rejected-131047' },
      { to: CUSTOMER, type: 'template', template: TEMPLATE, outcome: 'accepted', wamid: expect.stringMatching(/^wamid\./) },
    ]);
    const [reminder] = run.rows<{ id: number }>(`select id from outbound where kind = 'reminder'`);
    expect(run.rows('select kind, type, status, error_code, body, fallback_of from outbound where id > 1 order by id')).toEqual([
      { kind: 'reminder', type: 'text', status: 'failed', error_code: 131047, body: REMINDER, fallback_of: null },
      { kind: 'fallback', type: 'template', status: 'sent', error_code: null, body: SLOT, fallback_of: reminder!.id },
    ]);
    expect(inspectDb(run.dbPath)).toMatch(/reminder\s+text\s+failed\s+131047/);

    await run.receptionist.sendReminders(); // the reminder exists: nothing more goes out
    expect(sendsAfterReply()).toHaveLength(2);
  });
});

describe('(k) asynchronous 131047: accepted, then a failed statuses webhook', () => {
  it('(k) honest: the row turns failed with 131047, ONE template follows, and a redelivered status sends no second one', async () => {
    const run = await booked('honest');
    world.cloud.setErrorMode('async');
    receiverBelievesWindowOpen(run);
    after(hours(25));
    await run.receptionist.sendReminders();
    expect(run.rows(`select status from outbound where kind = 'reminder'`)).toEqual([{ status: 'sent' }]);

    const [status] = await world.cloud.deliverPendingStatuses();
    expect(status!.status).toBe(200);
    expect((await world.cloud.redeliver(status!)).status).toBe(200);

    expect(sendsAfterReply().map((m) => [m.type, m.outcome])).toEqual([
      ['text', 'accepted-then-failed'],
      ['template', 'accepted'],
    ]);
    const [reminder] = run.rows<{ id: number }>(`select id from outbound where kind = 'reminder'`);
    expect(run.rows('select kind, type, status, error_code, fallback_of from outbound where id > 1 order by id')).toEqual([
      { kind: 'reminder', type: 'text', status: 'failed', error_code: 131047, fallback_of: null },
      { kind: 'fallback', type: 'template', status: 'sent', error_code: null, fallback_of: reminder!.id },
    ]);
    expect(count(run, 'outbound')).toBe(3);
  });

  it('(k) naive: the failed status is ignored: the customer gets nothing and nothing says so', async () => {
    const run = await booked('naive');
    world.cloud.setErrorMode('async');
    after(hours(25));
    await run.receptionist.sendReminders(); // resolves: the API accepted the text
    const [status] = await world.cloud.deliverPendingStatuses();
    expect(status!.status).toBe(200);
    expect(sendsAfterReply().map((m) => [m.type, m.outcome])).toEqual([['text', 'accepted-then-failed']]);
    expect(count(run, 'bookings')).toBe(1);
  });
});

describe('(o) a failed status for a message this ledger did not send', () => {
  it('(o) honest: it is recorded in orphan_statuses once, even when redelivered, and nothing is sent', async () => {
    const run = await booked('honest');
    const d = signedDelivery(world.cloud.failedStatusPayload('wamid.HBgLUNKNOWN0001', CUSTOMER));
    expect((await world.cloud.redeliver(d)).status).toBe(200);
    expect((await world.cloud.redeliver(d)).status).toBe(200);
    expect(run.rows('select wamid, status, error_code, error_title from orphan_statuses')).toEqual([
      { wamid: 'wamid.HBgLUNKNOWN0001', status: 'failed', error_code: 131047, error_title: RE_ENGAGEMENT_DETAILS },
    ]);
    expect(sendsAfterReply()).toHaveLength(0);
    expect(inspectDb(run.dbPath)).toMatch(/orphan_statuses\n.*\n.*\n\s+wamid\.HBgLUNKNOWN0001\s+failed\s+131047/);
  });
});
