/**
 * `npm run live:claude`: the honest receptionist with the SIMULATED Cloud API and the REAL Claude.
 *
 * Two inbound messages (a booking request and an unrelated question), then a redelivery of the
 * booking POST with the same bytes and signature. Prints the structured intents, the booking row,
 * the number of requests sent to Claude (expected 2, not 3) and the outbound messages.
 *
 * Needs ANTHROPIC_API_KEY in the environment or in a git-ignored .env.local; the key is never
 * printed. ANTHROPIC_MODEL overrides the default model. Not run by the suite or by CI.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudApiClient } from '../src/cloud-api-client.js';
import { env, loadEnvLocal } from '../src/env.js';
import { inspectDb } from '../src/honest/inspect.js';
import { createHonestReceptionist } from '../src/honest/receptionist.js';
import { createClaudeLlm, DEFAULT_ANTHROPIC_MODEL } from '../src/llm/claude.js';
import type { LlmProvider } from '../src/llm/provider.js';
import { createReceiver } from '../src/server.js';
import { startFakeCloudApi } from '../test/support/fake-cloud-api.js';

loadEnvLocal();
const apiKey = env('ANTHROPIC_API_KEY');
if (!apiKey) {
  console.log('live-claude: skipped (ANTHROPIC_API_KEY is not set in the environment or .env.local)');
  process.exit(0);
}
const model = env('ANTHROPIC_MODEL', DEFAULT_ANTHROPIC_MODEL);

const appSecret = randomBytes(16).toString('hex');
const cloud = await startFakeCloudApi({ version: '23.0', phoneNumberId: '100000000000001', token: 'local', appSecret, now: () => new Date() });

// Count every request that leaves for Claude: each one is a paid request (SDK retries are off).
const claude = createClaudeLlm({ apiKey, model });
let requestsToClaude = 0;
const llm: LlmProvider = {
  extractIntent: (input, opts) => {
    requestsToClaude += 1;
    return claude.extractIntent(input, opts);
  },
};

const dbPath = join(mkdtempSync(join(tmpdir(), 'live-claude-')), 'ledger.db');
const receptionist = createHonestReceptionist({
  dbPath,
  llm,
  cloud: createCloudApiClient({ baseUrl: cloud.url, version: '23.0', phoneNumberId: '100000000000001', token: 'local' }),
  templateName: 'booking_reminder',
  templateLanguage: 'en_US',
});
const server = createReceiver({ receptionist, appSecret, verifyToken: undefined });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
cloud.setReceiver(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

const customer = '5491155550101';
console.log(`model: ${model}`);
const booking = await cloud.deliverInbound({ from: customer, text: "Hi! Could I book Tuesday at 3pm? I'm Ana.", at: new Date() });
console.log(`delivery 1 (booking request)      -> HTTP ${booking.status}`);
const other = await cloud.deliverInbound({ from: customer, text: 'Do you have parking nearby?', at: new Date() });
console.log(`delivery 2 (unrelated question)   -> HTTP ${other.status}`);
const again = await cloud.redeliver(booking);
console.log(`delivery 3 (same bytes as 1)      -> HTTP ${again.status}`);

console.log(`\nrequests sent to Claude: ${requestsToClaude} (expected 2: the redelivery must not call it)`);
console.log(`\noutbound sent to the simulated Cloud API:`);
for (const m of cloud.sends) console.log(`  ${m.type} ${m.outcome}: ${m.body ?? JSON.stringify(m.template)}`);
console.log(`\n${inspectDb(dbPath)}`);
console.log(`\nledger file: ${dbPath}`);

server.closeAllConnections();
server.close();
receptionist.close();
await cloud.close();
