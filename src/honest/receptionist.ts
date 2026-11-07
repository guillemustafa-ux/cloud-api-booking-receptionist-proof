import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { crashIfAt } from '../crash.js';
import { LlmCallError, type Intent } from '../llm/provider.js';
import { reminderText, replyFor, windowOpen, type Receptionist, type ReceptionistOptions } from '../receptionist.js';
import { inboundMessages, statusUpdates, type InboundMessage, type WebhookPayload } from '../webhook.js';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** Graph API error code: more than 24 hours since the recipient last replied (docs/sources.md). */
export const REENGAGEMENT_ERROR = 131047;

/** An LLM answer with an error status is not billed by the simulated provider, so it may be retried. */
const MAX_ATTEMPTS = 2;

interface OutboundRow {
  id: number;
  wa_id: string;
  kind: string;
  type: 'text' | 'template';
  template_name: string | null;
  body: string;
  status: string;
  booking_id: number | null;
}

/**
 * The guarded receptionist. Per inbound message:
 *
 *   1. inbox row keyed by the message id, written synchronously before any await; a conflict
 *      is a redelivery: counted, and nothing else runs
 *   2. llm_calls row (`<message id>:<attempt>`, `started`) committed before the paid request
 *   3. intent, booking, ledger `done` and the pending reply in ONE transaction
 *   4. the reply goes out as text inside the 24-hour window, as the template outside it
 *
 * A call still `started` when the process opens the file belonged to a process that died:
 * it becomes `unknown`, its message `unconfirmed`, and nothing calls the LLM for it again.
 */
