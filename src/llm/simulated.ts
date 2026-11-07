import { LlmCallError, type Intent, type IntentInput, type LlmProvider } from './provider.js';

/**
 * HTTP client for the simulated LLM (test/support/fake-llm.ts). The fake bills per request,
 * like a paid API; this client turns its answers into an intent or an `LlmCallError` whose
 * outcome says whether the request may have been billed.
 */
export function createSimulatedLlm(opts: { url: string; timeoutMs?: number }): LlmProvider {
  return {
    async extractIntent(input: IntentInput, call?: { callKey?: string }): Promise<Intent> {
      let response: Response;
      try {
        response = await fetch(`${opts.url}/v1/intent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-call-key': call?.callKey ?? '' },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
        });
      } catch (err) {
        const code = errorCode(err);
        // Refused connection: the request never left, nothing can have been billed.
        if (code === 'ECONNREFUSED') throw new LlmCallError('rejected', code);
        throw new LlmCallError('unknown', code);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new LlmCallError('rejected', `status ${response.status}`);
      }
      try {
        return (await response.json()) as Intent;
      } catch (err) {
        throw new LlmCallError('unknown', `body: ${errorCode(err)}`);
      }
    },
  };
}

function errorCode(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code ?? e?.name ?? 'Error';
}
