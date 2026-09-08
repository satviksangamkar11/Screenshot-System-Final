/** Minimal levelled logger. Capture runs are long, so output stays readable. */

/*
 * `ok` sits at the same severity as `info` for filtering purposes — it is
 * never hidden by the default threshold — but is kept as its own level
 * rather than folded into `info` so that a log sink (the web UI's job log)
 * can tell a positive confirmation ("captured Delivery Date") apart from a
 * neutral progress line ("Capturing new version…") and render it distinctly.
 * Previously `log.ok()` was tagged `info` like everything else, so the UI's
 * job log had no way to show anything as positive — only `warn`/`error` had
 * their own colour, which made a normal run's log read as an unbroken
 * stream of amber "skip" lines with no visible confirmation of what was
 * actually captured.
 */
const LEVELS = { debug: 10, info: 20, ok: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Receives every emitted line, so a running job can stream its own log. */
export type LogSink = (level: Level, message: string) => void;

const sinks = new Set<LogSink>();

export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function emit(level: Level, icon: string, msg: string, ...rest: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const line = `${ts()} ${icon} ${msg}`;
  if (level === 'error') console.error(line, ...rest);
  else if (level === 'warn') console.warn(line, ...rest);
  else console.log(line, ...rest);

  for (const sink of sinks) {
    try {
      sink(level, msg);
    } catch {
      /* a failing sink must never break the run */
    }
  }
}

export const log = {
  debug: (m: string, ...r: unknown[]) => emit('debug', '  ', m, ...r),
  info: (m: string, ...r: unknown[]) => emit('info', '›', m, ...r),
  step: (m: string, ...r: unknown[]) => emit('info', '→', m, ...r),
  ok: (m: string, ...r: unknown[]) => emit('ok', '✓', m, ...r),
  warn: (m: string, ...r: unknown[]) => emit('warn', '!', m, ...r),
  error: (m: string, ...r: unknown[]) => emit('error', '✗', m, ...r),
};
