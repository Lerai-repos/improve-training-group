/* eslint-disable no-console */
import { isProductionEnvironment, isDevelopmentEnvironment } from '@lib/constants';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogMeta {
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const isEnabled = (): boolean => {
  const envValue = process.env.LOG_ENABLED;
  if (envValue !== undefined) {
    return envValue === 'true';
  }
  // Default: enabled in development, disabled in production
  return isDevelopmentEnvironment;
};

const getMinLevel = (): LogLevel => {
  const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  if (envLevel && LOG_LEVELS[envLevel] !== undefined) {
    return envLevel;
  }
  return isProductionEnvironment ? 'info' : 'debug';
};

const shouldLog = (level: LogLevel): boolean => {
  if (!isEnabled()) {
    return false;
  }
  return LOG_LEVELS[level] >= LOG_LEVELS[getMinLevel()];
};

const formatMessage = (level: LogLevel, message: string, meta?: LogMeta): string => {
  const timestamp = new Date().toISOString();

  if (isProductionEnvironment) {
    // Structured JSON for production
    return JSON.stringify({
      timestamp,
      level,
      message,
      ...(meta && { meta }),
    });
  }

  // Human-readable for development
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
};

const createLogger = () => ({
  debug: (message: string, meta?: LogMeta) => {
    if (shouldLog('debug')) {
      console.debug(formatMessage('debug', message, meta));
    }
  },

  info: (message: string, meta?: LogMeta) => {
    if (shouldLog('info')) {
      console.info(formatMessage('info', message, meta));
    }
  },

  warn: (message: string, meta?: LogMeta) => {
    if (shouldLog('warn')) {
      console.warn(formatMessage('warn', message, meta));
    }
  },

  error: (message: string, meta?: LogMeta) => {
    if (shouldLog('error')) {
      console.error(formatMessage('error', message, meta));
    }
  },
});

// Singleton instance
export const log = createLogger();

// Re-export for custom instances or testing
export { createLogger };
export type { LogLevel, LogMeta };
