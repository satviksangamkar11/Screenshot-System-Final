import { spawn, ChildProcess, execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export type ChromeLaunchErrorReason = 'binary-not-found' | 'port-bind-failed' | 'spawn-failed' | 'timeout';

export class ChromeLaunchError extends Error {
  constructor(
    public reason: ChromeLaunchErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'ChromeLaunchError';
  }
}

export interface ChromeInstance {
  process: ChildProcess;
  debuggerUrl: string;
  userDataDir: string;
  close: () => Promise<void>;
}

// Tracks every launched instance's temp profile dir so a crash of this process
// (not just a graceful close()) can still be swept via the exit handler below.
const activeUserDataDirs = new Set<string>();
let exitHandlerRegistered = false;

function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  process.on('exit', () => {
    for (const dir of activeUserDataDirs) {
      try {
        // Synchronous best-effort cleanup — 'exit' handlers cannot await.
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort; nothing more we can do at process exit.
      }
    }
  });
}

export async function launchChrome(opts: { headless?: boolean } = {}): Promise<ChromeInstance> {
  registerExitHandler();

  const headless = opts.headless ?? true;

  const chromePath = findChromeBinary();
  if (!chromePath) {
    throw new ChromeLaunchError('binary-not-found', 'Chrome or Edge not found. Please ensure Chrome/Edge is installed.');
  }

  const userDataDir = join(tmpdir(), `chrome-profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  activeUserDataDirs.add(userDataDir);

  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(chromePath, [
        ...(headless ? ['--headless=new'] : []),
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        'about:blank',
      ]);
    } catch (err) {
      activeUserDataDirs.delete(userDataDir);
      reject(new ChromeLaunchError('spawn-failed', `Failed to spawn Chrome: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    let stderrOutput = '';
    let isResolved = false;

    const makeClose = (debuggerUrl: string) => async () => {
      await killChromeProcess(proc);
      activeUserDataDirs.delete(userDataDir);
      try {
        await rm(userDataDir, { recursive: true, force: true });
      } catch {
        // Best effort — exit handler is the safety net if this fails mid-run.
      }
    };

    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        proc.kill();
        activeUserDataDirs.delete(userDataDir);
        reject(new ChromeLaunchError('timeout', 'Chrome launch timeout: debugger port not detected within 10s. If this recurs, consider --remote-debugging-pipe as a fallback (documented follow-up).'));
      }
    }, 10000);

    proc.stderr?.on('data', (data) => {
      const output = data.toString();
      stderrOutput += output;

      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match && !isResolved) {
        isResolved = true;
        clearTimeout(timeout);
        const debuggerUrl = match[1];
        resolve({
          process: proc,
          debuggerUrl,
          userDataDir,
          close: makeClose(debuggerUrl),
        });
      }
    });

    proc.on('error', (err) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeout);
        activeUserDataDirs.delete(userDataDir);
        reject(new ChromeLaunchError('spawn-failed', `Failed to spawn Chrome: ${err.message}`));
      }
    });

    proc.on('exit', (code) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeout);
        activeUserDataDirs.delete(userDataDir);
        const reason: ChromeLaunchErrorReason = stderrOutput.includes('bind') ? 'port-bind-failed' : 'spawn-failed';
        reject(new ChromeLaunchError(reason, `Chrome exited with code ${code} before debugger port was detected. stderr: ${stderrOutput}`));
      }
    });
  });
}

function findChromeBinary(): string | null {
  const candidates: string[] = [];

  // Windows paths for Chrome
  candidates.push(
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  );

  // Windows paths for Edge
  candidates.push(
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
  );

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: registry lookup on Windows
  try {
    const regPath = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe';
    const result = execSync(`reg query "${regPath}" /ve`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    const match = result.match(/REG_SZ\s+(.+)/);
    if (match && match[1]) {
      const path = match[1].trim();
      if (existsSync(path)) {
        return path;
      }
    }
  } catch {
    // Registry lookup failed, continue to next fallback
  }

  return null;
}

async function killChromeProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }

    proc.once('exit', () => resolve());
    proc.kill();

    setTimeout(() => {
      try {
        proc.kill(9 as unknown as NodeJS.Signals);
      } catch {
        // Already dead
      }
      resolve();
    }, 3000);
  });
}
