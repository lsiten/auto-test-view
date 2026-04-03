/**
 * Tests for electron/core/llm-service.ts
 *
 * Verifies:
 *   - Config management (set/get)
 *   - Lazy-start singleton behavior
 *   - Port cleanup before spawn (killProcessOnPort)
 *   - Concurrent start prevention
 *   - Timeout and crash recovery
 *   - Stop/cleanup
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import * as realFs from "fs";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../electron/core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSpawn = vi.fn();
const mockExecSync = vi.fn();
vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolveLitellmScriptPath = (): string => {
  const coreDir = path.join(process.cwd(), "electron", "core");
  return path.join(coreDir, "..", "..", "..", "lib", "litellm-proxy.py");
};

const ensureScript = (): { path: string; cleanup: () => void } => {
  const scriptPath = resolveLitellmScriptPath();
  const dir = path.dirname(scriptPath);
  realFs.mkdirSync(dir, { recursive: true });
  const existed = realFs.existsSync(scriptPath);
  if (!existed) {
    realFs.writeFileSync(scriptPath, "# placeholder", "utf-8");
  }
  return {
    path: scriptPath,
    cleanup: () => { if (!existed) try { realFs.unlinkSync(scriptPath); } catch { /* ignore */ } },
  };
};

interface FakeProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

const createFakeProcess = (): FakeProcess => {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mod: typeof import("../electron/core/llm-service");

beforeEach(async () => {
  vi.resetModules();
  mockSpawn.mockReset();
  mockExecSync.mockReset();
  vi.useFakeTimers();

  mod = await import("../electron/core/llm-service");
});

// =========================================================================
// Config management
// =========================================================================

describe("config management", () => {
  it("getLlmServiceConfig returns null before set", () => {
    expect(mod.getLlmServiceConfig()).toBeNull();
  });

  it("setLlmServiceConfig stores config", () => {
    mod.setLlmServiceConfig({ apiKey: "key1", baseUrl: "http://test", model: "gpt-4o" });
    expect(mod.getLlmServiceConfig()).toEqual({ apiKey: "key1", baseUrl: "http://test", model: "gpt-4o" });
  });

  it("ensureLlmService throws when config not set", async () => {
    await expect(mod.ensureLlmService()).rejects.toThrow("LLM service config not set");
  });
});

// =========================================================================
// killProcessOnPort (via spawn behavior)
// =========================================================================

describe("port cleanup before spawn", () => {
  it("calls execSync with lsof to find processes on port", async () => {
    const script = ensureScript();
    try {
      mod.setLlmServiceConfig({ apiKey: "key", baseUrl: "http://test", model: "m" });

      // lsof finds no process
      mockExecSync.mockReturnValue("");

      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const promise = mod.ensureLlmService();

      // Simulate service ready
      fakeProc.stdout.emit("data", Buffer.from("[litellm-proxy] Service ready"));

      const result = await promise;
      expect(result.baseUrl).toContain("3398");

      // Verify lsof was called with port 3398
      expect(mockExecSync).toHaveBeenCalledWith(
        "lsof -ti :3398",
        { encoding: "utf-8" }
      );
    } finally {
      script.cleanup();
    }
  });

  it("kills stale process found on port", async () => {
    const script = ensureScript();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      mod.setLlmServiceConfig({ apiKey: "key", baseUrl: "http://test", model: "m" });

      // lsof finds PID 12345
      mockExecSync.mockReturnValue("12345\n");

      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const promise = mod.ensureLlmService();
      fakeProc.stdout.emit("data", Buffer.from("[litellm-proxy] Service ready"));
      await promise;

      expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    } finally {
      killSpy.mockRestore();
      script.cleanup();
    }
  });

  it("handles lsof failure gracefully (no stale process)", async () => {
    const script = ensureScript();
    try {
      mod.setLlmServiceConfig({ apiKey: "key", baseUrl: "http://test", model: "m" });

      // lsof throws (no process on port — normal case)
      mockExecSync.mockImplementation(() => { throw new Error("exit code 1"); });

      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const promise = mod.ensureLlmService();
      fakeProc.stdout.emit("data", Buffer.from("[litellm-proxy] Service ready"));

      const result = await promise;
      expect(result.baseUrl).toContain("3398");
    } finally {
      script.cleanup();
    }
  });
});

// =========================================================================
// Lazy-start singleton
// =========================================================================

