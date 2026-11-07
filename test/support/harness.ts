import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createCloudApiClient } from '../../src/cloud-api-client.js';
import { createHonestReceptionist } from '../../src/honest/receptionist.js';
import { createSimulatedLlm } from '../../src/llm/simulated.js';
import { createNaiveReceptionist } from '../../src/naive/receptionist.js';
import type { Receptionist } from '../../src/receptionist.js';
import { createReceiver } from '../../src/server.js';
import { startFakeCloudApi, type FakeCloudApi } from './fake-cloud-api.js';
import { startFakeLlm, type FakeLlm } from './fake-llm.js';

export type Side = 'honest' | 'naive';

export const APP_SECRET = 'test-app-secret';
export const VERIFY_TOKEN = 'test-verify-token';
export const CLOUD_TOKEN = 'test-cloud-token';
export const PHONE_NUMBER_ID = '106540352242922';
/** Arbitrary in the tests; the live script takes the real one from GRAPH_API_VERSION. */
export const GRAPH_VERSION = '23.0';
export const TEMPLATE_NAME = 'booking_reminder';
export const TEMPLATE_LANGUAGE = 'en_US';
export const CUSTOMER = '5491155550101';

/** Monday 2026-11-09 12:00 UTC: "book tuesday 15:00" resolves to 2026-11-10 15:00. */
export const T0 = new Date('2026-11-09T12:00:00Z');
export const minutes = (n: number) => n * 60_000;
export const hours = (n: number) => n * 3_600_000;

/** One per test file: the fake LLM, the fake Cloud API, a shared clock and a temp dir for databases. */
export interface World {
  llm: FakeLlm;
  cloud: FakeCloudApi;
  clock: { now: Date; set(d: Date): void };
  tempRoot: string;
  newDbPath(): string;
  close(): Promise<void>;
}

export async function startWorld(): Promise<World> {
  const clock = {
    now: T0,
    set(d: Date) {
      clock.now = d;
    },
  };
  const llm = await startFakeLlm();
  const cloud = await startFakeCloudApi({
    version: GRAPH_VERSION,
    phoneNumberId: PHONE_NUMBER_ID,
    token: CLOUD_TOKEN,
    appSecret: APP_SECRET,
    now: () => clock.now,
  });
  const tempRoot = mkdtempSync(join(tmpdir(), 'cloud-api-booking-'));
  let n = 0;
  return {
    llm,
    cloud,
    clock,
    tempRoot,
    newDbPath: () => join(tempRoot, `ledger-${++n}.db`),
    close: async () => {
      await llm.close();
      await cloud.close();
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** Process-wide options shared by the in-process receptionist and the receiver child process. */
export function cloudClientOptions(cloudUrl: string) {
  return { baseUrl: cloudUrl, version: GRAPH_VERSION, phoneNumberId: PHONE_NUMBER_ID, token: CLOUD_TOKEN };
}

export interface Running {
  side: Side;
  receptionist: Receptionist;
  url: string;
  dbPath: string;
  /** Run a read-only query against this side's database. */
  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): Promise<void>;
}

/** A receptionist and its receiver, in this process, wired to the world's fakes. */
export async function startSide(
  world: World,
  side: Side,
  opts: { appSecret?: string | null; llmTimeoutMs?: number } = {},
): Promise<Running> {
  world.llm.reset();
  world.cloud.reset();
  world.clock.set(T0);
  const dbPath = world.newDbPath();
  const options = {
    dbPath,
    llm: createSimulatedLlm({ url: world.llm.url, timeoutMs: opts.llmTimeoutMs ?? 2_000 }),
    cloud: createCloudApiClient(cloudClientOptions(world.cloud.url)),
    now: () => world.clock.now,
    templateName: TEMPLATE_NAME,
    templateLanguage: TEMPLATE_LANGUAGE,
  };
  const receptionist = side === 'honest' ? createHonestReceptionist(options) : createNaiveReceptionist(options);
  const appSecret = opts.appSecret === null ? undefined : (opts.appSecret ?? APP_SECRET);
  const server = createReceiver({ receptionist, appSecret, verifyToken: VERIFY_TOKEN });
  const url = await listen(server);
  world.cloud.setReceiver(url);
  return {
    side,
    receptionist,
    url,
    dbPath,
    rows: (sql, ...params) => readRows(dbPath, sql, params),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      receptionist.close();
    },
  };
}

export function readRows<T>(dbPath: string, sql: string, params: unknown[] = []): T[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

export function count(run: { rows: Running['rows'] }, table: string): number {
  return (run.rows<{ n: number }>(`select count(*) as n from ${table}`)[0]!).n;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}
