import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Intent, IntentInput } from '../../src/llm/provider.js';

/**
 * A fake paid language model served over real HTTP. It bills every request it accepts and
 * answers with a deterministic intent. Faults are consumed one per request, in order:
 *
 *   'drop-after-charge'  bills, then destroys the socket without answering
 *   'delay <ms>'         bills, answers <ms> later
 *   '500'                answers 500 and does NOT bill
 */
export type LlmFault = 'drop-after-charge' | `delay ${number}` | '500';

export interface FakeLlm {
  url: string;
  /** Requests billed since the last reset. */
  charges(): number;
  /** Call keys (`x-call-key`) of the billed requests, in order; empty string when none was sent. */
  billedKeys(): string[];
  /** Requests received, billed or not. */
  requests(): number;
  failNext(...faults: LlmFault[]): void;
  reset(): void;
  close(): Promise<void>;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The simulated understanding: `book <weekday|YYYY-MM-DD> <HH:MM> [for <name>]`, case-insensitive.
 * A weekday resolves to its next occurrence strictly after the day of `nowIso` (UTC).
 */
export function parseIntent(input: IntentInput): Intent {
  const m = /^\s*book\s+(\w+|\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?:\s+for\s+(.+?))?\s*$/i.exec(input.text);
  if (!m) return { kind: 'other' };
  const [, day, hh, mm, name] = m;
  let date: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(day!)) {
    date = day!;
  } else {
    const target = WEEKDAYS.indexOf(day!.toLowerCase());
    if (target < 0) return { kind: 'other' };
    const now = new Date(input.nowIso);
    const ahead = ((target - now.getUTCDay() + 7) % 7) || 7;
    date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ahead)).toISOString().slice(0, 10);
  }
  const slot = `${date} ${hh!.padStart(2, '0')}:${mm}`;
  return name ? { kind: 'book', slot, name } : { kind: 'book', slot };
}

export async function startFakeLlm(): Promise<FakeLlm> {
  const billed: string[] = [];
  let received = 0;
  const faults: LlmFault[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const server = createServer(async (req, res) => {
    const input = JSON.parse(await readBody(req)) as IntentInput;
    received += 1;
    const fault = faults.shift();

    if (fault === '500') {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'internal_error' }));
      return;
    }

    // Every other path does the paid work before answering.
    billed.push(String(req.headers['x-call-key'] ?? ''));

    if (fault === 'drop-after-charge') {
      req.socket.destroy();
      return;
    }
    const answer = () => {
      if (res.destroyed) return; // the client gave up; the charge stands
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(parseIntent(input)));
    };
    if (fault?.startsWith('delay ')) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        answer();
      }, Number(fault.slice('delay '.length)));
      timers.add(timer);
      return;
    }
    answer();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    charges: () => billed.length,
    billedKeys: () => [...billed],
    requests: () => received,
    failNext: (...f) => {
      faults.push(...f);
    },
    reset: () => {
      billed.length = 0;
      received = 0;
      faults.length = 0;
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
