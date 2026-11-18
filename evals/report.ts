/** The markdown report of a red-team run: counts first, every finding listed, then what the run does not show. */
import { costUsd } from './model.js';
import type { RunResult } from './run.js';

export interface RunMeta {
  attacker: string;
  defender: string;
  reps: number;
  maxTurns: number;
}

const usd = (v: number | undefined) => (v === undefined ? 'n/a' : `USD ${v.toFixed(4)}`);

export function renderReport(runs: RunResult[], meta: RunMeta): string {
  const byScenario = new Map<string, RunResult[]>();
  for (const r of runs) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) ?? []), r]);
  const withKind = (rs: RunResult[], kind: string) => rs.filter((r) => r.findings.some((f) => f.kind === kind)).length;

  const lines = [
    '# Red-team run',
    '',
    `Attacker: ${meta.attacker}. Defender (the model that reads each customer message): ${meta.defender}. ` +
      `${runs.length} runs, ${meta.reps} per scenario, ${meta.maxTurns} turns at most per run. The receptionist, its ledger and the ` +
      'signed webhook are the real ones; the Cloud API is the local fake; the clock is fixed. A finding is decided by the checks in ' +
      '`evals/checks.ts`, not by a model. A run the API refused never started and tests nothing.',
    '',
    '| Scenario | Runs | Attacker refused | Messages | Defender requests | Defender refusals | Runs with a guard finding | Runs with a gap | Runs with the declared limit |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [scenario, rs] of byScenario) {
    lines.push(
      `| ${scenario} | ${rs.length} | ${rs.filter((r) => r.attacker.refusal).length} | ${rs.reduce((n, r) => n + r.turns.length, 0)} | ` +
        `${rs.reduce((n, r) => n + r.defender.requests, 0)} | ${rs.reduce((n, r) => n + r.defender.refusals, 0)} | ` +
        `${withKind(rs, 'guard')} | ${withKind(rs, 'gap')} | ${withKind(rs, 'declared')} |`,
    );
  }

  const tested = runs.filter((r) => r.turns.length > 0);
  const refused = runs.filter((r) => r.attacker.refusal);
  const attackerIn = runs.reduce((n, r) => n + (r.attacker.inputTokens ?? 0), 0);
  const attackerOut = runs.reduce((n, r) => n + (r.attacker.outputTokens ?? 0), 0);
  const defenderIn = runs.reduce((n, r) => n + (r.defender.tokens?.input ?? 0), 0);
  const defenderOut = runs.reduce((n, r) => n + (r.defender.tokens?.output ?? 0), 0);
  const guard = runs.reduce((n, r) => n + r.findings.filter((f) => f.kind === 'guard').length, 0);
  const cost = [costUsd(meta.attacker, attackerIn, attackerOut), costUsd(meta.defender, defenderIn, defenderOut)];
  lines.push(
    '',
    `**Guard findings: ${guard}** across ${tested.length} runs that sent at least one message ` +
      `(${tested.reduce((n, r) => n + r.turns.length, 0)} messages or requests, ${runs.reduce((n, r) => n + r.defender.requests, 0)} paid requests by the defender). ` +
      `${refused.length} of ${runs.length} runs were refused by the API's own safeguards and prove nothing.`,
    '',
    `Tokens: attacker ${attackerIn} in / ${attackerOut} out, defender ${defenderIn} in / ${defenderOut} out. ` +
      `At the list price in \`evals/model.ts\`: ${usd(cost[0])} + ${usd(cost[1])}; the console shows what was billed.`,
    '',
    '## Findings',
    '',
  );
  const found = runs.flatMap((r, i) => r.findings.map((f) => ({ r, i, f })));
  if (found.length === 0) lines.push('None.');
  for (const { r, i, f } of found) lines.push(`- ${r.scenario} #${i + 1} (${r.side}): **${f.kind}** \`${f.check}\` ${f.detail}`);
  lines.push('');
  return lines.join('\n');
}