export function createHonestReceptionist(opts: ReceptionistOptions): Receptionist {
  const db = new Database(opts.dbPath);
  db.exec(SCHEMA);
  const now = opts.now ?? (() => new Date());
  const iso = () => now().toISOString();

  sweepDeadCalls(db, iso());

  /**
   * Synchronous: committed before the caller reaches its first await. True when this delivery must
   * be processed: the first one, or a redelivery of a message that a dead process recorded but
   * never started a call for (`received`, no llm_calls row: nothing can have been billed). In a live
   * process that state never outlasts one synchronous step, so a concurrent copy cannot see it.
   */
  const recordInbound = db.transaction((msg: InboundMessage): boolean => {
    const inserted =
      db
        .prepare(
          `insert into inbox (message_id, wa_id, type, body, sent_at, status, deliveries, first_seen_at)
           values (?, ?, ?, ?, ?, 'received', 1, ?) on conflict (message_id) do nothing`,
        )
        .run(msg.id, msg.from, msg.type, msg.body, msg.sentAt.toISOString(), iso()).changes === 1;
    let mustProcess = inserted;
    if (!inserted) {
      db.prepare('update inbox set deliveries = deliveries + 1 where message_id = ?').run(msg.id);
      const { status, calls } = db
        .prepare('select status, (select count(*) from llm_calls where message_id = ?) as calls from inbox where message_id = ?')
        .get(msg.id, msg.id) as { status: string; calls: number };
      mustProcess = status === 'received' && calls === 0;
    }
    db.prepare(
      `insert into conversations (wa_id, last_inbound_at) values (?, ?)
       on conflict (wa_id) do update set last_inbound_at = max(last_inbound_at, excluded.last_inbound_at)`,
    ).run(msg.from, msg.sentAt.toISOString());
    return mustProcess;
  });

  function startCall(messageId: string): { callKey: string; attempt: number } {
    const { next } = db
      .prepare('select coalesce(max(attempt), 0) + 1 as next from llm_calls where message_id = ?')
      .get(messageId) as { next: number };
    const callKey = `${messageId}:${next}`;
    db.prepare(`insert into llm_calls (call_key, message_id, attempt, status, started_at) values (?, ?, ?, 'started', ?)`).run(
      callKey,
      messageId,
      next,
      iso(),
    );
    return { callKey, attempt: next };
  }

  function endCall(callKey: string, status: 'failed' | 'unknown', error: string, inboxStatus?: string) {
    db.transaction(() => {
      db.prepare('update llm_calls set status = ?, error = ?, finished_at = ? where call_key = ?').run(status, error, iso(), callKey);
      if (inboxStatus) {
        db.prepare('update inbox set status = ? where message_id = (select message_id from llm_calls where call_key = ?)').run(
          inboxStatus,
          callKey,
        );
      }
    })();
  }

  /** Inserts an outbound row whose type follows the window at send time. Returns its id. */
  function planOutbound(p: { waId: string; kind: string; text: string; slot?: string; inboundMessageId?: string; bookingId?: number }) {
    const conv = db.prepare('select last_inbound_at from conversations where wa_id = ?').get(p.waId) as
      | { last_inbound_at: string }
      | undefined;
    const open = windowOpen(conv ? new Date(conv.last_inbound_at) : undefined, now());
    const [type, body, status, templateName] = open
      ? (['text', p.text, 'pending', null] as const)
      : p.slot !== undefined
        ? (['template', p.slot, 'pending', opts.templateName] as const)
        : (['text', p.text, 'not_sent', null] as const); // window closed and no template fits this message
    const t = iso();
    const info = db
      .prepare(
        `insert into outbound (wa_id, kind, type, template_name, body, status, error_message, inbound_message_id, booking_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.waId,
        p.kind,
        type,
        templateName,
        body,
        status,
        status === 'not_sent' ? 'customer service window closed; no template for this message' : null,
        p.inboundMessageId ?? null,
        p.bookingId ?? null,
        t,
        t,
      );
    return Number(info.lastInsertRowid);
  }

  /** Intent, booking, ledger `done` and the pending reply: one transaction. */
  const persistResult = db.transaction((msg: InboundMessage, callKey: string, intent: Intent): number => {
    // A provider's note (for example why an answer was read as `other`) is kept next to the intent.
    const { note, ...stored } = intent.kind === 'other' ? intent : { ...intent, note: undefined };
    db.prepare(`update llm_calls set status = 'done', intent_json = ?, note = ?, finished_at = ? where call_key = ?`).run(
      JSON.stringify(stored),
      note ?? null,
      iso(),
      callKey,
    );
    let bookingId: number | undefined;
    if (intent.kind === 'book') {
      bookingId = Number(
        db
          .prepare('insert into bookings (inbound_message_id, wa_id, slot, name, created_at) values (?, ?, ?, ?, ?)')
          .run(msg.id, msg.from, intent.slot, intent.name ?? null, iso()).lastInsertRowid,
      );
    }
    db.prepare(`update inbox set status = 'done' where message_id = ?`).run(msg.id);
    return planOutbound({
      waId: msg.from,
      kind: 'reply',
      text: replyFor(intent),
      slot: intent.kind === 'book' ? intent.slot : undefined,
      inboundMessageId: msg.id,
      bookingId,
    });
  });

  async function processMessage(msg: InboundMessage): Promise<void> {
    if (msg.type !== 'text') {
      db.prepare(`update inbox set status = 'ignored' where message_id = ?`).run(msg.id);
      return;
    }
    for (;;) {
      const { callKey, attempt } = startCall(msg.id); // committed BEFORE the paid request leaves
      let intent: Intent;
      try {
        intent = await opts.llm.extractIntent({ text: msg.body, from: msg.from, nowIso: iso() }, { callKey });
      } catch (err) {
        if (err instanceof LlmCallError && err.outcome === 'rejected') {
          const last = attempt >= MAX_ATTEMPTS;
          endCall(callKey, 'failed', err.message, last ? 'failed' : undefined);
          if (last) return;
          continue;
        }
        // It may have been billed. Make it visible; never call again for this message.
        endCall(callKey, 'unknown', err instanceof Error ? err.message : String(err), 'unconfirmed');
        return;
      }
      crashIfAt(opts.fault, 'after_charge');
      let replyId: number;
      try {
        replyId = persistResult(msg, callKey, intent);
      } catch (err) {
        // The answer arrived and was paid for, but could not be recorded: the call must not stay `started`.
        endCall(callKey, 'unknown', `answer received but not recorded: ${err instanceof Error ? err.message : String(err)}`, 'unconfirmed');
        throw err;
      }
      await deliverOutbound(replyId);
      return;
    }
  }

  async function deliverOutbound(rowId: number): Promise<void> {
    const row = db.prepare('select * from outbound where id = ?').get(rowId) as OutboundRow;
    if (row.status !== 'pending') return;
    const result =
      row.type === 'text'
        ? await opts.cloud.sendText(row.wa_id, row.body)
        : await opts.cloud.sendTemplate(row.wa_id, { name: row.template_name!, language: opts.templateLanguage, params: [row.body] });
    if (result.kind === 'accepted') {
      db.prepare(`update outbound set status = 'sent', wamid = ?, updated_at = ? where id = ?`).run(result.wamid, iso(), row.id);
    } else if (result.kind === 'error') {
      await onSendFailed(row.id, result.code, `${result.message} ${result.details}`.trim());
    } else {
      db.prepare(`update outbound set status = 'unknown', error_message = ?, updated_at = ? where id = ?`).run(result.error, iso(), row.id);
    }
  }

  /** A send failed, synchronously (Graph API error) or asynchronously (failed status webhook). */
  async function onSendFailed(rowId: number, code: number, message: string): Promise<void> {
    db.prepare(`update outbound set status = 'failed', error_code = ?, error_message = ?, updated_at = ? where id = ?`).run(
      code,
      message,
      iso(),
      rowId,
    );
    if (code === REENGAGEMENT_ERROR) await sendFallback(rowId);
  }

  /** One template per failed message: `fallback_of` is unique, so a second insert is ignored. */
  async function sendFallback(failedRowId: number): Promise<void> {
    const failed = db.prepare('select * from outbound where id = ?').get(failedRowId) as OutboundRow;
    // Only a text falls back; the one template carries a booking slot, so without one there is nothing to send.
    if (failed.type !== 'text' || failed.booking_id === null) return;
    const { slot } = db.prepare('select slot from bookings where id = ?').get(failed.booking_id) as { slot: string };
    const t = iso();
    const info = db
      .prepare(
        `insert or ignore into outbound (wa_id, kind, type, template_name, body, status, fallback_of, booking_id, created_at, updated_at)
         values (?, 'fallback', 'template', ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(failed.wa_id, opts.templateName, slot, failedRowId, failed.booking_id, t, t);
    if (info.changes === 0) return; // this failure already has its fallback
    await deliverOutbound(Number(info.lastInsertRowid));
  }

  return {
    async handleWebhook(payload: WebhookPayload) {
      for (const msg of inboundMessages(payload)) {
        const mustProcess = recordInbound(msg); // synchronous: committed before any await
        crashIfAt(opts.fault, 'after_inbox');
        if (!mustProcess) continue; // a redelivery: counted on the existing row, nothing else runs
        await processMessage(msg);
      }
      for (const s of statusUpdates(payload)) {
        if (s.status !== 'failed') continue;
        const row = db.prepare('select id from outbound where wamid = ?').get(s.wamid) as { id: number } | undefined;
        const error = s.errors[0] ?? { code: 0, title: '', message: 'failed status without errors[]' };
        if (!row) {
          // Not a message this ledger sent (or sent from a lost copy of it): kept visible, once.
          db.prepare(
            `insert into orphan_statuses (wamid, status, error_code, error_title, received_at) values (?, ?, ?, ?, ?)
             on conflict (wamid, status) do nothing`,
          ).run(s.wamid, s.status, error.code, error.title || error.message, iso());
          continue;
        }
        await onSendFailed(row.id, error.code, error.message);
      }
    },

    async sendReminders() {
      const due = db
        .prepare(
          `select b.id, b.wa_id, b.slot from bookings b
           where not exists (select 1 from outbound o where o.booking_id = b.id and o.kind = 'reminder')
           order by b.id`,
        )
        .all() as { id: number; wa_id: string; slot: string }[];
      for (const b of due) {
        const rowId = planOutbound({ waId: b.wa_id, kind: 'reminder', text: reminderText(b.slot), slot: b.slot, bookingId: b.id });
        await deliverOutbound(rowId);
      }
    },

    close: () => db.close(),
  };
}

/** At open: any call still `started` belonged to a process that died mid-call. */
function sweepDeadCalls(db: Database.Database, at: string): void {
  db.transaction(() => {
    const dead = db.prepare(`select call_key, message_id from llm_calls where status = 'started'`).all() as {
      call_key: string;
      message_id: string;
    }[];
    for (const c of dead) {
      db.prepare(`update llm_calls set status = 'unknown', error = 'process died during the call', finished_at = ? where call_key = ?`).run(
        at,
        c.call_key,
      );
      db.prepare(`update inbox set status = 'unconfirmed' where message_id = ?`).run(c.message_id);
    }
  })();
}
