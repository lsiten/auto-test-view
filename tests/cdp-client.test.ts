/**
 * Tests for electron/core/cdp-client.ts
 *
 * Verifies:
 *   - Lazy attach on first command
 *   - sendCommand delegation to Electron debugger
 *   - Event listener management (on/off)
 *   - Detach behavior
 *   - Error handling (window unavailable, attach failure, command failure)
 *   - Re-attach after navigation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../electron/core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

class MockDebugger extends EventEmitter {
  attached = false;
  sendCommandMock = vi.fn();
  attach = vi.fn(() => { this.attached = true; });
  detach = vi.fn(() => { this.attached = false; });
  sendCommand = this.sendCommandMock;
}

class MockWebContents extends EventEmitter {
  debugger: MockDebugger;

  constructor() {
    super();
    this.debugger = new MockDebugger();
  }
}

const createMockWindow = (destroyed = false) => {
  const webContents = new MockWebContents();
  return {
    webContents,
    isDestroyed: vi.fn(() => destroyed),
  };
};

// Mock electron module
vi.mock("electron", () => ({}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mod: typeof import("../electron/core/cdp-client");

beforeEach(async () => {
  vi.resetModules();
  mod = await import("../electron/core/cdp-client");
});

// =========================================================================
// initCdpClient
// =========================================================================

describe("initCdpClient", () => {
  it("sets up debugger event listeners", () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    // debugger.on should have been called for 'message' and 'detach'
    expect(win.webContents.debugger.listenerCount("message")).toBeGreaterThanOrEqual(1);
    expect(win.webContents.debugger.listenerCount("detach")).toBeGreaterThanOrEqual(1);
  });

  it("sets up navigation re-attach listeners", () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    // webContents should have listeners for did-navigate and did-navigate-in-page
    expect(win.webContents.listenerCount("did-navigate")).toBeGreaterThanOrEqual(1);
    expect(win.webContents.listenerCount("did-navigate-in-page")).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// getCdpClient
// =========================================================================

describe("getCdpClient", () => {
  it("returns a client object with expected methods", () => {
    const client = mod.getCdpClient();
    expect(client.sendCommand).toBeTypeOf("function");
    expect(client.on).toBeTypeOf("function");
    expect(client.off).toBeTypeOf("function");
    expect(client.isAttached).toBeTypeOf("function");
    expect(client.detach).toBeTypeOf("function");
  });
});

// =========================================================================
// sendCommand — lazy attach
// =========================================================================

describe("sendCommand", () => {
  it("auto-attaches debugger on first command", async () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    win.webContents.debugger.sendCommandMock.mockResolvedValue({ result: true });

    const client = mod.getCdpClient();
    await client.sendCommand("Runtime.evaluate", { expression: "1+1" });

    expect(win.webContents.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(win.webContents.debugger.sendCommandMock).toHaveBeenCalledWith(
      "Runtime.evaluate",
      { expression: "1+1" }
    );
  });

  it("does not re-attach if already attached", async () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    win.webContents.debugger.sendCommandMock.mockResolvedValue({});

    const client = mod.getCdpClient();
    await client.sendCommand("DOM.getDocument", {});
    await client.sendCommand("DOM.getDocument", {});

    expect(win.webContents.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it("throws when window is destroyed", async () => {
    const win = createMockWindow(true);
    mod.initCdpClient(win as any);

    const client = mod.getCdpClient();
    await expect(client.sendCommand("test")).rejects.toThrow("Browser window is not available");
  });

  it("wraps CDP command errors", async () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    win.webContents.debugger.sendCommandMock.mockRejectedValue(new Error("Protocol error"));

    const client = mod.getCdpClient();
    await expect(client.sendCommand("Bad.command")).rejects.toThrow("CDP command 'Bad.command' failed: Protocol error");
  });

  it("wraps attach errors", async () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    win.webContents.debugger.attach.mockImplementation(() => {
      throw new Error("Another debugger already attached");
    });

    const client = mod.getCdpClient();
    await expect(client.sendCommand("test")).rejects.toThrow("Failed to attach debugger");
  });
});

// =========================================================================
// Event listeners (on/off)
// =========================================================================

describe("event listeners", () => {
  it("dispatches CDP events to registered listeners", () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    const client = mod.getCdpClient();
    const callback = vi.fn();
    client.on("Network.requestWillBeSent", callback);

    // Simulate CDP message event
    win.webContents.debugger.emit("message", {}, "Network.requestWillBeSent", { requestId: "r1" });

    expect(callback).toHaveBeenCalledWith({ requestId: "r1" });
  });

  it("supports multiple listeners for same event", () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    const client = mod.getCdpClient();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    client.on("Network.requestWillBeSent", cb1);
    client.on("Network.requestWillBeSent", cb2);

    win.webContents.debugger.emit("message", {}, "Network.requestWillBeSent", { requestId: "r1" });

    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("off removes a specific listener", () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    const client = mod.getCdpClient();
    const callback = vi.fn();
    client.on("Network.requestWillBeSent", callback);
    client.off("Network.requestWillBeSent", callback);

    win.webContents.debugger.emit("message", {}, "Network.requestWillBeSent", { requestId: "r1" });

    expect(callback).not.toHaveBeenCalled();
  });

  it("ignores events with no registered listeners", () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    // Should not throw
    win.webContents.debugger.emit("message", {}, "Unknown.event", {});
  });
});

// =========================================================================
// Detach
// =========================================================================

describe("detach", () => {
  it("detaches debugger when attached", async () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    win.webContents.debugger.sendCommandMock.mockResolvedValue({});

    const client = mod.getCdpClient();
    // First attach
    await client.sendCommand("test");
    expect(client.isAttached()).toBe(true);

    client.detach();
    expect(win.webContents.debugger.detach).toHaveBeenCalled();
    expect(client.isAttached()).toBe(false);
  });

  it("does not throw when not attached", () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    const client = mod.getCdpClient();
    expect(() => client.detach()).not.toThrow();
  });

  it("handles destroyed window gracefully", () => {
    const win = createMockWindow(false);
    mod.initCdpClient(win as any);

    // Simulate window destroyed after init
    win.isDestroyed.mockReturnValue(true);

    const client = mod.getCdpClient();
    expect(() => client.detach()).not.toThrow();
  });
});

// =========================================================================
// Debugger detach event
// =========================================================================

describe("debugger detach event", () => {
  it("updates attached state when debugger is externally detached", async () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    win.webContents.debugger.sendCommandMock.mockResolvedValue({});

    const client = mod.getCdpClient();
    await client.sendCommand("test");
    expect(client.isAttached()).toBe(true);

    // Simulate external detach
    win.webContents.debugger.emit("detach", {}, "target closed");
    expect(client.isAttached()).toBe(false);
  });
});

// =========================================================================
// Navigation re-attach
// =========================================================================

describe("navigation re-attach", () => {
  it("re-attaches after did-navigate when detached", async () => {
    const win = createMockWindow();
    mod.initCdpClient(win as any);

    win.webContents.debugger.sendCommandMock.mockResolvedValue({});

    const client = mod.getCdpClient();
    await client.sendCommand("test");

    // Simulate detach then navigation
    win.webContents.debugger.emit("detach", {}, "navigation");

    expect(client.isAttached()).toBe(false);

    // Simulate navigation event
    win.webContents.emit("did-navigate");

    expect(win.webContents.debugger.attach).toHaveBeenCalledTimes(2);
  });
});
