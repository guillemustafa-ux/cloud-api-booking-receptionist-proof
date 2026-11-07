# cloud-api-booking-receptionist-proof

A booking receptionist for WhatsApp Business messaging on Meta's Cloud API, in Node + TypeScript
with SQLite, showing that a **redelivered webhook neither books twice nor pays the LLM twice**, and
that replies respect the **24-hour customer service window**, with error 131047 handled on both of
its paths and left visible in the ledger. Tested with a fake LLM that bills over real HTTP, a fake
Cloud API that signs and redelivers webhooks, and a receiver process killed with `SIGKILL`
mid-request.

| The ask | Where it is covered |
| --- | --- |
| "Prevent duplicate texts and conflicting automations" | scenarios (b), (c), (d), (e): one charge, one booking, one reply per message; (k): one template per failed message |
| "WhatsApp receptionist on Cloud API + Claude" | the receptionist itself; `LLM=claude` runs it on Claude (see [LIVE](#live)) |
| "bought the official WhatsApp API, Chatwoot is not receiving messages (webhook/auth suspected)" | the verification handshake and the signature check a receiver has to pass, with every rejection case tested; Chatwoot itself is not part of this repo |

## What it proves

A paid call ends in one of three ways: **it worked**, **it failed**, or **nobody can tell**. The
third one is where money leaks. A receiver that dies after the LLM billed, or a connection that
drops before the answer arrives, leaves a call that may or may not have been charged. Meta then
retries the delivery (its documentation says retries "can result in duplicate webhook
notifications" and that "Your server should handle deduplication in these cases";
[docs/sources.md](docs/sources.md)). Processing the redelivery as new pays again and books again.

The honest receptionist (`src/honest/`) does four things:

1. **Inbox first.** An `inbox` row keyed by the WhatsApp message id (`messages[].id`) is written
   with `INSERT ... ON CONFLICT DO NOTHING` synchronously, before any `await`, before the LLM is
   called and before any booking. A conflict is a redelivery: the row's `deliveries` counter goes
   up, nothing else runs, and the receiver still answers `200`.
2. **A ledger row before every paid call.** An `llm_calls` row (`call_key = <message id>:<attempt>`,
   status `started`) is committed before the request leaves. The intent, the booking, the ledger's
   `done` state and the pending reply are then written in one transaction.
3. **Unknown means stop, not retry.** A dropped connection or timeout marks the call `unknown` and
   the message `unconfirmed`. A call still `started` when a process opens the file belonged to a
   process that died: it is marked the same way at start-up. Nothing calls the LLM again for that
   message. An error status from the LLM (the fake does not bill those) is retried once.
4. **The database refuses a second booking.** `bookings.inbound_message_id` is `UNIQUE`, so even
   with the inbox check gone a second booking for the same message fails.

`npm run inspect -- <db>` prints the inbox, the calls, the bookings and the outbound messages, so
an `unconfirmed` message and its call key are there to see.

The naive twin (`src/naive/`) is what a first version usually looks like: call the model for every
delivery, save the booking, reply with a text. No inbox, no ledger before the call, no window
check, and a failed status webhook is not read. It shares the receiver, so it does check
signatures; the A/B is about what happens after a delivery is accepted. Same public interface, so
one suite drives both.

## A/B: what each side was billed

Every number below is a literal in an assertion in [`test/redelivery.test.ts`](test/redelivery.test.ts)
and [`test/crash.test.ts`](test/crash.test.ts). "Charges" are requests the fake LLM billed;
"replies" are texts the fake Cloud API accepted.

| Scenario | Naive: charges, bookings, replies | Honest: charges, bookings, replies |
| --- | --- | --- |
| (a) one inbound "book tuesday 15:00 for Ana" | 1, 1, 1 | 1, 1, 1 (the reply is a text) |
| (b) the same POST, same bytes and signature, delivered 5 times | 5, 5, 5 | 1, 1, 1; the inbox row counts 5 deliveries |
| (c) two simultaneous deliveries of the same POST | 2, 2, 2 | 1, 1, 1; the inbox row counts 2 deliveries |
| (d) receiver process `SIGKILL`ed after the LLM billed, before the booking; redelivered to a fresh process on the same file | 2, 1, 1 | 1, 0, 0; call `unknown`, message `unconfirmed`, both listed by `npm run inspect` |
| (e) the LLM bills, then drops the connection; the delivery is redelivered | 2, 1, 1 (the first delivery answered `500`) | 1, 0, 0; call `unknown`, message `unconfirmed`, 2 deliveries |
| (f) the LLM answers `500` (not billed), then succeeds | 1, 1, 1 (the first delivery answered `500`; the redelivery booked and replied) | 1, 1, 1; attempt 1 `failed`, attempt 2 `done`, 2 requests |
| (g) a second booking for the same message, inserted straight into the database | not tested | refused: `UNIQUE constraint failed: bookings.inbound_message_id` |

In (d) the one charge on the honest side is the one made before the crash; the redelivery adds none.
In (f) the naive twin recovers by redelivery because the fake does not bill an error status; whether
a real provider bills a given error status was not verified here.

## The 24-hour window and error 131047

Meta's documentation: "When the window closes, you can only send pre-approved template messages"
([docs/sources.md](docs/sources.md)). The receptionist keeps `conversations.last_inbound_at` from
every verified inbound `messages[].timestamp` and decides at send time: inside 24 hours a text,
past it the template (`TEMPLATE_NAME`, `TEMPLATE_LANGUAGE`, the booking slot as its one body
parameter). The clock is injectable; the tests step it across the boundary. Assertions in
[`test/window.test.ts`](test/window.test.ts).

The error-codes page says "Cloud API errors are returned either synchronously as a Graph API
response, asynchronously via Webhook, or sometimes through both methods", and does not say which
for 131047, so both paths are tested. To make the receptionist send a text that Meta refuses, the
test writes a later `last_inbound_at` into the receiver's database: the receiver believes the
window is open while the fake Cloud API's own view says it closed.

| Scenario | Naive | Honest |
| --- | --- | --- |
| (h) reminder 23 h 59 m after the last inbound message | not tested | a text, `sent` |
| (i) reminder 24 h 01 m after | a text, refused with 131047; `sendReminders()` throws and no record of the failed reminder exists | the template, slot `2026-11-10 15:00` as its body parameter, `sent` |
| (j) synchronous 131047: a `400` with the documented error body | see (i) | reminder row `failed`, `error_code` 131047, its text kept; **one** template sent, linked by `fallback_of`; visible in `npm run inspect` |
| (k) asynchronous 131047: `200` with a `wamid`, then a signed `statuses` webhook with `status: "failed"` | the status is not read: 0 templates, nothing records the failure | the row turns `failed` with 131047; **one** template; the redelivered status webhook sends no second one (`fallback_of` is `UNIQUE`) |
| (l) messages at T0, T0 + 2 h, then an older one delivered late | not tested | `last_inbound_at` is T0 + 2 h and stays there |

The receiver processes a delivery and then answers `200`. That keeps the tests deterministic. The
pages read do not state a deadline for that answer, and this README does not claim one.

## The suite bites: footguns

Each file in [`footguns/`](footguns/) is a small patch that reintroduces one real mistake.
`npm run footgun <name>` applies it, runs the whole suite, reverts it, and prints `PASS` only when
**exactly** the tests listed in [`footguns/manifest.json`](footguns/manifest.json) fail and every
other test stays green. All seven print `PASS` locally; CI has not yet run them.

| Footgun | The mistake | Tests that fail |
| --- | --- | --- |
| `skip-signature-check` | `verifySignature` returns `true` before looking at the header | the six signature rejections and "a receiver with no APP_SECRET configured accepts nothing" |
| `no-inbox-dedupe` | an inbox conflict no longer stops processing | (b) honest (5 charges), (c) honest, (d) honest, (e) honest (2 each) |
| `ledger-after-call` | the `llm_calls` row is written after the LLM answers | (d) honest: after the crash there is no row at all |
| `text-outside-window` | any known customer gets a text, however long ago they wrote | (i) honest |
| `swallow-131047` | a failed send is dropped: no record, no fallback | (j) honest, (k) honest |
| `fallback-template-twice` | `outbound.fallback_of` is not unique | (k) honest: the redelivered status sends a second template |
| `no-booking-unique` | `bookings.inbound_message_id` is not unique | (g) honest |

Under `no-inbox-dedupe` the redeliveries in (b) also answer `500`: they reach the LLM, and then the
`UNIQUE` booking column refuses the second booking. That is the defense in depth of point 4 doing
its job after the money is already spent.

## Run it

Node 22.12 or later is declared in `engines`; exercised locally on Node 24.16 on Windows 11.
No Docker, no API key, no network beyond npm.

```bash
npm ci
npm test               # 37 tests: 12 webhook/signature, 11 redelivery, 7 window, 2 crash, 5 for the fakes
npm run typecheck
npm run footgun no-inbox-dedupe
npm run inspect -- path/to/ledger.db
```

Every test opens its own SQLite file under the OS temp dir. The crash test runs the receiver as a
separate process (`node --import tsx src/main.ts`) that kills itself with `SIGKILL` at
`FAULT=after_charge`, right after the LLM answered; nothing after that point runs, not even a
`finally`.

The workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the suite and the
typecheck on Ubuntu and Windows with Node 22, and the footgun matrix on Ubuntu. **Not yet run in
CI.**

To run the receiver yourself: `node --import tsx src/main.ts` with the variables listed at the top
of [`src/main.ts`](src/main.ts) (names only in [`.env.example`](.env.example)). It prints
`listening on <url>`; the webhook is `<url>/webhook`.

## LIVE

Everything in the tables above ran against local fakes. The two blocks below are the only live
runs; each says whether it ran.

### Live: Claude (simulated Cloud API)

**Not run yet.**

`npm run live:claude` runs the honest receptionist with the simulated Cloud API and the real Claude
(`LLM=claude`, `src/llm/claude.ts`, Messages API with one strict tool `propose_booking`; the model
is `ANTHROPIC_MODEL`, default `claude-opus-5-5`). It sends a booking request and an unrelated
question, then redelivers the booking POST, and prints the structured intents, the booking row, the
number of requests sent to Claude (expected 2, not 3) and the outbound messages. `ANTHROPIC_API_KEY`
comes from the environment or a git-ignored `.env.local`; it is never printed. Without it the script
prints a skip line and exits 0. The SDK's automatic retries are off: a retried request may be billed
again, and that decision belongs to the ledger.

### Live: Cloud API

**Not run yet.**

`npm run live:cloud-api` sends one text and one template through the real Graph API with the same
client the receptionist uses (`CLOUD_API_TOKEN`, `PHONE_NUMBER_ID`, `TO_NUMBER`, `GRAPH_API_VERSION`,
`TEMPLATE_NAME`, `TEMPLATE_LANGUAGE`). Without them it prints a skip line and exits 0.

Not run live in either block: webhook delivery from Meta, its signatures and its retries; a real
131047 on either path; the crash scenario. Until a live run says otherwise, the fake Cloud API's
behaviour is **modelled from the documentation, not observed live**.

## Limitations, stated plainly

- **One SQLite file, one receiver process per file.** The start-up sweep assumes any `started` call
  in the file belonged to a process that died.
- **A charge made before a crash is made visible, not recovered.** The message stops in
  `unconfirmed` with an `unknown` call; something (an operator, a policy) has to decide whether to
  pay again.
- **No slot capacity or calendar.** Two customers can book the same slot.
- **No human handoff.** Messages that are not booking requests get a fixed answer.
- **No media.** Non-text messages are recorded as `ignored`.
- **One template.** It carries the booking slot; a failed text that has no booking gets no fallback.
- **Only failed statuses are read.** `sent`, `delivered` and `read` statuses are not stored.
- **A crash after the booking and before the reply leaves a `pending` outbound row.** It is visible;
  it is not resent automatically.
- **The fake Cloud API is modelled from the documentation, not observed live.** Its error text and
  timing are this repo's, shaped after the documented examples.
- **Not run against any customer's account.** The LLM and the Cloud API are local fakes in every test.

## Layout

```text
src/server.ts                  node:http receiver: GET verification, POST signature over raw bytes
src/signature.ts               X-Hub-Signature-256: HMAC-SHA256, constant-time compare
src/webhook.ts                 inbound messages and statuses from the webhook payload
src/receptionist.ts            shared interface, window rule, deterministic reply text
src/honest/receptionist.ts     inbox, llm_calls ledger, bookings, outbound with fallback_of
src/honest/schema.sql          the honest ledger's tables
src/honest/inspect.ts          the readable dump behind `npm run inspect`
src/naive/receptionist.ts      the naive twin (tests only)
src/cloud-api-client.ts        text and template sends -> accepted | error | unknown
src/llm/provider.ts            LlmProvider.extractIntent and the call outcomes
src/llm/simulated.ts           client for the fake LLM
src/llm/claude.ts              Claude adapter (LLM=claude)
src/main.ts                    the receiver as a process; FAULT=after_charge kills it
test/*.test.ts                 webhook-signature, redelivery, crash, window, fakes
test/support/                  fake LLM, fake Cloud API, harness, receiver process
scripts/live-claude.ts         live run: simulated Cloud API + real Claude
scripts/live-cloud-api.ts      live run: real Graph API, one text and one template
scripts/inspect.ts             npm run inspect -- <db>
footguns/                      one patch per mistake + manifest of the tests it must fail
scripts/footgun.mjs            apply, run, revert, strict verdict
docs/sources.md                Meta's documentation, quoted, with URLs and the date read
```

## License

MIT
