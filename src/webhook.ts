/**
 * The parts of a Cloud API `messages` webhook this receptionist reads. Shapes follow the
 * documented examples (docs/sources.md): inbound messages and outgoing-message statuses both
 * arrive under `entry[].changes[].value`.
 */
export interface WebhookPayload {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: RawInboundMessage[];
        statuses?: RawStatus[];
      };
    }[];
  }[];
}

export interface RawInboundMessage {
  from: string;
  id: string;
  /** Unix seconds, as a string. */
  timestamp: string;
  type: string;
  text?: { body: string };
}

export interface RawStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: { code: number; title?: string; message?: string; error_data?: { details?: string }; href?: string }[];
}

export interface InboundMessage {
  id: string;
  from: string;
  /** From `messages[].timestamp`. */
  sentAt: Date;
  type: string;
  body: string;
}

export interface StatusUpdate {
  wamid: string;
  status: string;
  recipient: string;
  errors: { code: number; message: string }[];
}

export function inboundMessages(payload: WebhookPayload): InboundMessage[] {
  return values(payload).flatMap((v) =>
    (v.messages ?? []).map((m) => ({
      id: m.id,
      from: m.from,
      sentAt: new Date(Number(m.timestamp) * 1000),
      type: m.type,
      body: m.text?.body ?? '',
    })),
  );
}

export function statusUpdates(payload: WebhookPayload): StatusUpdate[] {
  return values(payload).flatMap((v) =>
    (v.statuses ?? []).map((s) => ({
      wamid: s.id,
      status: s.status,
      recipient: s.recipient_id,
      errors: (s.errors ?? []).map((e) => ({ code: e.code, message: e.message ?? e.title ?? '' })),
    })),
  );
}

function values(payload: WebhookPayload) {
  return (payload.entry ?? []).flatMap((e) => (e.changes ?? []).map((c) => c.value ?? {}));
}
