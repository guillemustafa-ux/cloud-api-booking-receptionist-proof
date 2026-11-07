import type { CloudApiClient } from './cloud-api-client.js';
import type { CrashPoint } from './crash.js';
import type { Intent, LlmProvider } from './llm/provider.js';
import type { WebhookPayload } from './webhook.js';

/** Public interface shared by the honest receptionist and its naive twin: one suite drives both. */
export interface Receptionist {
  /** Handle one verified webhook delivery (inbound messages and/or statuses). */
  handleWebhook(payload: WebhookPayload): Promise<void>;
  /** Send the confirmation reminder for every booking that has not had one. */
  sendReminders(): Promise<void>;
  close(): void;
}

export interface ReceptionistOptions {
  /** SQLite file. */
  dbPath: string;
  llm: LlmProvider;
  cloud: CloudApiClient;
  /** Injectable clock; defaults to the system clock. */
  now?: () => Date;
  templateName: string;
  templateLanguage: string;
  fault?: CrashPoint;
}

/** The customer service window: 24 hours from the customer's last message (docs/sources.md). */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export function windowOpen(lastInboundAt: Date | undefined, now: Date): boolean {
  return lastInboundAt !== undefined && now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}

/** The LLM only understands; the reply text is composed here, deterministically. */
export function replyFor(intent: Intent): string {
  if (intent.kind === 'book') {
    return `Booked: ${intent.slot}${intent.name ? ` for ${intent.name}` : ''}. Reply here if you need to change it.`;
  }
  return 'I can take bookings. Send for example: book tuesday 15:00';
}

export function reminderText(slot: string): string {
  return `Reminder: your booking is on ${slot}.`;
}
