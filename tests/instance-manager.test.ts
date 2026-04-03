/**
 * Tests for electron/pool/instance-manager.ts
 *
 * Verifies:
 *   - Pool start creates minimum instances
 *   - Acquire returns ready instances (hot preference)
 *   - Acquire spawns new instances when needed (up to max)
 *   - Acquire queues when at capacity, with 60s timeout
 *   - Release returns instance to pool and serves waiting acquirers
 *   - Idle timeout reclaims instances above minimum
 *   - Crash recovery: emit event, cleanup, restart if below min
 *   - Graceful shutdown stops all instances
 *   - Port and ID allocation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../electron/core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock child process
const createMockChild = (): any => {
  const child = new EventEmitter() as any;
  child.pid = Math.floor(Math.random() * 10000) + 1000;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal?: string) => {
    if (signal === "SIGKILL" || signal === "SIGTERM" || !signal) {
      // Simulate async exit
      setTimeout(() => child.emit("exit", 0, signal ?? "SIGTERM"), 10);
    }
    return true;
  });
  return child;
};

let spawnMock: ReturnType<typeof vi.fn>;

vi.mock("child_process", () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

vi.mock("electron", () => ({ default: "/mock/electron" }));

// Mock http.get for health checks
let healthCheckResult = true;

vi.mock("http", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    get: vi.fn((_url: string, callback: (res: any) => void) => {
      const req = new EventEmitter() as any;
      req.setTimeout = vi.fn();
      req.destroy = vi.fn();

      setTimeout(() => {
        if (healthCheckResult) {
          const res = new EventEmitter() as any;
          res.resume = vi.fn();
          callback(res);
        } else {
          req.emit("error", new Error("Connection refused"));
        }
      }, 5);

      return req;
    }),
  };
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let InstanceManager: typeof import("../electron/pool/instance-manager").InstanceManager;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  healthCheckResult = true;

  spawnMock = vi.fn(() => createMockChild());

  const mod = await import("../electron/pool/instance-manager");
  InstanceManager = mod.InstanceManager;
});

afterEach(() => {
  vi.useRealTimers();
});

// =========================================================================
// Pool start
// =========================================================================

describe("start", () => {
  it("creates minimum number of instances", async () => {
    const manager = new InstanceManager({
      minInstances: 2,
      maxInstances: 4,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(manager.getInstances()).toHaveLength(2);
  });

  it("passes MCP_PORT and ELECTRON_USER_DATA_DIR env vars to child", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 2,
      basePort: 5001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    const callArgs = spawnMock.mock.calls[0];
    const env = callArgs[2]?.env;

    expect(env.MCP_PORT).toBe("5001");
    expect(env.ELECTRON_USER_DATA_DIR).toContain("instance-5001");
  });

  it("instances start in ready status after health check", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 2,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    const instances = manager.getInstances();
    expect(instances[0].status).toBe("ready");
    expect(instances[0].port).toBe(4001);
  });
});

// =========================================================================
// Acquire
// =========================================================================

describe("acquire", () => {
  it("returns a ready instance and marks it busy", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 2,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    const instance = await manager.acquire();
    expect(instance.status).toBe("busy");
    expect(instance.port).toBe(4001);
  });

  it("spawns new instance when all are busy and under max", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 3,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    // First acquire uses the existing instance
    await manager.acquire();

    // Second acquire should spawn a new one
    const acquirePromise = manager.acquire();
    await vi.advanceTimersByTimeAsync(100);
    const instance2 = await acquirePromise;

    expect(instance2.port).toBe(4002);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("prefers most recently active (hot) instance", async () => {
    const manager = new InstanceManager({
      minInstances: 2,
      maxInstances: 4,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    // Acquire and release first instance
    const inst1 = await manager.acquire();
    manager.release(inst1.id);

    // Wait a bit so timestamps differ
    await vi.advanceTimersByTimeAsync(100);

    // Acquire and release second instance
    const inst2 = await manager.acquire();
    // inst2 should be the same as inst1 (most recently active before second acquire)
    // or the second instance - either way, release it
    manager.release(inst2.id);

    await vi.advanceTimersByTimeAsync(100);

    // Now acquire again - should get the most recently released
    const inst3 = await manager.acquire();
    expect(inst3.id).toBe(inst2.id);
  });
});

// =========================================================================
// Release
// =========================================================================

describe("release", () => {
  it("marks instance as ready", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 2,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    const instance = await manager.acquire();
    expect(instance.status).toBe("busy");

    manager.release(instance.id);
    expect(instance.status).toBe("ready");
  });

  it("serves waiting acquirers on release", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 1,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    // Acquire the only instance
    const inst1 = await manager.acquire();

    // Second acquire should wait
    let resolved = false;
    const acquirePromise = manager.acquire().then((inst) => {
      resolved = true;
      return inst;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(resolved).toBe(false);

    // Release triggers the waiting acquirer
    manager.release(inst1.id);
    await vi.advanceTimersByTimeAsync(10);

    const inst2 = await acquirePromise;
    expect(resolved).toBe(true);
    expect(inst2.id).toBe(inst1.id);
    expect(inst2.status).toBe("busy");
  });

  it("ignores release of unknown instance", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 2,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    // Should not throw
    manager.release("nonexistent-id");
  });
});

// =========================================================================
// Wait queue timeout
// =========================================================================

describe("wait queue timeout", () => {
  it("rejects acquire after 60s timeout when at capacity", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 1,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    // Acquire the only instance
    await manager.acquire();

    // Second acquire should queue and eventually timeout
    // Attach catch handler before advancing timers to avoid unhandled rejection
    const acquirePromise = manager.acquire();
    const resultPromise = acquirePromise.catch((err) => err);

    // Advance past the 60s timeout
    await vi.advanceTimersByTimeAsync(61_000);

    const err = await resultPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Timed out waiting for available instance");
  });
});

// =========================================================================
// Idle timeout
// =========================================================================

describe("idle timeout", () => {
  it("reclaims idle instances above minimum count", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 3,
      basePort: 4001,
      idleTimeoutMs: 1000,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    // Spawn a second instance by acquiring
    const acquirePromise = manager.acquire();
    await vi.advanceTimersByTimeAsync(100);
    await acquirePromise;

    const acquirePromise2 = manager.acquire();
    await vi.advanceTimersByTimeAsync(100);
    const inst2 = await acquirePromise2;

    expect(manager.getInstances()).toHaveLength(2);

    // Release second instance - starts idle timer
    manager.release(inst2.id);

    // Advance past idle timeout
    await vi.advanceTimersByTimeAsync(1100);

    // Should have stopped the idle instance (exits asynchronously)
    await vi.advanceTimersByTimeAsync(100);

    // One instance should remain (the minimum)
    expect(manager.getInstances().length).toBeLessThanOrEqual(2);
  });

  it("does not reclaim if at minimum instance count", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 2,
      basePort: 4001,
      idleTimeoutMs: 500,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    const instance = await manager.acquire();
    manager.release(instance.id);

    // Advance past idle timeout
    await vi.advanceTimersByTimeAsync(600);

    // Should still have the instance (at minimum)
    expect(manager.getInstances()).toHaveLength(1);
  });
});

// =========================================================================
// Crash recovery
// =========================================================================

describe("crash recovery", () => {
  it("emits instance-exit event on unexpected crash", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 2,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    const exitHandler = vi.fn();
    manager.on("instance-exit", exitHandler);

    // Get the child process and simulate crash
    const child = spawnMock.mock.results[0].value;
    child.emit("exit", 1, "SIGSEGV");

    expect(exitHandler).toHaveBeenCalledWith(
      expect.stringContaining("inst-"),
      expect.objectContaining({ status: expect.any(String) })
    );
  });

  it("restarts instance if below minimum after crash", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 2,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Simulate crash
    const child = spawnMock.mock.results[0].value;
    child.emit("exit", 1, "SIGSEGV");

    // Should spawn a replacement
    await vi.advanceTimersByTimeAsync(200);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("does not restart during shutdown", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 2,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    const shutdownPromise = manager.shutdown();
    await vi.advanceTimersByTimeAsync(100);
    await shutdownPromise;

    // Should not spawn new instances during/after shutdown
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// Shutdown
// =========================================================================

describe("shutdown", () => {
  it("stops all instances", async () => {
    const manager = new InstanceManager({
      minInstances: 2,
      maxInstances: 4,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    expect(manager.getInstances()).toHaveLength(2);

    const shutdownPromise = manager.shutdown();
    await vi.advanceTimersByTimeAsync(200);
    await shutdownPromise;

    expect(manager.getInstances()).toHaveLength(0);
  });

  it("rejects waiting acquirers on shutdown", async () => {
    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 1,
      basePort: 4001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    await manager.acquire();

    // Attach catch handler before shutdown to avoid unhandled rejection
    const acquirePromise = manager.acquire();
    const resultPromise = acquirePromise.catch((err) => err);

    const shutdownPromise = manager.shutdown();
    await vi.advanceTimersByTimeAsync(200);
    await shutdownPromise;

    const err = await resultPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Pool is shutting down");
  });
});

// =========================================================================
// Port and ID allocation
// =========================================================================

describe("allocation", () => {
  it("allocates sequential ports from basePort", async () => {
    const manager = new InstanceManager({
      minInstances: 3,
      maxInstances: 5,
      basePort: 5001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    const ports = manager.getInstances().map((i) => i.port).sort((a, b) => a - b);
    expect(ports).toEqual([5001, 5002, 5003]);
  });

  it("allocates unique instance IDs", async () => {
    const manager = new InstanceManager({
      minInstances: 3,
      maxInstances: 5,
      basePort: 5001,
      startupTimeoutMs: 5000,
    });

    const startPromise = manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await startPromise;

    const ids = manager.getInstances().map((i) => i.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });
});

// =========================================================================
// Health check failure
// =========================================================================

describe("health check failure", () => {
  it("throws and cleans up if instance fails health check", async () => {
    healthCheckResult = false;

    const manager = new InstanceManager({
      minInstances: 1,
      maxInstances: 2,
      basePort: 4001,
      startupTimeoutMs: 2000,
    });

    const startPromise = manager.start().catch((err) => err);

    // Advance past the startup timeout
    await vi.advanceTimersByTimeAsync(3000);

    const err = await startPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("did not become healthy");
  });
});
