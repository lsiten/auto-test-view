/**
 * Preload script: exposes a safe IPC bridge to the renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("autoTestBridge", {
  sendResult: (result: unknown): Promise<void> => {
    return ipcRenderer.invoke("agent-result", result);
  },

  onCommand: (callback: (command: { type: string; payload: unknown }) => void): void => {
    ipcRenderer.on("agent-command", (_event, command) => {
      callback(command);
    });
  },

  removeCommandListeners: (): void => {
    ipcRenderer.removeAllListeners("agent-command");
  },

  /**
   * Proxy fetch through the main process to bypass mixed content restrictions.
   * Used as page-agent's customFetch so LLM requests go through Node.js, not the browser.
   */
  llmFetch: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }> => {
    return ipcRenderer.invoke("llm-fetch", url, init);
  },

  /**
   * Signal to the main process that page-agent is fully initialized and ready.
   */
  signalReady: (): void => {
    ipcRenderer.send("page-agent-ready");
  },
});
