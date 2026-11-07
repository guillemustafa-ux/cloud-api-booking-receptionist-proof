/**
 * The receiver as a process: `node --import tsx src/main.ts`. Configuration from the environment
 * (or a git-ignored `.env.local`). Prints `listening on <url>` once it accepts requests.
 *
 *   SIDE=honest|naive   which receptionist (default honest)
 *   DB_PATH             SQLite file (one receiver process per file)
 *   LLM=simulated|claude, LLM_URL, ANTHROPIC_API_KEY (required with LLM=claude), ANTHROPIC_MODEL
 *   GRAPH_API_VERSION, PHONE_NUMBER_ID, CLOUD_API_TOKEN   required
 *   CLOUD_API_BASE_URL, APP_SECRET, VERIFY_TOKEN, TEMPLATE_NAME, TEMPLATE_LANGUAGE, PORT
 *   FAULT=after_inbox   kill this process with SIGKILL right after the inbox insert (tests only)
 *   FAULT=after_charge  kill this process with SIGKILL right after the LLM answered (tests only)
 *
 * An unknown SIDE, LLM or FAULT, or a missing required variable, stops the process with
 * `startup failed: ...` before it opens the database or listens.
 */
import type { AddressInfo } from 'node:net';
import { createCloudApiClient } from './cloud-api-client.js';
import { CRASH_POINTS } from './crash.js';
import { env, envOneOf, envRequired, loadEnvLocal } from './env.js';
import { createHonestReceptionist } from './honest/receptionist.js';
import { createClaudeLlm } from './llm/claude.js';
import type { LlmProvider } from './llm/provider.js';
import { createSimulatedLlm } from './llm/simulated.js';
import { createNaiveReceptionist } from './naive/receptionist.js';
import { SIDES, type Receptionist, type ReceptionistOptions, type Side } from './receptionist.js';
import { createReceiver } from './server.js';

loadEnvLocal();

let receptionist: Receptionist;
let side: Side;
let appSecret: string | undefined;
let verifyToken: string | undefined;
try {
  // Every setting is validated before anything opens a file or a port: a typo must not start a
  // receiver that answers 200 with a different configuration than the one asked for.
  side = envOneOf('SIDE', SIDES, 'honest');
  const llmKind = envOneOf('LLM', ['simulated', 'claude'] as const, 'simulated');
  const fault = env('FAULT') ? envOneOf('FAULT', CRASH_POINTS, CRASH_POINTS[0]) : undefined;
  const cloud = createCloudApiClient({
    baseUrl: env('CLOUD_API_BASE_URL', 'https://graph.facebook.com'),
    version: envRequired('GRAPH_API_VERSION').replace(/^v/, ''),
    phoneNumberId: envRequired('PHONE_NUMBER_ID'),
    token: envRequired('CLOUD_API_TOKEN'),
  });
  const llm: LlmProvider =
    llmKind === 'claude'
      ? createClaudeLlm({ apiKey: envRequired('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL') })
      : createSimulatedLlm({ url: env('LLM_URL', 'http://127.0.0.1:8788') });
  const options: ReceptionistOptions = {
    dbPath: env('DB_PATH', 'receptionist.db'),
    llm,
    cloud,
    templateName: env('TEMPLATE_NAME', 'booking_reminder'),
    templateLanguage: env('TEMPLATE_LANGUAGE', 'en_US'),
    fault,
  };
  appSecret = env('APP_SECRET') || undefined;
  verifyToken = env('VERIFY_TOKEN') || undefined;
  receptionist = side === 'naive' ? createNaiveReceptionist(options) : createHonestReceptionist(options);
} catch (err) {
  process.stderr.write(`startup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const server = createReceiver({ receptionist, appSecret, verifyToken, label: side });

server.listen(Number(env('PORT', '0')), '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  console.log(`listening on http://127.0.0.1:${port}`);
});

const stop = () => server.close(() => {
  receptionist.close();
  process.exit(0);
});
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
