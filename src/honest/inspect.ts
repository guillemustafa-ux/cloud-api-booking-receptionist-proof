import Database from 'better-sqlite3';

const QUERIES: [string, string][] = [
  ['inbox', 'select message_id, wa_id, status, deliveries, sent_at, body from inbox order by first_seen_at, message_id'],
  ['llm_calls', 'select call_key, status, intent_json, note, error from llm_calls order by started_at, call_key'],
  ['bookings', 'select id, inbound_message_id, wa_id, slot, name from bookings order by id'],
  ['outbound', 'select id, kind, type, status, error_code, fallback_of, wamid, body from outbound order by id'],
  ['orphan_statuses', 'select wamid, status, error_code, error_title, received_at from orphan_statuses order by received_at, wamid'],
];

/** A readable dump of the honest receptionist's ledger: inbox, llm_calls, bookings, outbound, orphan_statuses. */
export function inspectDb(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return QUERIES.map(([name, sql]) => `${name}\n${formatTable(db.prepare(sql).all() as Record<string, unknown>[])}`).join('\n\n');
  } finally {
    db.close();
  }
}

export function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '  (no rows)';
  const columns = Object.keys(rows[0]!);
  const cell = (v: unknown) => (v === null || v === undefined ? '-' : String(v)).replace(/\s+/g, ' ').slice(0, 60);
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (values: string[]) => '  ' + values.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))].join('\n');
}
