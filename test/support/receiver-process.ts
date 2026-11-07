import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CrashPoint } from '../../src/crash.js';
import { APP_SECRET, CLOUD_TOKEN, GRAPH_VERSION, PHONE_NUMBER_ID, TEMPLATE_LANGUAGE, TEMPLATE_NAME, VERIFY_TOKEN, type Side } from './harness.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  crashedAt: CrashPoint | undefined;
  output: string;
}

export interface ReceiverProcess {
  url: string;
  exited: Promise<ProcessExit>;
  stop(): Promise<ProcessExit>;
}

/** The receiver in a separate OS process: `node --import tsx src/main.ts`. Resolves once it listens. */
export function startReceiverProcess(opts: {
  side: Side;
  dbPath: string;
  llmUrl: string;
  cloudUrl: string;
  fault?: CrashPoint;
}): Promise<ReceiverProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SIDE: opts.side,
      DB_PATH: opts.dbPath,
      LLM: 'simulated',
      LLM_URL: opts.llmUrl,
      CLOUD_API_BASE_URL: opts.cloudUrl,
      GRAPH_API_VERSION: GRAPH_VERSION,
      PHONE_NUMBER_ID,
      CLOUD_API_TOKEN: CLOUD_TOKEN,
      APP_SECRET,
      VERIFY_TOKEN,
      TEMPLATE_NAME,
      TEMPLATE_LANGUAGE,
      FAULT: opts.fault ?? '',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise<ProcessExit>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      const crashed = /crash: (after_charge)/.exec(output);
      resolve({ code, signal, crashedAt: crashed?.[1] as CrashPoint | undefined, output });
    });
  });

  return new Promise((resolve, reject) => {
    const onData = (d: Buffer) => {
      output += d.toString();
      const m = /listening on (http:\/\/\S+)/.exec(output);
      if (m) {
        child.stdout.off('data', onData);
        child.stdout.on('data', (more: Buffer) => (output += more.toString()));
        resolve({
          url: m[1]!,
          exited,
          stop: () => {
            child.kill();
            return exited;
          },
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    exited.then((e) => reject(new Error(`receiver exited before listening (code ${e.code}): ${e.output}`)), reject);
  });
}

/** How the OS reports a process that SIGKILLed itself: a signal on POSIX, exit code 1 on Windows. */
export function killedBySigkill(exit: ProcessExit): boolean {
  return process.platform === 'win32' ? exit.code === 1 && exit.signal === null : exit.signal === 'SIGKILL';
}
