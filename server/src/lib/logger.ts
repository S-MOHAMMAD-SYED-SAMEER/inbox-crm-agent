import { redactValue } from './redact.ts';

// Minimal logger: a tagged console wrapper that redacts before it prints.
//
// No logging library. What a logger buys at this size is levels, tags, and
// redaction — that is this file. The important property is not the formatting,
// it is that `log.info('[chat]', {...})` cannot print a customer's email body
// even if a caller passes one, because redaction happens here rather than at
// every call site where it would eventually be forgotten.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
};

export type LogSink = (level: LogLevel, message: string, context?: unknown) => void;

const consoleSink: LogSink = (level, message, context) => {
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (context === undefined) write(message);
  else write(message, context);
};

export function createLogger(
  tag: string,
  options: { level?: LogLevel; sink?: LogSink } = {},
): Logger {
  const minimum = LEVEL_ORDER[options.level ?? 'info'];
  const sink = options.sink ?? consoleSink;

  const emit = (level: LogLevel, message: string, context?: unknown): void => {
    if (LEVEL_ORDER[level] < minimum) return;
    if (context === undefined) sink(level, `[${tag}] ${message}`);
    else sink(level, `[${tag}] ${message}`, redactValue(context));
  };

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
  };
}

/** A logger that records instead of printing — for tests that assert on output. */
export function createMemoryLogger(tag = 'test'): {
  logger: Logger;
  entries: Array<{ level: LogLevel; message: string; context?: unknown }>;
} {
  const entries: Array<{ level: LogLevel; message: string; context?: unknown }> = [];
  const logger = createLogger(tag, {
    level: 'debug',
    sink: (level, message, context) => {
      entries.push(context === undefined ? { level, message } : { level, message, context });
    },
  });
  return { logger, entries };
}
