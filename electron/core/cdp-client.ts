import { type BrowserWindow } from "electron";
import { logger } from "./logger";

export interface CdpClient {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, callback: (params: unknown) => void): void;
  off(event: string, callback: (params: unknown) => void): void;
  isAttached(): boolean;
  detach(): void;
}

const CDP_PROTOCOL_VERSION = "1.3";

let mainWindow: BrowserWindow | null = null;
let attached = false;
let wasEverAttached = false;
const listeners = new Map<string, Set<(params: unknown) => void>>();

const ensureAttached = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("CDP: Browser window is not available");
  }

  if (attached) {
    return;
  }

  try {
    mainWindow.webContents.debugger.attach(CDP_PROTOCOL_VERSION);
    attached = true;
    wasEverAttached = true;
    logger.info(`CDP debugger attached (protocol ${CDP_PROTOCOL_VERSION})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`CDP: Failed to attach debugger: ${message}`);
  }
};

const handleDebuggerMessage = (
  _event: Electron.Event,
  method: string,
  params: unknown
): void => {
  const callbacks = listeners.get(method);
  if (!callbacks) {
    return;
  }
  for (const cb of callbacks) {
    try {
      cb(params);
    } catch (err) {
      logger.error(`CDP event handler error for ${method}`, err);
    }
  }
};

const handleDebuggerDetach = (_event: Electron.Event, reason: string): void => {
  attached = false;
  logger.warn(`CDP debugger detached: ${reason}`);
};

const setupNavigationListeners = (win: BrowserWindow): void => {
  const reattach = (): void => {
    // Only re-attach if CDP was previously used and then detached.
    // Don't auto-attach on navigation if CDP was never used.
    if (wasEverAttached && !attached) {
      try {
        ensureAttached();
      } catch (err) {
        logger.error("CDP: Failed to re-attach after navigation", err);
      }
    }
  };

  win.webContents.on("did-navigate", reattach);
  win.webContents.on("did-navigate-in-page", reattach);
};

const cdpClient: CdpClient = {
  sendCommand: async (
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> => {
    ensureAttached();
    try {
      const result = await mainWindow!.webContents.debugger.sendCommand(
        method,
        params
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`CDP command '${method}' failed: ${message}`);
    }
  },

  on: (event: string, callback: (params: unknown) => void): void => {
    const existing = listeners.get(event);
    if (existing) {
      existing.add(callback);
    } else {
      listeners.set(event, new Set([callback]));
    }
  },

  off: (event: string, callback: (params: unknown) => void): void => {
    const existing = listeners.get(event);
    if (existing) {
      existing.delete(callback);
      if (existing.size === 0) {
        listeners.delete(event);
      }
    }
  },

  isAttached: (): boolean => attached,

  detach: (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      attached = false;
      return;
    }
    if (attached) {
      try {
        mainWindow.webContents.debugger.detach();
      } catch {
        // Already detached
      }
      attached = false;
      logger.info("CDP debugger detached manually");
    }
  },
};

export const initCdpClient = (win: BrowserWindow): void => {
  mainWindow = win;
  attached = false;
  wasEverAttached = false;

  win.webContents.debugger.on("message", handleDebuggerMessage);
  win.webContents.debugger.on("detach", handleDebuggerDetach);
  setupNavigationListeners(win);

  logger.info("CDP client initialized (lazy attach on first command)");
};

export const getCdpClient = (): CdpClient => cdpClient;
