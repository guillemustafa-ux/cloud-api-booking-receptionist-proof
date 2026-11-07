import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Receptionist } from './receptionist.js';
import { SIGNATURE_HEADER, verifySignature } from './signature.js';
import type { WebhookPayload } from './webhook.js';

export interface ReceiverOptions {
  receptionist: Receptionist;
  /** HMAC key for `X-Hub-Signature-256`. Without it every POST is refused. */
  appSecret: string | undefined;
  /** Token expected in `hub.verify_token`. Without it every verification request is refused. */
  verifyToken: string | undefined;
}

/**
 * The webhook endpoint on plain `node:http`.
 *
 *   GET  /webhook  verification: `hub.mode=subscribe` and the right `hub.verify_token` -> 200 with
 *                  `hub.challenge` as the body; anything else -> 403
 *   POST /webhook  signature checked over the raw bytes BEFORE parsing; any failure -> 401.
 *                  The delivery is processed synchronously, then answered 200 (deterministic for
 *                  the tests). An error while processing answers 500, so the sender retries.
 */
export function createReceiver(opts: ReceiverOptions): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://receiver.local');
    if (url.pathname !== '/webhook') {
      res.writeHead(404).end();
      return;
    }

    if (req.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge') ?? '';
      if (mode === 'subscribe' && opts.verifyToken && token === opts.verifyToken) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(challenge);
      } else {
        res.writeHead(403).end();
      }
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const raw = await readRaw(req);
    const header = req.headers[SIGNATURE_HEADER];
    if (!verifySignature(raw, Array.isArray(header) ? header[0] : header, opts.appSecret)) {
      res.writeHead(401).end();
      return;
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(raw.toString('utf8')) as WebhookPayload;
    } catch {
      res.writeHead(400).end();
      return;
    }

    try {
      await opts.receptionist.handleWebhook(payload);
      res.writeHead(200).end();
    } catch (err) {
      process.stderr.write(`webhook processing failed: ${err instanceof Error ? err.message : String(err)}\n`);
      res.writeHead(500).end();
    }
  });
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
