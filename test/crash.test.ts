import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { inspectDb } from '../src/honest/inspect.js';
import { CUSTOMER, readRows, startWorld, type Side, type World } from './support/harness.js';
import { killedBySigkill, startReceiverProcess } from './support/receiver-process.js';

// S2 (d): the receiver process is killed for real (SIGKILL, separate process) after the LLM
// billed and before the booking is written. The same POST is then redelivered to a fresh process
// on the same database file. No exception stands in for the crash: nothing after that point runs.

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(async () => {
  await world.close();
});

const MESSAGE_ID = 'wamid.HBgLCRASH00001';

async function crashThenRedeliver(side: Side) {
  world.llm.reset();
  world.cloud.reset();
  const dbPath = world.newDbPath();
  const base = { side, dbPath, llmUrl: world.llm.url, cloudUrl: world.cloud.url };

  const doomed = await startReceiverProcess({ ...base, fault: 'after_charge' });
  world.cloud.setReceiver(doomed.url);
  // The receiver runs on the real clock, so the message is "now": its reply is inside the window.
  world.clock.set(new Date());
  const first = await world.cloud.deliverInbound({ from: CUSTOMER, text: 'book tuesday 15:00', at: new Date(), id: MESSAGE_ID });
  const death = await doomed.exited;

  const fresh = await startReceiverProcess(base);
  onTestFinished(async () => {
    await fresh.stop();
  });
  world.cloud.setReceiver(fresh.url);
  const second = await world.cloud.redeliver(first);
  await fresh.stop();
  const rows = <T>(sql: string) => readRows<T>(dbPath, sql);
  return { first, second, death, dbPath, rows };
}

describe('(d) receiver process killed after the LLM billed, before the booking was written', () => {
  it('(d) honest: call unknown, message unconfirmed, 0 additional charges, 0 bookings, visible in inspect', async () => {
    const r = await crashThenRedeliver('honest');
    expect(r.death.crashedAt).toBe('after_charge');
    expect(killedBySigkill(r.death)).toBe(true);
    expect(r.first.status).toBe(0); // the connection died with the process: Meta would retry

    expect(r.second.status).toBe(200);
    expect(world.llm.charges()).toBe(1); // the one charge made before the crash; none after
    expect(r.rows('select call_key, status from llm_calls')).toEqual([{ call_key: `${MESSAGE_ID}:1`, status: 'unknown' }]);
    expect(r.rows('select message_id, status, deliveries from inbox')).toEqual([{ message_id: MESSAGE_ID, status: 'unconfirmed', deliveries: 2 }]);
    expect(r.rows('select count(*) as n from bookings')).toEqual([{ n: 0 }]);
    expect(world.cloud.sends).toHaveLength(0);

    const report = inspectDb(r.dbPath);
    expect(report).toContain(`${MESSAGE_ID}:1`);
    expect(report).toMatch(new RegExp(`${MESSAGE_ID}\\s+${CUSTOMER}\\s+unconfirmed`));
  });

  it('(d) naive: the redelivery pays again and books: 2 charges, 1 booking, 1 reply', async () => {
    const r = await crashThenRedeliver('naive');
    expect(r.death.crashedAt).toBe('after_charge');
    expect(killedBySigkill(r.death)).toBe(true);
    expect(r.second.status).toBe(200);
    expect(world.llm.charges()).toBe(2);
    expect(r.rows('select count(*) as n from bookings')).toEqual([{ n: 1 }]);
    expect(world.cloud.sends.filter((m) => m.outcome === 'accepted')).toHaveLength(1);
  });
});
