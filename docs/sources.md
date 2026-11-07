# Sources

Every statement in the README about Meta's Cloud API comes from one of these pages, read on
2026-11-07. Quotes are copied from the served pages. Where a statement is about what a page does
*not* say, that is listed separately at the end.

## Webhook verification and signature

**Create a webhook endpoint**:
<https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint>
(the older `/docs/whatsapp/cloud-api/webhooks/create-webhook-endpoint` URL answered 404 on 2026-11-07)

The page names the verification request's query parameters `hub.mode` (value `subscribe`),
`hub.challenge` and `hub.verify_token`.

> "If the request is valid, respond with HTTP status `200` and the `hub.challenge` value."

> "If the request is invalid, respond with a 400-level HTTP status code, or anything other than status `200`."

> `X-Hub-Signature-256: sha256=<SHA256_PAYLOAD_HASH>`

> "HMAC-SHA256 hash, calculated using the post body payload and your [app secret] as the secret key."

> "If any POST request sent to your server fails, delivery is retried immediately, then a few more
> times with decreasing frequency over the next 7 days. Your server should handle deduplication in
> these cases."

**Graph API webhooks, getting started**: <https://developers.facebook.com/docs/graph-api/webhooks/getting-started>

> "We sign all Event Notification payloads with a SHA256 signature and include the signature in the
> request's `X-Hub-Signature-256` header, preceded with `sha256=`."

## Retries

**Set up webhooks**: <https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks>

> "If a webhook request to your endpoint receives an HTTP status code other than 200, or if the
> webhook cannot be delivered for another reason, Meta retries delivery with decreasing frequency
> until the request succeeds, for up to 7 days."

> "These retries can result in duplicate webhook notifications."

## The customer service window

**Send messages**: <https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages>
(the `pricing/conversation-types` URL answered 404 on 2026-11-07, and its `documentation/...`
twin served only navigation)

> "When a WhatsApp user messages you or calls you, a 24-hour timer called a customer service window
> starts. If the user messages or calls you again before the timer expires, the timer resets to 24
> hours."

> "When the window closes, you can only send pre-approved template messages."

**Templates overview**: <https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview>

> "Template messages are the only type of message that can be sent to WhatsApp users outside of a
> customer service window."

The template request shape used here comes from the same page: `type: "template"`,
`template: {name, language: {code}, components: [{type: "body", parameters: [{type: "text", text}]}]}`.

## Error codes

**Error codes**: <https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes>

131047:

> "More than 24 hours have passed since the recipient last replied to the sender number."

> "Send the recipient a template message instead."

> "Cloud API errors are returned either synchronously as a Graph API response, asynchronously via
> Webhook, or sometimes through both methods."

The page's generic error JSON has `error.message`, `error.type`, `error.code`,
`error.error_data.messaging_product`, `error.error_data.details` and `error.fbtrace_id`
(`error_subcode` is marked deprecated). The fake Cloud API answers in that shape.

## Webhook payloads

**Webhook components**: <https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components>
and **status webhook reference**:
<https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status>

The inbound text example (`entry[].changes[].value.messages[].{from, id, timestamp, type, text.body}`,
`metadata.phone_number_id`, `contacts[].wa_id`) and the failed `statuses[]` example with
`errors[{code, title, message, error_data.details, href}]` are the shapes the fake delivers.

> "Outgoing message errors appear in the `statuses` array (`entry.changes.value.statuses.errors`)."

## Sending a text

**Text messages**: <https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages>

Request `{messaging_product, recipient_type, to, type: "text", text: {preview_url, body}}` and the
success body `{messaging_product, contacts[{input, wa_id}], messages[{id: "wamid...."}]}`.

> "WhatsApp Message ID. This ID appears in associated messages webhooks, such as sent, read, and
> delivered webhooks."

## Get started

**Get started**: <https://developers.facebook.com/docs/whatsapp/cloud-api/get-started>, step 3:

> "Add a To phone number that will receive the test message."

## Not found on the pages read

- **A deadline for answering `200`.** None of the pages above states one. The receiver here
  processes a delivery and then answers; the README does not claim any response deadline.
- **A limit on test recipient numbers.** The get-started page does not state one; the README does
  not assert one.
- **Whether 131047 specifically is synchronous or asynchronous.** The error-codes page says errors
  come synchronously, asynchronously, or both, without saying which for 131047. The suite covers
  both paths.
