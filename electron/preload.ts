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

  // -- Recording event reporting --
  sendRecordEvent: (event: unknown): Promise<unknown> => {
    return ipcRenderer.invoke("record-event", event);
  },

  // -- Recording control (add step group, stop) --
  sendRecordControl: (command: unknown): Promise<unknown> => {
    return ipcRenderer.invoke("record-control", command);
  },

  // -- Recording state query (for floating bar) --
  getRecordingState: (): Promise<unknown> => {
    return ipcRenderer.invoke("get-recording-state");
  },

  // -- Recorder store operations (for management page) --
  recorderStore: {
    list: (group?: string, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-list", group, scope),
    get: (id: string, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-get", id, scope),
    update: (id: string, data: unknown, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-update", id, data, scope),
    delete: (id: string, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-delete", id, scope),
    export: (id: string, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-export", id, scope),
    search: (query: string, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-search", query, scope),
    deleteStep: (id: string, groupIndex: number, stepIndex: number, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-delete-step", id, groupIndex, stepIndex, scope),
    updateStep: (id: string, groupIndex: number, stepIndex: number, data: unknown, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-update-step", id, groupIndex, stepIndex, data, scope),
    batchDelete: (ids: ReadonlyArray<string>, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-batch-delete", ids, scope),
    batchExport: (ids: ReadonlyArray<string>, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-batch-export", ids, scope),
    batchMove: (ids: ReadonlyArray<string>, group: string, scope?: string): Promise<unknown> => ipcRenderer.invoke("recorder-batch-move", ids, group, scope),
  },

  // -- Browser navigation (back/forward/refresh) --
  navBack: (): void => { ipcRenderer.send("nav-back"); },
  navForward: (): void => { ipcRenderer.send("nav-forward"); },
  navRefresh: (): void => { ipcRenderer.send("nav-refresh"); },

  // -- Navigate to recorder UI --
  openRecorderUI: (): void => {
    ipcRenderer.send("open-recorder-ui");
  },

  // -- Navigate to welcome (home) page --
  openWelcome: (): void => {
    ipcRenderer.send("open-welcome");
  },

  // -- Trial run control --
  trialStart: (id: string): Promise<unknown> => ipcRenderer.invoke("trial-start", id),
  trialControl: (command: string): void => { ipcRenderer.send("trial-control", command); },
  trialStatus: (): Promise<unknown> => ipcRenderer.invoke("trial-status"),

  // -- Start a new recording from the management page --
  startNewRecording: (name: string, group: string, url: string, scope?: string): Promise<unknown> => {
    return ipcRenderer.invoke("start-new-recording", name, group, url, scope);
  },

  // -- Semantic index management --
  semanticIndex: {
    status: (): Promise<unknown> => ipcRenderer.invoke("semantic-index-status"),
    rebuild: (): Promise<unknown> => ipcRenderer.invoke("semantic-index-rebuild"),
  },
});
