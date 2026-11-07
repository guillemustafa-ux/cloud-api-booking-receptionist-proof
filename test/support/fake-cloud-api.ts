import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sign } from '../../src/signature.js';

/**
 * A fake of the Cloud API messages endpoint and of Meta's webhook delivery, modelled from the
 * documentation (docs/sources.md), not observed live.
 *
 * Sending: `POST /v<version>/<phone number id>/messages` with `Authorization: Bearer <token>`,
 * the documented text and template request shapes, and the documented success body. It keeps its
 * OWN view of the customer service window (`lastInboundAt` per wa_id, set when the harness
 * delivers a customer message) and refuses a text sent more than 24 hours after it with error
 * 131047, either:
 *   - 'sync'   a 400 with the documented error body, or
 *   - 'async'  a 200 with a wamid, then a signed `statuses` webhook with `status: "failed"`
 *              (queued until `deliverPendingStatuses()`).
 *
 * Webhooks: it signs and delivers inbound-message and status payloads to the receiver, and can
 * redeliver the exact same bytes with the exact same signature.
 */
export type ErrorMode = 'sync' | 'async';

export interface SentMessage {
  to: string;
  type: 'text' | 'template';
  body?: string;
  template?: { name: string; language: string; params: string[] };
  outcome: 'accepted' | 'rejected-131047' | 'accepted-then-failed';
  wamid?: string;
}

export interface Delivery {
  raw: Buffer;
  signature: string;
  /** HTTP status the receiver answered; 0 when the connection failed. */
  status: number;
}

export interface FakeCloudApi {
  url: string;
  sends: SentMessage[];
  setReceiver(webhookUrl: string): void;
  setErrorMode(mode: ErrorMode): void;
  /** Record a customer message in the fake's own window view (deliverInbound does this itself). */
  noteInbound(from: string, at: Date): void;
  /** A customer message: updates the fake's window view, then delivers the signed webhook. */
  deliverInbound(m: { from: string; text: string; at: Date; id?: string; name?: string }): Promise<Delivery>;
  /** The same bytes and the same signature again. */
  redeliver(d: Delivery): Promise<Delivery>;
  /** Arbitrary bytes with an arbitrary `X-Hub-Signature-256` (omitted when undefined). */
  deliverRaw(raw: Buffer, signature: string | undefined): Promise<number>;
  /** Deliver every queued failed-status webhook (async mode). */
  deliverPendingStatuses(): Promise<Delivery[]>;
  /** The documented failed-status payload (error 131047) for a wamid, as bytes. */
  failedStatusPayload(wamid: string, recipient: string): Buffer;
  /** The documented inbound payload for a message, as bytes. */
  inboundPayload(m: { from: string; text: string; at: Date; id: string; name?: string }): Buffer;
  reset(): void;
  close(): Promise<void>;
}

export const RE_ENGAGEMENT_DETAILS = 'More than 24 hours have passed since the recipient last replied to the sender number.';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WABA_ID = '102290129340398';
const DISPLAY_NUMBER = '15550783881';

