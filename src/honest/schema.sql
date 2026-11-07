-- The honest receptionist's ledger. One SQLite file, one receiver process per file.

-- One row per WhatsApp message id. Written synchronously, before any await, before the LLM
-- is called and before any booking: a redelivery finds the row and only bumps `deliveries`.
create table if not exists inbox (
  message_id    text primary key,
  wa_id         text not null,
  type          text not null,
  body          text not null,
  sent_at       text not null,          -- from messages[].timestamp
  status        text not null,          -- received | done | unconfirmed | failed | ignored
  deliveries    integer not null default 1,
  first_seen_at text not null
);

-- Last inbound message per customer: the start of the 24-hour customer service window.
create table if not exists conversations (
  wa_id           text primary key,
  last_inbound_at text not null
);

-- One row per paid LLM request, committed BEFORE the request leaves.
create table if not exists llm_calls (
  call_key    text primary key,         -- <message id>:<attempt>
  message_id  text not null references inbox (message_id),
  attempt     integer not null,
  status      text not null,            -- started | done | failed | unknown
  intent_json text,
  error       text,
  started_at  text not null,
  finished_at text
);

create table if not exists bookings (
  id                 integer primary key autoincrement,
  inbound_message_id text not null unique, -- defense in depth: one booking per inbound message
  wa_id              text not null,
  slot               text not null,
  name               text,
  created_at         text not null
);

create table if not exists outbound (
  id                 integer primary key autoincrement,
  wa_id              text not null,
  kind               text not null,     -- reply | reminder | fallback
  type               text not null,     -- text | template
  template_name      text,
  body               text not null,     -- text body, or the template's body parameter
  status             text not null,     -- pending | sent | failed | unknown | not_sent
  wamid              text unique,
  error_code         integer,
  error_message      text,
  fallback_of        integer unique references outbound (id), -- one fallback per failed message
  inbound_message_id text,
  booking_id         integer references bookings (id),
  created_at         text not null,
  updated_at         text not null
);
