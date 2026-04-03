/**
 * Electron instance pool manager.
 * Spawns and manages multiple Electron child processes, each listening on a unique MCP port.
 */

import { EventEmitter } from "events";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { ChildProcess, spawn } from "child_process";
import electron from "electron";
import type { PoolConfig, InstanceInfo, InstanceStatus } from "./types";
import { logger } from "../core/logger";

const DEFAULT_CONFIG: PoolConfig = {
  minInstances: 1,
  maxInstances: os.cpus().length,
  idleTimeoutMs: 5 * 60 * 1000,
  basePort: 3401,
  startupTimeoutMs: 30_000,
};

/**
 * Check if an Electron MCP instance is healthy by sending an HTTP GET to /mcp.
 * A 405 response indicates the server is up (GET is not allowed for non-SSE).
 */
const checkHealth = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/mcp`, (res) => {
      // Any response means the server is listening
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
};

/**
 * Wait for an instance to become healthy within a timeout.
 */
const waitForHealthy = async (port: number, timeoutMs: number): Promise<void> => {
  const start = Date.now();
  const pollIntervalMs = 500;

  while (Date.now() - start < timeoutMs) {
    const healthy = await checkHealth(port);
    if (healthy) {
      return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`Instance on port ${port} did not become healthy within ${timeoutMs}ms`);
};

interface WaitingAcquirer {
  readonly resolve: (info: InstanceInfo) => void;
  readonly reject: (err: Error) => void;
}

export class InstanceManager extends EventEmitter {
  private readonly config: PoolConfig;
  private readonly instances = new Map<string, InstanceInfo>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waitQueue: Array<WaitingAcquirer> = [];
  private nextPort: number;
  private nextId = 0;
  private shuttingDown = false;

  constructor(overrides: Partial<PoolConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...overrides };
    this.nextPort = this.config.basePort;
  }

  /**
   * Start the pool by creating the minimum number of instances.
   */
  async start(): Promise<void> {
    logger.info(`[pool] Starting pool: min=${this.config.minInstances}, max=${this.config.maxInstances}, basePort=${this.config.basePort}`);

    const startPromises: Array<Promise<InstanceInfo>> = [];
    for (let i = 0; i < this.config.minInstances; i++) {
      startPromises.push(this.spawnInstance());
    }

    await Promise.all(startPromises);
    logger.info(`[pool] Pool started with ${this.instances.size} instance(s)`);
  }

  /**
   * Acquire an available instance from the pool.
   * Prefers recently-active (hot) instances.
   */
  async acquire(): Promise<InstanceInfo> {
    // Find a ready instance, preferring the most recently active
    const readyInstances = [...this.instances.values()]
      .filter((inst) => inst.status === "ready")
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    if (readyInstances.length > 0) {
      const instance = readyInstances[0];
      this.markBusy(instance.id);
      return instance;
    }

    // No ready instance; try to spawn a new one if under max
    if (this.instances.size < this.config.maxInstances) {
      const instance = await this.spawnInstance();
      this.markBusy(instance.id);
      return instance;
    }

    // All instances busy and at max capacity; wait for a release
    logger.info("[pool] All instances busy, waiting for release...");
    const ACQUIRE_TIMEOUT_MS = 60_000;
    return new Promise<InstanceInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waitQueue.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for available instance (${ACQUIRE_TIMEOUT_MS}ms)`));
      }, ACQUIRE_TIMEOUT_MS);

      this.waitQueue.push({
        resolve: (info: InstanceInfo) => {
          clearTimeout(timer);
          resolve(info);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /**
   * Release an instance back to the pool.
   */
  release(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      logger.warn(`[pool] Cannot release unknown instance: ${instanceId}`);
      return;
    }

    instance.status = "ready";
    instance.lastActiveAt = Date.now();
    logger.info(`[pool] Released instance ${instanceId} (port ${instance.port})`);

    // If there are waiting acquirers, hand this instance to the first one
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      this.markBusy(instanceId);
      waiter.resolve(instance);
      return;
    }

    // Start idle timer for potential reclamation
    this.startIdleTimer(instanceId);
  }

  /**
   * Gracefully shut down all instances.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    logger.info("[pool] Shutting down pool...");

    // Reject all waiting acquirers
    for (const waiter of this.waitQueue) {
      waiter.reject(new Error("Pool is shutting down"));
    }
    this.waitQueue.length = 0;

    // Clear all idle timers
    for (const [, timer] of this.idleTimers) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    // Stop all instances in parallel
    const stopPromises = [...this.instances.keys()].map((id) => this.stopInstance(id));
    await Promise.all(stopPromises);

    logger.info("[pool] Pool shutdown complete");
  }

  /**
   * Get a snapshot of all current instances.
   */
  getInstances(): ReadonlyArray<InstanceInfo> {
    return [...this.instances.values()];
  }

  // -- Private methods --

  private allocatePort(): number {
    const port = this.nextPort;
    this.nextPort += 1;
    return port;
  }

  private allocateId(): string {
    this.nextId += 1;
    return `inst-${this.nextId}`;
  }

  private async spawnInstance(): Promise<InstanceInfo> {
    const id = this.allocateId();
    const port = this.allocatePort();
    const electronPath = electron as unknown as string;
    const mainJsPath = path.resolve(__dirname, "..", "main.js");

    const info: InstanceInfo = {
      id,
      port,
      pid: null,
      status: "starting",
      lastActiveAt: Date.now(),
    };
    this.instances.set(id, info);

    logger.info(`[pool] Spawning instance ${id} on port ${port}`);

    const userDataDir = path.join(os.tmpdir(), "auto-test-view-pool", `instance-${port}`);
    // Each instance gets its own LLM proxy port to avoid port conflicts
    const llmProxyPort = port + 1000;
    const child = spawn(electronPath, [mainJsPath], {
      env: {
        ...process.env,
        MCP_PORT: String(port),
        LLM_PROXY_PORT: String(llmProxyPort),
        ELECTRON_USER_DATA_DIR: userDataDir,
      },
      stdio: "pipe",
    });

    this.processes.set(id, child);
    info.pid = child.pid ?? null;

    // Pipe child stdout/stderr to our stderr with prefix
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        const lines = data.toString().trimEnd();
        if (lines) {
          logger.info(`[pool:${id}:stdout] ${lines}`);
        }
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        const lines = data.toString().trimEnd();
        if (lines) {
          logger.warn(`[pool:${id}:stderr] ${lines}`);
        }
      });
    }

    // Handle unexpected exits
    child.on("exit", (code, signal) => {
      logger.info(`[pool] Instance ${id} exited (code=${code}, signal=${signal})`);
      this.handleInstanceExit(id);
    });

    // Wait for health check
    try {
      await waitForHealthy(port, this.config.startupTimeoutMs);
      info.status = "ready";
      logger.info(`[pool] Instance ${id} is ready on port ${port}`);
    } catch (err) {
      logger.warn(`[pool] Instance ${id} failed to start: ${err instanceof Error ? err.message : String(err)}`);
      await this.stopInstance(id);
      throw err;
    }

    return info;
  }

  private markBusy(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    instance.status = "busy";
    instance.lastActiveAt = Date.now();

    // Clear any idle timer
    const timer = this.idleTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(instanceId);
    }
  }

  private startIdleTimer(instanceId: string): void {
    // Clear existing timer if any
    const existing = this.idleTimers.get(instanceId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.idleTimers.delete(instanceId);
      this.handleIdleTimeout(instanceId);
    }, this.config.idleTimeoutMs);

    this.idleTimers.set(instanceId, timer);
  }

  private handleIdleTimeout(instanceId: string): void {
    const activeCount = this.countByStatus("ready") + this.countByStatus("busy");

    if (activeCount <= this.config.minInstances) {
      logger.info(`[pool] Idle timeout for ${instanceId} skipped: at minimum instance count (${activeCount})`);
      return;
    }

    logger.info(`[pool] Idle timeout: stopping instance ${instanceId}`);
    this.stopInstance(instanceId).catch((err) => {
      logger.warn(`[pool] Error stopping idle instance ${instanceId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private handleInstanceExit(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    // Clean up
    this.processes.delete(instanceId);
    this.instances.delete(instanceId);

    const timer = this.idleTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(instanceId);
    }

    // If the instance was being intentionally stopped or we are shutting down, do nothing
    if (instance.status === "stopping" || this.shuttingDown) {
      return;
    }

    // Unexpected crash: notify listeners and restart if below minimum
    logger.warn(`[pool] Instance ${instanceId} crashed unexpectedly`);
    this.emit("instance-exit", instanceId, instance);
    const currentCount = this.instances.size;

    if (currentCount < this.config.minInstances) {
      logger.info(`[pool] Below minimum instances (${currentCount}/${this.config.minInstances}), restarting...`);
      this.spawnInstance().catch((err) => {
        logger.warn(`[pool] Failed to restart instance: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  private async stopInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    const child = this.processes.get(instanceId);

    if (!instance || !child) {
      this.instances.delete(instanceId);
      this.processes.delete(instanceId);
      return;
    }

    instance.status = "stopping";
    logger.info(`[pool] Stopping instance ${instanceId} (pid=${instance.pid})`);

    return new Promise<void>((resolve) => {
      const killTimeoutMs = 5000;

      const forceKillTimer = setTimeout(() => {
        logger.warn(`[pool] Instance ${instanceId} did not exit gracefully, sending SIGKILL`);
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may already be gone
        }
      }, killTimeoutMs);

      child.once("exit", () => {
        clearTimeout(forceKillTimer);
        this.instances.delete(instanceId);
        this.processes.delete(instanceId);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        // Process may already be gone
        clearTimeout(forceKillTimer);
        this.instances.delete(instanceId);
        this.processes.delete(instanceId);
        resolve();
      }
    });
  }

  private countByStatus(status: InstanceStatus): number {
    let count = 0;
    for (const [, inst] of this.instances) {
      if (inst.status === status) {
        count += 1;
      }
    }
    return count;
  }
}