export async function startFakeCloudApi(opts: {
  version: string;
  phoneNumberId: string;
  token: string;
  appSecret: string;
  now: () => Date;
}): Promise<FakeCloudApi> {
  const sends: SentMessage[] = [];
  const lastInboundAt = new Map<string, Date>();
  const pendingStatuses: Buffer[] = [];
  let receiver = '';
  let mode: ErrorMode = 'sync';
  let counter = 0;
  const wamid = (tag: string) => `wamid.HBgL${tag}${String(++counter).padStart(6, '0')}`;
  const path = `/v${opts.version}/${opts.phoneNumberId}/messages`;

  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.method !== 'POST' || req.url !== path) return json(404, { error: { message: 'Unknown path', code: 100 } });
    if (req.headers.authorization !== `Bearer ${opts.token}`) {
      return json(401, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
    }
    const body = JSON.parse(await readBody(req));
    const to = String(body.to);
    const sent: SentMessage =
      body.type === 'template'
        ? {
            to,
            type: 'template',
            template: {
              name: body.template.name,
              language: body.template.language.code,
              params: (body.template.components?.[0]?.parameters ?? []).map((p: { text: string }) => p.text),
            },
            outcome: 'accepted',
          }
        : { to, type: 'text', body: body.text.body, outcome: 'accepted' };

    const last = lastInboundAt.get(to);
    const windowClosed = !last || opts.now().getTime() - last.getTime() >= WINDOW_MS;
    if (sent.type === 'text' && windowClosed) {
      if (mode === 'sync') {
        sent.outcome = 'rejected-131047';
        sends.push(sent);
        return json(400, {
          error: {
            message: `(#131047) ${RE_ENGAGEMENT_DETAILS}`,
            type: 'OAuthException',
            code: 131047,
            error_data: { messaging_product: 'whatsapp', details: RE_ENGAGEMENT_DETAILS },
            fbtrace_id: `Fake${counter}`,
          },
        });
      }
      sent.outcome = 'accepted-then-failed';
    }
    sent.wamid = wamid('OUT');
    sends.push(sent);
    if (sent.outcome === 'accepted-then-failed') pendingStatuses.push(failedStatusPayload(sent.wamid, to));
    return json(200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: sent.wamid }] });
  });

  function envelope(value: Record<string, unknown>): Buffer {
    return Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA_ID,
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: DISPLAY_NUMBER, phone_number_id: opts.phoneNumberId },
                  ...value,
                },
                field: 'messages',
              },
            ],
          },
        ],
      }),
    );
  }

  function inboundPayload(m: { from: string; text: string; at: Date; id: string; name?: string }): Buffer {
    return envelope({
      contacts: [{ profile: { name: m.name ?? 'Customer' }, wa_id: m.from }],
      messages: [
        { from: m.from, id: m.id, timestamp: String(Math.floor(m.at.getTime() / 1000)), type: 'text', text: { body: m.text } },
      ],
    });
  }

  function failedStatusPayload(id: string, recipient: string): Buffer {
    return envelope({
      statuses: [
        {
          id,
          status: 'failed',
          timestamp: String(Math.floor(opts.now().getTime() / 1000)),
          recipient_id: recipient,
          errors: [
            {
              code: 131047,
              title: RE_ENGAGEMENT_DETAILS,
              message: RE_ENGAGEMENT_DETAILS,
              error_data: { details: RE_ENGAGEMENT_DETAILS },
              href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
            },
          ],
        },
      ],
    });
  }

  function noteInbound(from: string, at: Date) {
    const prev = lastInboundAt.get(from);
    if (!prev || prev < at) lastInboundAt.set(from, at);
  }

  async function post(raw: Buffer, signature: string | undefined): Promise<number> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature !== undefined) headers['x-hub-signature-256'] = signature;
    try {
      const res = await fetch(`${receiver}/webhook`, { method: 'POST', headers, body: new Uint8Array(raw) });
      await res.body?.cancel();
      return res.status;
    } catch {
      return 0; // connection failed (for example the receiver process died mid-request)
    }
  }

  async function deliver(raw: Buffer): Promise<Delivery> {
    const signature = sign(opts.appSecret, raw);
    return { raw, signature, status: await post(raw, signature) };
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    sends,
    setReceiver: (u) => {
      receiver = u;
    },
    setErrorMode: (m) => {
      mode = m;
    },
    noteInbound,
    deliverInbound: (m) => {
      noteInbound(m.from, m.at);
      return deliver(inboundPayload({ ...m, id: m.id ?? wamid('IN') }));
    },
    redeliver: async (d) => ({ ...d, status: await post(d.raw, d.signature) }),
    deliverRaw: (raw, signature) => post(raw, signature),
    deliverPendingStatuses: async () => {
      const out: Delivery[] = [];
      for (const raw of pendingStatuses.splice(0)) out.push(await deliver(raw));
      return out;
    },
    inboundPayload,
    failedStatusPayload,
    reset: () => {
      sends.length = 0;
      lastInboundAt.clear();
      pendingStatuses.length = 0;
      mode = 'sync';
    },
    close: async () => {
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