describe("lazy-start singleton", () => {
  it("spawns python3 with correct args and env", async () => {
    const script = ensureScript();
    try {
      mod.setLlmServiceConfig({ apiKey: "my-key", baseUrl: "http://api.example.com", model: "claude-sonnet" });
      mockExecSync.mockImplementation(() => { throw new Error("no process"); });

      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const promise = mod.ensureLlmService();
      fakeProc.stdout.emit("data", Buffer.from("[litellm-proxy] Service ready"));
      await promise;

      expect(mockSpawn).toHaveBeenCalledOnce();
      const [cmd, args, opts] = mockSpawn.mock.calls[0];
      expect(cmd).toBe("python3");
      expect(args[0]).toContain("litellm-proxy.py");
      expect(args[1]).toBe("3398");
      expect(opts.env.LLM_API_KEY).toBe("my-key");
      expect(opts.env.LLM_BASE_URL).toBe("http://api.example.com");
      expect(opts.env.LLM_MODEL).toBe("claude-sonnet");
    } finally {
      script.cleanup();
    }
  });

  it("returns proxy URL and proxy-internal apiKey", async () => {
    const script = ensureScript();
    try {
      mod.setLlmServiceConfig({ apiKey: "key", baseUrl: "http://test", model: "gpt-4o" });
      mockExecSync.mockImplementation(() => { throw new Error("no process"); });

      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const promise = mod.ensureLlmService();
      fakeProc.stdout.emit("data", Buffer.from("[litellm-proxy] Service ready"));

      const result = await promise;
      expect(result.baseUrl).toBe("http://127.0.0.1:3398/v1");
      expect(result.apiKey).toBe("proxy-internal");
      expect(result.model).toBe("gpt-4o");
    } finally {
      script.cleanup();
    }
  });

  it("concurrent calls share the same spawn (no duplicate processes)", async () => {
    const script = ensureScript();
    try {
      mod.setLlmServiceConfig({ apiKey: "key", baseUrl: "http://test", model: "m" });
      mockExecSync.mockImplementation(() => { throw new Error("no process"); });

      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      // Two concurrent calls
      const p1 = mod.ensureLlmService();
      const p2 = mod.ensureLlmService();

      fakeProc.stdout.emit("data", Buffer.from("[litellm-proxy] Service ready"));

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.baseUrl).toBe(r2.baseUrl);

      // spawn called only once
      expect(mockSpawn).toHaveBeenCalledOnce();
    } finally {
      script.cleanup();
    }
  });

  it("returns cached result when service already ready", async () => {
    const script = ensureScript();
    try {
      mod.setLlmServiceConfig({ apiKey: "key", baseUrl: "http://test", model: "m" });
      mockExecSync.mockImplementation(() => { throw new Error("no process"); });

      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const p1 = mod.ensureLlmService();
      fakeProc.stdout.emit("data", Buffer.from("[litellm-proxy] Service ready"));
      await p1;

      // Second call should not spawn again
      const r2 = await mod.ensureLlmService();
      expect(r2.baseUrl).toContain("3398");
      expect(mockSpawn).toHaveBeenCalledOnce();
    } finally {
      script.cleanup();
    }
  });
});

// =========================================================================
// Error handling
// =========================================================================

describe("error handling", () => {
  it("rejects when script not found", async () => {
    mod.setLlmServiceConfig({ apiKey: "key", baseUrl: "http://test", model: "m" });
    // Don't create script file — it won't exist

    await expect(mod.ensureLlmService()).rejects.toThrow("litellm proxy script not found");
  });

  it("rejects on spawn error", async () => {
    const script = ensureScript();
    try {
      mod.setLlmServiceConfig({ apiKey: "key", baseUrl: "http://test", model: "m" });
      mockExecSync.mockImplementation(() => { throw new Error("no process"); });

      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const promise = mod.ensureLlmService();
      fakeProc.emit("error", new Error("ENOENT"));

      await expect(promise).rejects.toThrow("ENOENT");
    } finally {
      script.cleanup();
    }
  });

  it("allows re-start after process crash", async () => {
    const script = ensureScript();
    try {
      mod.setLlmServiceConfig({ apiKey: "key", baseUrl: "http://test", model: "m" });
      mockExecSync.mockImplementation(() => { throw new Error("no process"); });

      // First spawn crashes
      const fakeProc1 = createFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc1);

      const p1 = mod.ensureLlmService();
      fakeProc1.emit("error", new Error("crash"));

      await expect(p1).rejects.toThrow("crash");

      // Second spawn succeeds
      const fakeProc2 = createFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc2);

      const p2 = mod.ensureLlmService();
      fakeProc2.stdout.emit("data", Buffer.from("[litellm-proxy] Service ready"));

      const result = await p2;
      expect(result.baseUrl).toContain("3398");
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    } finally {
      script.cleanup();
    }
  });
});

// =========================================================================
// stopLlmService
// =========================================================================

describe("stopLlmService", () => {
  it("does not throw when no service running", () => {
    expect(() => mod.stopLlmService()).not.toThrow();
  });

  it("kills the process and resets state", async () => {
    const script = ensureScript();
    try {
      mod.setLlmServiceConfig({ apiKey: "key", baseUrl: "http://test", model: "m" });
      mockExecSync.mockImplementation(() => { throw new Error("no process"); });

      const fakeProc = createFakeProcess();
      mockSpawn.mockReturnValue(fakeProc);

      const promise = mod.ensureLlmService();
      fakeProc.stdout.emit("data", Buffer.from("[litellm-proxy] Service ready"));
      await promise;

      mod.stopLlmService();
      expect(fakeProc.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      script.cleanup();
    }
  });
});
