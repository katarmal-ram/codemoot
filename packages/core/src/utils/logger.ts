// packages/core/src/utils/logger.ts

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = LOG_LEVELS[level];

  function log(msgLevel: LogLevel, message: string, args: unknown[]): void {
    if (LOG_LEVELS[msgLevel] >= threshold) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] ${msgLevel.toUpperCase()}:`;
      if (args.length > 0) {
        console[msgLevel === 'debug' ? 'log' : msgLevel](prefix, message, ...args);
      } else {
        console[msgLevel === 'debug' ? 'log' : msgLevel](prefix, message);
      }
    }
  }

  return {
    debug: (message, ...args) => log('debug', message, args),
    info: (message, ...args) => log('info', message, args),
    warn: (message, ...args) => log('warn', message, args),
    error: (message, ...args) => log('error', message, args),
  };
}
