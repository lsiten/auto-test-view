/**
 * Network interception rule engine.
 * Uses CDP Fetch domain to intercept and modify network requests,
 * and CDP Network domain to capture traffic logs.
 */

import { getCdpClient } from "./cdp-client";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InterceptAction = "mock" | "block" | "modify" | "delay" | "fail";

export interface InterceptRule {
  readonly id: string;
  readonly urlPattern: string;
  readonly resourceType?: string;
  readonly method?: string;
  readonly action: InterceptAction;
  // mock
  readonly responseCode?: number;
  readonly responseHeaders?: Record<string, string>;
  readonly responseBody?: string;
  // modify
  readonly requestHeaders?: Record<string, string>;
  // delay
  readonly delayMs?: number;
  // fail
  readonly errorReason?: string;
}

export interface NetworkLogEntry {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType?: string;
  readonly requestHeaders?: Record<string, string>;
  readonly status?: number;
  readonly responseHeaders?: Record<string, string>;
  readonly timestamp: number;
}

export interface NetworkLogFilter {
  readonly urlPattern?: string;
  readonly method?: string;
  readonly statusCode?: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let rules: InterceptRule[] = [];
const MAX_LOG_ENTRIES = 500;
let logEntries: NetworkLogEntry[] = [];
let logEnabled = false;

// ---------------------------------------------------------------------------
// URL matching (glob-style)
// ---------------------------------------------------------------------------

const matchUrl = (url: string, pattern: string): boolean => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___DOUBLE___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DOUBLE___/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
};

const matchRule = (
  rule: InterceptRule,
  url: string,
  method: string,
  resourceType: string,
): boolean => {
  if (!matchUrl(url, rule.urlPattern)) return false;
  if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;
  if (rule.resourceType && rule.resourceType.toLowerCase() !== resourceType.toLowerCase()) return false;
  return true;
};

// ---------------------------------------------------------------------------
// CDP Fetch pattern sync
// ---------------------------------------------------------------------------

const syncFetchPatterns = async (): Promise<void> => {
  const client = getCdpClient();
  if (rules.length === 0) {
    try {
      await client.sendCommand("Fetch.disable", {});
    } catch {
      // Fetch may not be enabled yet
    }
    return;
  }
  const patterns = rules.map((r) => ({
    urlPattern: r.urlPattern,
    ...(r.resourceType ? { resourceType: r.resourceType } : {}),
  }));
  await client.sendCommand("Fetch.enable", { patterns });
};

// ---------------------------------------------------------------------------
// Fetch.requestPaused handler
// ---------------------------------------------------------------------------

const handleRequestPaused = async (params: unknown): Promise<void> => {
  const { requestId, request, resourceType } = params as {
    requestId: string;
    request: { url: string; method: string; headers: Record<string, string> };
    resourceType: string;
  };

  const client = getCdpClient();

  const matched = rules.find((r) => matchRule(r, request.url, request.method, resourceType));

  if (!matched) {
    try {
      await client.sendCommand("Fetch.continueRequest", { requestId });
    } catch (err) {
      logger.error("Failed to continue unmatched request", err);
    }
    return;
  }

  try {
    switch (matched.action) {
      case "mock": {
        const headers = Object.entries(matched.responseHeaders ?? {}).map(
          ([name, value]) => ({ name, value }),
        );
        await client.sendCommand("Fetch.fulfillRequest", {
          requestId,
          responseCode: matched.responseCode ?? 200,
          responseHeaders: headers,
          body: matched.responseBody
            ? Buffer.from(matched.responseBody).toString("base64")
            : undefined,
        });
        break;
      }
      case "block": {
        await client.sendCommand("Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        });
        break;
      }
      case "modify": {
        const merged = { ...request.headers, ...matched.requestHeaders };
        await client.sendCommand("Fetch.continueRequest", {
          requestId,
          headers: Object.entries(merged).map(([name, value]) => ({ name, value })),
        });
        break;
      }
      case "delay": {
        await new Promise((resolve) => setTimeout(resolve, matched.delayMs ?? 1000));
        await client.sendCommand("Fetch.continueRequest", { requestId });
        break;
      }
      case "fail": {
        await client.sendCommand("Fetch.failRequest", {
          requestId,
          errorReason: matched.errorReason ?? "Failed",
        });
        break;
      }
    }
  } catch (err) {
    logger.error(`Network intercept action '${matched.action}' failed for ${request.url}`, err);
    // Best-effort: try to continue the request so it doesn't hang
    try {
      await client.sendCommand("Fetch.continueRequest", { requestId });
    } catch {
      // nothing we can do
    }
  }
};

// ---------------------------------------------------------------------------
// Network log handlers
// ---------------------------------------------------------------------------

const handleRequestWillBeSent = (params: unknown): void => {
  if (!logEnabled) return;
  const { requestId, request, type } = params as {
    requestId: string;
    request: { url: string; method: string; headers: Record<string, string> };
    type: string;
  };

  const entry: NetworkLogEntry = {
    requestId,
    url: request.url,
    method: request.method,
    resourceType: type,
    requestHeaders: request.headers,
    timestamp: Date.now(),
  };
  logEntries.push(entry);
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries = logEntries.slice(-MAX_LOG_ENTRIES);
  }
};

