import { existsSync, readFileSync } from 'node:fs';

/**
 * Environment access for the process entry and the live scripts.
 *
 * Values are read from `process.env`, after loading a git-ignored `.env.local` if one exists
 * (variables already set in the environment win). Surrounding double quotes are stripped:
 * `APP_SECRET="abc"` in a dotenv-style file must compare equal to `abc`.
 */
export function loadEnvLocal(path = '.env.local'): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const [, key, value] = match;
    if (process.env[key!] === undefined) process.env[key!] = value;
  }
}

/** The variable's value with every double quote removed, or `fallback` when unset or empty. */
export function env(name: string, fallback = ''): string {
  const value = (process.env[name] ?? '').replace(/"/g, '').trim();
  return value === '' ? fallback : value;
}

/** The variable's value, which must be one of `allowed`; `fallback` when unset. Throws `unknown <NAME> <value>`. */
export function envOneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = env(name, fallback);
  if (!allowed.includes(value as T)) throw new Error(`unknown ${name} ${value} (allowed: ${allowed.join(', ')})`);
  return value as T;
}

/** The variable's value; throws `missing required environment variable <NAME>` when unset or empty. */
export function envRequired(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}
