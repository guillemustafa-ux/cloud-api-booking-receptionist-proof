import Anthropic from '@anthropic-ai/sdk';
import { LlmCallError, type Intent, type IntentInput, type LlmProvider } from './provider.js';

/** Default model; override with ANTHROPIC_MODEL. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

const SYSTEM = [
  'You read one WhatsApp message sent to a booking receptionist and report what it asks for.',
  'Always answer by calling the propose_booking tool exactly once.',
  'kind is "book" only when the message asks to book a specific day and time; otherwise "other".',
  'slot is the requested local date and time as "YYYY-MM-DD HH:MM" (24-hour clock), resolving',
  'relative days such as "tuesday" or "tomorrow" against the current time you are given; empty when kind is "other".',
  'name is the name the customer gives for the booking, or empty.',
].join(' ');

const PROPOSE_BOOKING = {
  name: 'propose_booking',
  description: 'Report the intent of the customer message: a booking request with its slot, or anything else.',
  strict: true,
  input_schema: {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', enum: ['book', 'other'] },
      slot: { type: 'string', description: 'YYYY-MM-DD HH:MM, or empty when kind is other' },
      name: { type: 'string', description: 'Name for the booking, or empty' },
    },
    required: ['kind', 'slot', 'name'],
    additionalProperties: false,
  },
};

/**
 * Claude through the Messages API, with one strict tool `propose_booking` that returns the
 * structured intent. The current Opus model refuses a forced `tool_choice` (`any` / `tool`), so
 * the request uses `auto` plus a system instruction; `strict: true` keeps the arguments schema-valid,
 * and a response without the tool call is read as `other`.
 *
 * The SDK's automatic retries are off (`maxRetries: 0`): a retried request that already reached
 * the API may be billed again, and that decision belongs to the receptionist's ledger.
 */
export function createClaudeLlm(opts: { apiKey: string; model?: string }): LlmProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
  const model = opts.model || DEFAULT_ANTHROPIC_MODEL;

  return {
    async extractIntent(input: IntentInput): Promise<Intent> {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model,
          max_tokens: 4096,
          output_config: { effort: 'low' },
          system: SYSTEM,
          tools: [PROPOSE_BOOKING],
          tool_choice: { type: 'auto' },
          messages: [
            {
              role: 'user',
              content: `Current time: ${input.nowIso}\nCustomer ${input.from} wrote:\n${input.text}`,
            },
          ],
        });
      } catch (err) {
        if (err instanceof Anthropic.APIConnectionError) throw new LlmCallError('unknown', err.name); // includes timeouts
        if (err instanceof Anthropic.APIError) throw new LlmCallError('rejected', `status ${err.status}`);
        throw err;
      }

      if (response.stop_reason === 'refusal') return { kind: 'other' };
      const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === PROPOSE_BOOKING.name);
      if (!call) return { kind: 'other' };
      const args = call.input as { kind?: string; slot?: string; name?: string };
      if (args.kind !== 'book' || !args.slot) return { kind: 'other' };
      return args.name ? { kind: 'book', slot: args.slot, name: args.name } : { kind: 'book', slot: args.slot };
    },
  };
}
