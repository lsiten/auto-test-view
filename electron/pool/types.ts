/**
 * Type definitions for the Electron instance pool.
 */

export interface PoolConfig {
  readonly minInstances: number;
  readonly maxInstances: number;
  readonly idleTimeoutMs: number;
  readonly basePort: number;
  readonly startupTimeoutMs: number;
}

export type InstanceStatus = "starting" | "ready" | "busy" | "stopping";

export interface InstanceInfo {
  readonly id: string;
  readonly port: number;
  pid: number | null;
  status: InstanceStatus;
  lastActiveAt: number;
}
