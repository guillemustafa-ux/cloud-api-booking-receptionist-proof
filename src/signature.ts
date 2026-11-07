import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `X-Hub-Signature-256: sha256=<hex>` where <hex> is the HMAC-SHA256 of the raw POST body,
 * keyed with the app secret (see docs/sources.md). Checked over the exact bytes received,
 * before the body is parsed.
 */
export const SIGNATURE_HEADER = 'x-hub-signature-256';

export function sign(appSecret: string, raw: Buffer | string): string {
  return `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
}

/**
 * True only when a secret is configured, the header has the `sha256=` form, and its hex
 * matches the HMAC of `raw` (constant-time compare). A receiver without a secret accepts nothing.
 */
export function verifySignature(raw: Buffer, header: string | undefined, appSecret: string | undefined): boolean {
  if (!appSecret) return false;
  if (!header || !header.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  // timingSafeEqual throws on a length mismatch; a short or non-hex header is simply wrong.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
