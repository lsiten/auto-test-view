/**
 * Tests for electron/core/network-interceptor.ts
 *
 * Verifies:
 *   - URL glob matching (matchUrl)
 *   - Rule CRUD (add, remove, list, clear)
 *   - Fetch.requestPaused handler (mock, block, modify, delay, fail)
 *   - Network log capture and filtering
 *   - CDP pattern sync
 *   - Error recovery in request handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../electron/core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSendCommand = vi.fn();
const mockCdpOn = vi.fn();
const mockCdpOff = vi.fn();

vi.mock("../electron/core/cdp-client", () => ({
  getCdpClient: () => ({
    sendCommand: mockSendCommand,
    on: mockCdpOn,
    off: mockCdpOff,
    isAttached: () => true,
    detach: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mod: typeof import("../electron/core/network-interceptor");

beforeEach(async () => {
  vi.resetModules();
  mockSendCommand.mockReset().mockResolvedValue(undefined);
  mockCdpOn.mockReset();
  mockCdpOff.mockReset();

  mod = await import("../electron/core/network-interceptor");
});

// =========================================================================
// Rule management
// =========================================================================

describe("rule management", () => {
  it("addRule creates rule with generated id", async () => {
    const rule = await mod.addRule({
      urlPattern: "https://api.example.com/*",
      action: "mock",
      responseCode: 200,
      responseBody: '{"ok":true}',
    });

    expect(rule.id).toMatch(/^rule-/);
    expect(rule.urlPattern).toBe("https://api.example.com/*");
    expect(rule.action).toBe("mock");
  });

  it("addRule syncs CDP Fetch patterns", async () => {
    await mod.addRule({ urlPattern: "https://*.test.com/*", action: "block" });

    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [{ urlPattern: "https://*.test.com/*" }],
    });
  });

  it("addRule includes resourceType in CDP pattern when specified", async () => {
    await mod.addRule({
      urlPattern: "https://cdn.example.com/*",
      resourceType: "Image",
      action: "block",
    });

    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [{ urlPattern: "https://cdn.example.com/*", resourceType: "Image" }],
    });
  });

  it("listRules returns all added rules", async () => {
    await mod.addRule({ urlPattern: "https://a.com/*", action: "mock" });
    await mod.addRule({ urlPattern: "https://b.com/*", action: "block" });

    const rules = mod.listRules();
    expect(rules).toHaveLength(2);
    expect(rules[0].urlPattern).toBe("https://a.com/*");
    expect(rules[1].urlPattern).toBe("https://b.com/*");
  });

  it("removeRule removes by id and returns true", async () => {
    const rule = await mod.addRule({ urlPattern: "https://a.com/*", action: "mock" });
    const result = await mod.removeRule(rule.id);

    expect(result).toBe(true);
    expect(mod.listRules()).toHaveLength(0);
  });

  it("removeRule returns false for non-existent id", async () => {
    const result = await mod.removeRule("non-existent");
    expect(result).toBe(false);
  });

  it("clearRules removes all rules and disables Fetch", async () => {
    await mod.addRule({ urlPattern: "https://a.com/*", action: "mock" });
    await mod.addRule({ urlPattern: "https://b.com/*", action: "block" });

    mockSendCommand.mockReset().mockResolvedValue(undefined);
    const count = await mod.clearRules();

    expect(count).toBe(2);
    expect(mod.listRules()).toHaveLength(0);
    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.disable", {});
  });
});

// =========================================================================
// Network log
// =========================================================================

describe("network log", () => {
  it("getNetworkLog returns empty array initially", () => {
    expect(mod.getNetworkLog()).toEqual([]);
  });

  it("clearNetworkLog empties the log", () => {
    mod.clearNetworkLog();
    expect(mod.getNetworkLog()).toEqual([]);
  });

  it("startNetworkLog enables Network domain via CDP", async () => {
    await mod.startNetworkLog();
    expect(mockSendCommand).toHaveBeenCalledWith("Network.enable", {});
  });

  it("getNetworkLog filters by urlPattern", () => {
    // No entries to filter, should return empty
    const filtered = mod.getNetworkLog({ urlPattern: "https://api.*" });
    expect(filtered).toEqual([]);
  });

  it("getNetworkLog filters by method", () => {
    const filtered = mod.getNetworkLog({ method: "POST" });
    expect(filtered).toEqual([]);
  });

  it("getNetworkLog filters by statusCode", () => {
    const filtered = mod.getNetworkLog({ statusCode: 404 });
    expect(filtered).toEqual([]);
  });
});

// =========================================================================
// initNetworkInterceptor
// =========================================================================

describe("initNetworkInterceptor", () => {
  it("registers CDP event listeners", () => {
    mod.initNetworkInterceptor();

    expect(mockCdpOn).toHaveBeenCalledWith("Fetch.requestPaused", expect.any(Function));
    expect(mockCdpOn).toHaveBeenCalledWith("Network.requestWillBeSent", expect.any(Function));
    expect(mockCdpOn).toHaveBeenCalledWith("Network.responseReceived", expect.any(Function));
  });
});

// =========================================================================
// Fetch.requestPaused handler behavior
// =========================================================================

describe("request interception", () => {
  let handleRequestPaused: (params: unknown) => Promise<void>;

  beforeEach(() => {
    mod.initNetworkInterceptor();
    // Extract the registered handler
    const pausedCall = mockCdpOn.mock.calls.find(
      (c) => c[0] === "Fetch.requestPaused"
    );
    handleRequestPaused = pausedCall![1];
  });

  it("continues unmatched requests", async () => {
    await handleRequestPaused({
      requestId: "req-1",
      request: { url: "https://unmatched.com/path", method: "GET", headers: {} },
      resourceType: "Document",
    });

    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "req-1" });
  });

  it("fulfills mock action with response", async () => {
    await mod.addRule({
      urlPattern: "https://api.example.com/*",
      action: "mock",
      responseCode: 201,
      responseHeaders: { "Content-Type": "application/json" },
      responseBody: '{"id":1}',
    });

    mockSendCommand.mockReset().mockResolvedValue(undefined);

    await handleRequestPaused({
      requestId: "req-2",
      request: { url: "https://api.example.com/items", method: "POST", headers: {} },
      resourceType: "XHR",
    });

    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.fulfillRequest", {
      requestId: "req-2",
      responseCode: 201,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from('{"id":1}').toString("base64"),
    });
  });

  it("blocks request with BlockedByClient error", async () => {
    await mod.addRule({
      urlPattern: "https://ads.tracker.com/**",
      action: "block",
    });

    mockSendCommand.mockReset().mockResolvedValue(undefined);

    await handleRequestPaused({
      requestId: "req-3",
      request: { url: "https://ads.tracker.com/pixel.gif", method: "GET", headers: {} },
      resourceType: "Image",
    });

    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.failRequest", {
      requestId: "req-3",
      errorReason: "BlockedByClient",
    });
  });

  it("modifies request headers", async () => {
    await mod.addRule({
      urlPattern: "https://api.example.com/*",
      action: "modify",
      requestHeaders: { "X-Custom": "injected" },
    });

    mockSendCommand.mockReset().mockResolvedValue(undefined);

    await handleRequestPaused({
      requestId: "req-4",
      request: {
        url: "https://api.example.com/data",
        method: "GET",
        headers: { "Accept": "application/json" },
      },
      resourceType: "XHR",
    });

    const call = mockSendCommand.mock.calls.find(
      (c) => c[0] === "Fetch.continueRequest"
    );
    expect(call).toBeTruthy();
    const headers = call![1].headers;
    expect(headers).toContainEqual({ name: "Accept", value: "application/json" });
    expect(headers).toContainEqual({ name: "X-Custom", value: "injected" });
  });

  it("fails request with custom error reason", async () => {
    await mod.addRule({
      urlPattern: "https://flaky.service.com/*",
      action: "fail",
      errorReason: "ConnectionRefused",
    });

    mockSendCommand.mockReset().mockResolvedValue(undefined);

    await handleRequestPaused({
      requestId: "req-5",
      request: { url: "https://flaky.service.com/api", method: "GET", headers: {} },
      resourceType: "XHR",
    });

    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.failRequest", {
      requestId: "req-5",
      errorReason: "ConnectionRefused",
    });
  });

  it("matches by method filter", async () => {
    await mod.addRule({
      urlPattern: "https://api.example.com/*",
      method: "POST",
      action: "block",
    });

    mockSendCommand.mockReset().mockResolvedValue(undefined);

    // GET should not match
    await handleRequestPaused({
      requestId: "req-get",
      request: { url: "https://api.example.com/data", method: "GET", headers: {} },
      resourceType: "XHR",
    });
    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "req-get" });

    mockSendCommand.mockReset().mockResolvedValue(undefined);

    // POST should match
    await handleRequestPaused({
      requestId: "req-post",
      request: { url: "https://api.example.com/data", method: "POST", headers: {} },
      resourceType: "XHR",
    });
    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.failRequest", {
      requestId: "req-post",
      errorReason: "BlockedByClient",
    });
  });

  it("recovers from action failure by continuing request", async () => {
    await mod.addRule({
      urlPattern: "https://api.example.com/*",
      action: "mock",
      responseCode: 200,
    });

    // First call (fulfillRequest) fails, second (continueRequest) succeeds
    mockSendCommand
      .mockReset()
      .mockRejectedValueOnce(new Error("CDP error"))
      .mockResolvedValue(undefined);

    await handleRequestPaused({
      requestId: "req-err",
      request: { url: "https://api.example.com/fail", method: "GET", headers: {} },
      resourceType: "XHR",
    });

    // Should have attempted continueRequest as fallback
    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "req-err" });
  });
});

// =========================================================================
// Network log capture via CDP events
// =========================================================================

describe("network log capture", () => {
  let handleRequestWillBeSent: (params: unknown) => void;
  let handleResponseReceived: (params: unknown) => void;

  beforeEach(async () => {
    mod.initNetworkInterceptor();

    const sentCall = mockCdpOn.mock.calls.find(
      (c) => c[0] === "Network.requestWillBeSent"
    );
    handleRequestWillBeSent = sentCall![1];

    const receivedCall = mockCdpOn.mock.calls.find(
      (c) => c[0] === "Network.responseReceived"
    );
    handleResponseReceived = receivedCall![1];

    // Enable logging
    await mod.startNetworkLog();
  });

  it("captures request and response", () => {
    handleRequestWillBeSent({
      requestId: "r1",
      request: { url: "https://api.test.com/data", method: "GET", headers: { "Accept": "*/*" } },
      type: "XHR",
    });

    handleResponseReceived({
      requestId: "r1",
      response: { status: 200, headers: { "Content-Type": "application/json" } },
    });

    const log = mod.getNetworkLog();
    expect(log).toHaveLength(1);
    expect(log[0].url).toBe("https://api.test.com/data");
    expect(log[0].method).toBe("GET");
    expect(log[0].status).toBe(200);
    expect(log[0].resourceType).toBe("XHR");
  });

  it("filters log by urlPattern", () => {
    handleRequestWillBeSent({
      requestId: "r1",
      request: { url: "https://api.test.com/data", method: "GET", headers: {} },
      type: "XHR",
    });
    handleRequestWillBeSent({
      requestId: "r2",
      request: { url: "https://cdn.test.com/image.png", method: "GET", headers: {} },
      type: "Image",
    });

    const filtered = mod.getNetworkLog({ urlPattern: "https://api.**" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toContain("api.test.com");
  });

  it("filters log by method", () => {
    handleRequestWillBeSent({
      requestId: "r1",
      request: { url: "https://api.test.com/data", method: "GET", headers: {} },
      type: "XHR",
    });
    handleRequestWillBeSent({
      requestId: "r2",
      request: { url: "https://api.test.com/submit", method: "POST", headers: {} },
      type: "XHR",
    });

    const filtered = mod.getNetworkLog({ method: "POST" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toContain("submit");
  });

  it("filters log by statusCode", () => {
    handleRequestWillBeSent({
      requestId: "r1",
      request: { url: "https://api.test.com/ok", method: "GET", headers: {} },
      type: "XHR",
    });
    handleResponseReceived({ requestId: "r1", response: { status: 200, headers: {} } });

    handleRequestWillBeSent({
      requestId: "r2",
      request: { url: "https://api.test.com/missing", method: "GET", headers: {} },
      type: "XHR",
    });
    handleResponseReceived({ requestId: "r2", response: { status: 404, headers: {} } });

    const filtered = mod.getNetworkLog({ statusCode: 404 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toContain("missing");
  });

  it("does not capture when log is stopped", () => {
    mod.stopNetworkLog();

    handleRequestWillBeSent({
      requestId: "r-stopped",
      request: { url: "https://api.test.com/data", method: "GET", headers: {} },
      type: "XHR",
    });

    expect(mod.getNetworkLog()).toHaveLength(0);
  });

  it("clearNetworkLog removes all entries", () => {
    handleRequestWillBeSent({
      requestId: "r1",
      request: { url: "https://api.test.com/data", method: "GET", headers: {} },
      type: "XHR",
    });

    mod.clearNetworkLog();
    expect(mod.getNetworkLog()).toHaveLength(0);
  });
});

// =========================================================================
// reapplyRules
// =========================================================================

describe("reapplyRules", () => {
  it("re-syncs Fetch patterns when rules exist", async () => {
    await mod.addRule({ urlPattern: "https://a.com/*", action: "mock" });

    mockSendCommand.mockReset().mockResolvedValue(undefined);
    await mod.reapplyRules();

    expect(mockSendCommand).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [{ urlPattern: "https://a.com/*" }],
    });
  });

  it("re-enables Network domain when logging is active", async () => {
    await mod.startNetworkLog();

    mockSendCommand.mockReset().mockResolvedValue(undefined);
    await mod.reapplyRules();

    expect(mockSendCommand).toHaveBeenCalledWith("Network.enable", {});
  });

  it("does nothing when no rules and no logging", async () => {
    mockSendCommand.mockReset().mockResolvedValue(undefined);
    await mod.reapplyRules();

    expect(mockSendCommand).not.toHaveBeenCalled();
  });
});
