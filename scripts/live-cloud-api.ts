/**
 * `npm run live:cloud-api`: one text and one template through the REAL Graph API messages
 * endpoint, with the same client the receptionist uses.
 *
 *   CLOUD_API_TOKEN, PHONE_NUMBER_ID, TO_NUMBER, GRAPH_API_VERSION   required
 *   TEMPLATE_NAME, TEMPLATE_LANGUAGE                                 required (an approved template)
 *   TEMPLATE_PARAM                                                   optional, one body text parameter
 *
 * From the environment or a git-ignored .env.local. Without the variables it prints a skip line
 * and exits 0. The token is never printed. Not run by the suite or by CI.
 *
 * The text is only accepted inside the customer service window, so TO_NUMBER must have written
 * to the business number within the last 24 hours; otherwise the expected answer is error 131047.
 */
import { createCloudApiClient, type SendResult } from '../src/cloud-api-client.js';
import { env, loadEnvLocal } from '../src/env.js';

loadEnvLocal();
const required = ['CLOUD_API_TOKEN', 'PHONE_NUMBER_ID', 'TO_NUMBER', 'GRAPH_API_VERSION', 'TEMPLATE_NAME', 'TEMPLATE_LANGUAGE'];
const missing = required.filter((name) => !env(name));
if (missing.length > 0) {
  console.log(`live-cloud-api: skipped (not set: ${missing.join(', ')})`);
  process.exit(0);
}

const client = createCloudApiClient({
  baseUrl: 'https://graph.facebook.com',
  version: env('GRAPH_API_VERSION').replace(/^v/, ''),
  phoneNumberId: env('PHONE_NUMBER_ID'),
  token: env('CLOUD_API_TOKEN'),
});
const to = env('TO_NUMBER');
const describe = (r: SendResult) =>
  r.kind === 'accepted' ? `accepted, ${r.wamid}` : r.kind === 'error' ? `HTTP ${r.status}, error ${r.code}: ${r.message} ${r.details}`.trim() : `unknown: ${r.error}`;

console.log(`graph api version: v${env('GRAPH_API_VERSION').replace(/^v/, '')}`);
console.log(`text     -> ${describe(await client.sendText(to, `Live check from cloud-api-booking-receptionist-proof at ${new Date().toISOString()}`))}`);
const param = env('TEMPLATE_PARAM');
console.log(
  `template -> ${describe(await client.sendTemplate(to, { name: env('TEMPLATE_NAME'), language: env('TEMPLATE_LANGUAGE'), params: param ? [param] : [] }))}`,
);
