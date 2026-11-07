/**
 * The receiver as a process: `node --import tsx src/main.ts`. Configuration from the environment
 * (or a git-ignored `.env.local`). Prints `listening on <url>` once it accepts requests.
 *
 *   SIDE=honest|naive   which receptionist (default honest)
 *   DB_PATH             SQLite file (one receiver process per file)
 *   LLM=simulated|claude, LLM_URL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL
 *   CLOUD_API_BASE_URL, GRAPH_API_VERSION, PHONE_NUMBER_ID, CLOUD_API_TOKEN
 *   APP_SECRET, VERIFY_TOKEN, TEMPLATE_NAME, TEMPLATE_LANGUAGE, PORT
 *   FAULT=after_charge  kill this process with SIGKILL right after the LLM answered (tests only)
 */
import type { AddressInfo } from 'node:net';
import { createCloudApiClient } from './cloud-api-client.js';
import { CRASH_POINTS, type CrashPoint } from './crash.js';
import { env, loadEnvLocal } from './env.js';
import { createHonestReceptionist } from './honest/receptionist.js';
import { createClaudeLlm } from './llm/claude.js';
import type { LlmProvider } from './llm/provider.js';
import { createSimulatedLlm } from './llm/simulated.js';
import { createNaiveReceptionist } from './naive/receptionist.js';
import type { ReceptionistOptions } from './receptionist.js';
import { createReceiver } from './server.js';

loadEnvLocal();

const fault = env('FAULT');
if (fault && !CRASH_POINTS.includes(fault as CrashPoint)) throw new Error(`unknown FAULT ${fault}`);

const llm: LlmProvider =
  env('LLM', 'simulated') === 'claude'
    ? createClaudeLlm({ apiKey: env('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL') })
    : createSimulatedLlm({ url: env('LLM_URL', 'http://127.0.0.1:8788') });

const options: ReceptionistOptions = {
  dbPath: env('DB_PATH', 'receptionist.db'),
  llm,
  cloud: createCloudApiClient({
    baseUrl: env('CLOUD_API_BASE_URL', 'https://graph.facebook.com'),
    version: env('GRAPH_API_VERSION'),
    phoneNumberId: env('PHONE_NUMBER_ID'),
    token: env('CLOUD_API_TOKEN'),
  }),
  templateName: env('TEMPLATE_NAME', 'booking_reminder'),
  templateLanguage: env('TEMPLATE_LANGUAGE', 'en_US'),
  fault: (fault || undefined) as CrashPoint | undefined,
};

const receptionist = env('SIDE', 'honest') === 'naive' ? createNaiveReceptionist(options) : createHonestReceptionist(options);
const server = createReceiver({ receptionist, appSecret: env('APP_SECRET') || undefined, verifyToken: env('VERIFY_TOKEN') || undefined });

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
