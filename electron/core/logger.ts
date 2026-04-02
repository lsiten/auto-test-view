/**
 * Simple logger that writes to stderr to avoid polluting MCP stdio transport on stdout.
 */

const LOG_PREFIX = "[auto-test-view]";

const formatMessage = (level: string, message: string, ...args: unknown[]): string => {
  const timestamp = new Date().toISOString();
  const extra = args.length > 0 ? " " + args.map(a => JSON.stringify(a)).join(" ") : "";
  return `${timestamp} ${LOG_PREFIX} ${level}: ${message}${extra}`;
};

export const logger = {
  info: (message: string, ...args: unknown[]): void => {
    process.stderr.write(formatMessage("INFO", message, ...args) + "\n");
  },
  warn: (message: string, ...args: unknown[]): void => {
    process.stderr.write(formatMessage("WARN", message, ...args) + "\n");
  },
  error: (message: string, ...args: unknown[]): void => {
    process.stderr.write(formatMessage("ERROR", message, ...args) + "\n");
  },
  debug: (message: string, ...args: unknown[]): void => {
    if (process.env.DEBUG) {
      process.stderr.write(formatMessage("DEBUG", message, ...args) + "\n");
    }
  },
};