const handleResponseReceived = (params: unknown): void => {
  if (!logEnabled) return;
  const { requestId, response } = params as {
    requestId: string;
    response: { status: number; headers: Record<string, string> };
  };
  const idx = logEntries.findIndex((e) => e.requestId === requestId);
  if (idx !== -1) {
    logEntries[idx] = {
      ...logEntries[idx],
      status: response.status,
      responseHeaders: response.headers,
    };
  }
};

// ---------------------------------------------------------------------------
// Rule management (public API)
// ---------------------------------------------------------------------------

let idCounter = 0;

const generateId = (): string => {
  idCounter += 1;
  return `rule-${Date.now()}-${idCounter}`;
};

export const addRule = async (rule: Omit<InterceptRule, "id">): Promise<InterceptRule> => {
  const newRule: InterceptRule = { ...rule, id: generateId() };
  rules = [...rules, newRule];
  await syncFetchPatterns();
  logger.info(`Network rule added: ${newRule.id} [${newRule.action}] ${newRule.urlPattern}`);
  return newRule;
};

export const removeRule = async (id: string): Promise<boolean> => {
  const before = rules.length;
  rules = rules.filter((r) => r.id !== id);
  if (rules.length === before) return false;
  await syncFetchPatterns();
  logger.info(`Network rule removed: ${id}`);
  return true;
};

export const listRules = (): ReadonlyArray<InterceptRule> => rules;

export const clearRules = async (): Promise<number> => {
  const count = rules.length;
  rules = [];
  await syncFetchPatterns();
  logger.info(`Network rules cleared (${count})`);
  return count;
};

// ---------------------------------------------------------------------------
// Network log (public API)
// ---------------------------------------------------------------------------

export const startNetworkLog = async (): Promise<void> => {
  const client = getCdpClient();
  await client.sendCommand("Network.enable", {});
  logEnabled = true;
  logger.info("Network log started");
};

export const stopNetworkLog = (): void => {
  logEnabled = false;
  logger.info("Network log stopped");
};

export const getNetworkLog = (filter?: NetworkLogFilter): ReadonlyArray<NetworkLogEntry> => {
  if (!filter) return logEntries;
  return logEntries.filter((entry) => {
    if (filter.urlPattern && !matchUrl(entry.url, filter.urlPattern)) return false;
    if (filter.method && entry.method.toUpperCase() !== filter.method.toUpperCase()) return false;
    if (filter.statusCode !== undefined && entry.status !== filter.statusCode) return false;
    return true;
  });
};

export const clearNetworkLog = (): void => {
  logEntries = [];
  logger.info("Network log cleared");
};

// ---------------------------------------------------------------------------
// Re-apply after navigation
// ---------------------------------------------------------------------------

export const reapplyRules = async (): Promise<void> => {
  if (rules.length > 0) {
    await syncFetchPatterns();
  }
  if (logEnabled) {
    const client = getCdpClient();
    await client.sendCommand("Network.enable", {});
  }
};

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export const initNetworkInterceptor = (): void => {
  const client = getCdpClient();
  client.on("Fetch.requestPaused", handleRequestPaused);
  client.on("Network.requestWillBeSent", handleRequestWillBeSent);
  client.on("Network.responseReceived", handleResponseReceived);
  logger.info("Network interceptor initialized");
};
