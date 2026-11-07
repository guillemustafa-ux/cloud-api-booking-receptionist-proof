/**
 * The one thing the receptionist asks a language model: what does this message want?
 * The reply text is composed by the receptionist from the intent, so the suite stays
 * deterministic under any provider.
 */
export type Intent =
  | { kind: 'book'; slot: string; name?: string }
  /** `note` says why, when the provider can tell (for example a refusal); the ledger keeps it. */
  | { kind: 'other'; note?: string };

export interface IntentInput {
  text: string;
  from: string;
  /** The receptionist's current time, ISO 8601, so relative days ("tuesday") can be resolved. */
  nowIso: string;
}

export interface LlmProvider {
  /**
   * `callKey` identifies this paid request in the receptionist's ledger. Providers may forward
   * it (the simulated one sends it as a header) or ignore it.
   */
  extractIntent(input: IntentInput, opts?: { callKey?: string }): Promise<Intent>;
}

/**
 * How a paid call ended when it did not produce an intent.
 *
 *   rejected  the provider answered with an error status; the simulated provider does not bill those
 *   unknown   timeout or dropped connection after sending: the provider may have billed it
 */
export class LlmCallError extends Error {
  constructor(
    readonly outcome: 'rejected' | 'unknown',
    detail: string,
  ) {
    super(`llm call ${outcome}: ${detail}`);
    this.name = 'LlmCallError';
  }
}
