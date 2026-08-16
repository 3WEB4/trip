/**
 * Minimal structured logger writing to stderr, so stdout stays reserved for
 * the JSON result the CLI prints.
 */

import { redactObject } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(fields ? (redactObject(fields) as Record<string, unknown>) : {}),
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
};
