/**
 * Client for `POST /v<version>/<phone number id>/messages`. Request and response shapes follow
 * the documented text and template examples (docs/sources.md). Like the LLM client, its job is
 * to say honestly how a send ended: accepted (with the `wamid`), refused with a Graph API error,
 * or unknown (the connection failed after the request may have left).
 */
export type SendResult =
  | { kind: 'accepted'; wamid: string }
  | { kind: 'error'; status: number; code: number; message: string; details: string }
  | { kind: 'unknown'; error: string };

export interface TemplateSpec {
  name: string;
  language: string;
  /** Body text parameters, in order. */
  params: string[];
}

export interface CloudApiClient {
  sendText(to: string, body: string): Promise<SendResult>;
  sendTemplate(to: string, template: TemplateSpec): Promise<SendResult>;
}

export interface CloudApiOptions {
  /** `https://graph.facebook.com` in production; the fake's URL in tests. */
  baseUrl: string;
  /** Graph API version without the leading `v`, e.g. `23.0`. */
  version: string;
  phoneNumberId: string;
  token: string;
  timeoutMs?: number;
}

export function createCloudApiClient(opts: CloudApiOptions): CloudApiClient {
  const url = `${opts.baseUrl}/v${opts.version}/${opts.phoneNumberId}/messages`;

  async function post(body: unknown): Promise<SendResult> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      return { kind: 'unknown', error: errorCode(err) };
    }
    let json: any;
    try {
      json = await response.json();
    } catch (err) {
      return { kind: 'unknown', error: `body: ${errorCode(err)}` };
    }
    if (response.ok && typeof json?.messages?.[0]?.id === 'string') {
      return { kind: 'accepted', wamid: json.messages[0].id };
    }
    return {
      kind: 'error',
      status: response.status,
      code: Number(json?.error?.code ?? 0),
      message: String(json?.error?.message ?? ''),
      details: String(json?.error?.error_data?.details ?? ''),
    };
  }

  return {
    sendText: (to, body) =>
      post({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } }),
    sendTemplate: (to, t) =>
      post({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name: t.name,
          language: { code: t.language },
          components: [{ type: 'body', parameters: t.params.map((text) => ({ type: 'text', text })) }],
        },
      }),
  };
}

function errorCode(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code ?? e?.name ?? 'Error';
}
