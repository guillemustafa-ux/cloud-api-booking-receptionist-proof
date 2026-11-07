import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorld, type World } from './support/harness.js';
import { startReceiverProcess } from './support/receiver-process.js';

// The receiver process validates its configuration before it opens the database or listens:
// a typo in SIDE or LLM, or a missing Cloud API variable, must not start a receiver that answers
// 200 with a configuration nobody asked for.

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(async () => {
  await world.close();
});

async function startWith(extraEnv: Record<string, string>) {
  const dbPath = world.newDbPath();
  const error = await startReceiverProcess({ side: 'honest', dbPath, llmUrl: world.llm.url, cloudUrl: world.cloud.url, extraEnv }).then(
    async (running) => {
      await running.stop();
      throw new Error('the receiver started listening');
    },
    (err: Error) => err,
  );
  return { message: error.message, dbCreated: existsSync(dbPath) };
}

describe('start-up validation', () => {
  it.each([
    ['LLM', { LLM: 'Claude' }, 'unknown LLM Claude'],
    ['SIDE', { SIDE: 'nave' }, 'unknown SIDE nave'],
    ['FAULT', { FAULT: 'after_everything' }, 'unknown FAULT after_everything'],
  ])('an unknown %s value stops the process before it listens', async (_name, extraEnv, expected) => {
    const r = await startWith(extraEnv);
    expect(r.message).toContain(`startup failed: ${expected}`);
    expect(r.message).toMatch(/exited before listening \(code 1\)/);
    expect(r.message).not.toMatch(/listening on http/);
    expect(r.dbCreated).toBe(false);
  });

  it.each(['GRAPH_API_VERSION', 'PHONE_NUMBER_ID', 'CLOUD_API_TOKEN'])(
    'a missing %s stops the process before it listens',
    async (name) => {
      const r = await startWith({ [name]: '' });
      expect(r.message).toContain(`startup failed: missing required environment variable ${name}`);
      expect(r.message).not.toMatch(/listening on http/);
      expect(r.dbCreated).toBe(false);
    },
  );
});
