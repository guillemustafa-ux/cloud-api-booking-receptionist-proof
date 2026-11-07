import Database from 'better-sqlite3';
import { crashIfAt } from '../crash.js';
import { reminderText, replyFor, type Receptionist, type ReceptionistOptions } from '../receptionist.js';
import { inboundMessages, type WebhookPayload } from '../webhook.js';

/**
 * What a first version usually looks like: call the model for every delivery, save the booking,
 * reply with a text. No inbox, no ledger before the paid call, no window check, and the
 * `errors[]` of a status webhook are not read. Same HTTP surface and public interface as the
 * honest receptionist, so one suite drives both. It exists to show the A/B, not to be used.
 */
export function createNaiveReceptionist(opts: ReceptionistOptions): Receptionist {
  const db = new Database(opts.dbPath);
  db.exec(`create table if not exists bookings (
    id integer primary key autoincrement,
    wa_id text not null,
    slot text not null,
    name text,
    created_at text not null
  )`);
  const now = opts.now ?? (() => new Date());

  async function sendText(to: string, body: string) {
    const result = await opts.cloud.sendText(to, body);
    if (result.kind !== 'accepted') throw new Error(`send failed: ${JSON.stringify(result)}`); // and nothing records it
  }

  return {
    async handleWebhook(payload: WebhookPayload) {
      for (const msg of inboundMessages(payload)) {
        if (msg.type !== 'text') continue;
        const intent = await opts.llm.extractIntent({ text: msg.body, from: msg.from, nowIso: now().toISOString() });
        crashIfAt(opts.fault, 'after_charge');
        if (intent.kind === 'book') {
          db.prepare('insert into bookings (wa_id, slot, name, created_at) values (?, ?, ?, ?)').run(
            msg.from,
            intent.slot,
            intent.name ?? null,
            now().toISOString(),
          );
        }
        await sendText(msg.from, replyFor(intent));
      }
      // statuses[] are not read: a failed delivery goes unnoticed.
    },

    async sendReminders() {
      const bookings = db.prepare('select wa_id, slot from bookings order by id').all() as { wa_id: string; slot: string }[];
      for (const b of bookings) await sendText(b.wa_id, reminderText(b.slot)); // always text
    },

    close: () => db.close(),
  };
}
