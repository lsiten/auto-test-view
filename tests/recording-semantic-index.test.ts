/**
 * Tests for recording-semantic-index.ts
 *
 * These tests verify the PageIndex HTTP service integration layer:
 *   - Recording -> Markdown conversion (via file output)
 *   - Service HTTP requests (index, remove, list, structure, content)
 *   - Doc map persistence
 *   - Index status reporting
 *   - LLM client
 *   - Service lifecycle (start/stop)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as realFs from "fs";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/test-userdata") },
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return { ...actual, default: { ...actual, homedir: () => "/tmp/test-userdata" }, homedir: () => "/tmp/test-userdata" };
});

vi.mock("../electron/core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockListRecordings = vi.fn(() => [] as Array<{ id: string }>);
const mockGetRecording = vi.fn(() => null);
vi.mock("../electron/recorder/store", () => ({
  listRecordings: (...args: unknown[]) => mockListRecordings(...args),
  getRecording: (...args: unknown[]) => mockGetRecording(...args),
}));

const mockSpawn = vi.fn();
const mockExecSync = vi.fn();
vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock llm-service (ensureLlmService returns proxy config)
vi.mock("../electron/core/llm-service", () => ({
  ensureLlmService: vi.fn(async () => ({
    baseUrl: "http://127.0.0.1:3398/v1",
    apiKey: "proxy-internal",
    model: "gpt-4o",
  })),
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOCS_DIR = "/tmp/test-userdata/.auto-test-view/docs";
const WORKSPACE_DIR = "/tmp/test-userdata/.auto-test-view/pageindex";
const DOC_MAP_PATH = path.join(WORKSPACE_DIR, "doc-map.json");

const makeRecording = (overrides: Record<string, unknown> = {}) => ({
  id: "rec-20260401-001",
  name: "Login Test",
  group: "auth",
  startUrl: "https://example.com/login",
  urls: ["https://example.com/login", "https://example.com/dashboard"],
  stepGroups: [
    {
      label: "Login Flow",
      steps: [
        { seq: 1, tool: "navigate", args: { url: "https://example.com/login" }, url: "https://example.com/login", text: "Navigate to login page", timestamp: 1000 },
        { seq: 2, tool: "input_text", args: { index: 0, text: "admin" }, url: "https://example.com/login", text: "Enter username", timestamp: 2000 },
        { seq: 3, tool: "click_element", args: { index: 5 }, url: "https://example.com/login", text: "Click login button", timestamp: 3000 },
      ],
    },
  ],
  totalSteps: 3,
  duration: 5000,
  createdAt: "2026-04-01T10:00:00Z",
  summary: "Login with admin credentials",
  ...overrides,
});

const okResponse = (data: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(data),
  text: () => Promise.resolve(JSON.stringify(data)),
});

const errorResponse = (data: unknown, status = 500) => ({
  ok: false,
  status,
  json: () => Promise.resolve(data),
  text: () => Promise.resolve(typeof data === "string" ? data : JSON.stringify(data)),
});

// Helper: resolve pageindex-service.py script path as the module would
const resolvePageIndexScriptPath = (): string => {
  const recorderDir = path.join(process.cwd(), "electron", "recorder");
  return path.join(recorderDir, "..", "..", "..", "lib", "pageindex-service.py");
};

let scriptCleanupGlobal: (() => void) | null = null;

/**
 * Bootstrap the PageIndex service in tests: set config, ensure script exists,
 * mock spawn to emit "Service ready" on stdout.
 */
const bootstrapPageIndexService = (m: typeof import("../electron/recorder/semantic-index")): void => {
  const scriptPath = resolvePageIndexScriptPath();
  const dir = path.dirname(scriptPath);
  realFs.mkdirSync(dir, { recursive: true });
  const existed = realFs.existsSync(scriptPath);
  if (!existed) {
    realFs.writeFileSync(scriptPath, "# placeholder", "utf-8");
    scriptCleanupGlobal = () => { try { realFs.unlinkSync(scriptPath); } catch { /* ignore */ } };
  }

  m.setPageIndexConfig({ baseUrl: "http://test", apiKey: "key", model: "m" });
  mockExecSync.mockImplementation(() => { throw new Error("no process"); });

  const fakeProc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  mockSpawn.mockReturnValue(fakeProc);

  fakeProc.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
    if (event === "data") {
      setTimeout(() => cb(Buffer.from("[PageIndex] Service ready")), 0);
    }
  });
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let mod: typeof import("../electron/recorder/semantic-index");

beforeEach(async () => {
  vi.resetModules();
  mockFetch.mockReset();
  mockSpawn.mockReset();
  mockExecSync.mockReset();
  mockListRecordings.mockReset().mockReturnValue([]);
  mockGetRecording.mockReset().mockReturnValue(null);

  vi.stubGlobal("fetch", mockFetch);

  // Ensure dirs
  realFs.mkdirSync(DOCS_DIR, { recursive: true });
  realFs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Clean stale files
  for (const f of realFs.readdirSync(DOCS_DIR)) {
    realFs.unlinkSync(path.join(DOCS_DIR, f));
  }
  if (realFs.existsSync(DOC_MAP_PATH)) {
    realFs.unlinkSync(DOC_MAP_PATH);
  }

  mod = await import("../electron/recorder/semantic-index");
});

afterEach(() => {
  try { realFs.rmSync("/tmp/test-userdata/.auto-test-view", { recursive: true, force: true }); } catch { /* ignore */ }
  if (scriptCleanupGlobal) { scriptCleanupGlobal(); scriptCleanupGlobal = null; }
});

// =========================================================================
// callLlm
// =========================================================================

describe("callLlm", () => {
  const config = { baseUrl: "http://localhost:3398/v1", apiKey: "test-key", model: "gpt-4o" };

  it("sends correct request and returns content", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({
      choices: [{ message: { content: "Hello from LLM" } }],
    }));

    const result = await mod.callLlm([{ role: "user", content: "test prompt" }], config);

    expect(result).toBe("Hello from LLM");
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, options] = mockFetch.mock.calls[0];
    // callLlm now routes through ensureLlmService which returns the proxy URL
    expect(url).toBe("http://127.0.0.1:3398/v1/chat/completions");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer proxy-internal");

    const body = JSON.parse(options.body);
    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toEqual([{ role: "user", content: "test prompt" }]);
    expect(body.temperature).toBe(0);
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse("rate limited", 429));

    await expect(
      mod.callLlm([{ role: "user", content: "test" }], config)
    ).rejects.toThrow("LLM call failed: 429");
  });
});

// =========================================================================
// getDocMap
// =========================================================================

describe("getDocMap", () => {
  it("returns empty object when no map file exists", () => {
    expect(mod.getDocMap()).toEqual({});
  });

  it("returns saved mapping", () => {
    realFs.writeFileSync(DOC_MAP_PATH, JSON.stringify({ "rec-001": { docId: "doc-xyz", scope: "global" } }), "utf-8");
    expect(mod.getDocMap()).toEqual({ "rec-001": { docId: "doc-xyz", scope: "global" } });
  });

  it("returns empty object on corrupt JSON", () => {
    realFs.writeFileSync(DOC_MAP_PATH, "not json!", "utf-8");
    expect(mod.getDocMap()).toEqual({});
  });
});

// =========================================================================
// getIndexStatus
// =========================================================================

describe("getIndexStatus", () => {
  it("returns correct status with no recordings", () => {
    const status = mod.getIndexStatus();
    expect(status).toEqual({
      serviceRunning: false,
      totalDocs: 0,
      totalRecordings: 0,
      unindexed: [],
    });
  });

  it("reports unindexed recordings", () => {
    mockListRecordings.mockReturnValue([{ id: "rec-001", scope: "global" }, { id: "rec-002", scope: "global" }, { id: "rec-003", scope: "global" }]);
    realFs.writeFileSync(DOC_MAP_PATH, JSON.stringify({ "rec-001": { docId: "doc-aaa", scope: "global" } }), "utf-8");

    const status = mod.getIndexStatus();
    expect(status.totalDocs).toBe(1);
    expect(status.totalRecordings).toBe(3);
    expect(status.unindexed).toEqual(["rec-002", "rec-003"]);
  });

  it("reports all indexed when doc map matches recordings", () => {
    mockListRecordings.mockReturnValue([{ id: "rec-001", scope: "global" }, { id: "rec-002", scope: "global" }]);
    realFs.writeFileSync(
      DOC_MAP_PATH,
      JSON.stringify({ "rec-001": { docId: "doc-aaa", scope: "global" }, "rec-002": { docId: "doc-bbb", scope: "global" } }),
      "utf-8"
    );

    const status = mod.getIndexStatus();
    expect(status.totalDocs).toBe(2);
    expect(status.unindexed).toEqual([]);
  });
});

// =========================================================================
// isPageIndexAvailable
// =========================================================================

describe("isPageIndexAvailable", () => {
  it("returns false when service is not ready", () => {
    expect(mod.isPageIndexAvailable()).toBe(false);
  });
});

// =========================================================================
// indexRecording — Markdown output + service call
// =========================================================================

describe("indexRecording", () => {
  const config = { baseUrl: "http://localhost:3398/v1", apiKey: "key", model: "gpt-4o" };

  beforeEach(() => {
    bootstrapPageIndexService(mod);
  });

  it("writes markdown doc with all recording fields", async () => {
    const rec = makeRecording({ group: "" });

    // waitForService polls /status then we call /index
    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))           // GET /status
      .mockResolvedValueOnce(okResponse({ doc_id: "doc-123" }));      // POST /index

    await mod.indexRecording(rec as any, config);

    const mdPath = path.join(DOCS_DIR, "global_rec-20260401-001.md");
    expect(realFs.existsSync(mdPath)).toBe(true);

    const content = realFs.readFileSync(mdPath, "utf-8");
    expect(content).toContain("# rec-20260401-001: Login Test");
    expect(content).toContain("- 分组: 未分组");
    expect(content).toContain("- 摘要: Login with admin credentials");
    expect(content).toContain("- 访问页面: https://example.com/login, https://example.com/dashboard");
    expect(content).toContain("- 步骤数: 3");
    expect(content).toContain("- 时长: 5秒");
    expect(content).toContain("## 步骤组: Login Flow");
    expect(content).toContain("### 步骤1: navigate");
    expect(content).toContain("### 步骤2: input_text");
    expect(content).toContain("### 步骤3: click_element");
    expect(content).toContain("- 描述: Enter username");
    expect(content).toContain("- url: https://example.com/login");
    expect(content).toContain("- text: admin");
    expect(content).toContain("- index: 5");
  });

  it("calls /index on the service and saves doc map", async () => {
    const rec = makeRecording();

    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))
      .mockResolvedValueOnce(okResponse({ doc_id: "doc-456" }));

    await mod.indexRecording(rec as any, config);

    // Find the /index POST call (should be the second fetch call)
    const indexCall = mockFetch.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/index")
    );
    expect(indexCall).toBeTruthy();
    const body = JSON.parse(indexCall![1].body);
    expect(body.file_path).toContain("global_rec-20260401-001.md");
    expect(body.mode).toBe("md");

    // Doc map updated with scope
    const docMap = JSON.parse(realFs.readFileSync(DOC_MAP_PATH, "utf-8"));
    expect(docMap["rec-20260401-001"]).toEqual({ docId: "doc-456", scope: "global" });
  });

  it("handles multiple step groups in markdown", async () => {
    const rec = makeRecording({
      stepGroups: [
        { label: "Group A", steps: [{ seq: 1, tool: "navigate", args: { url: "https://a.com" }, url: "https://a.com", text: "Go to A", timestamp: 1000 }] },
        { label: "Group B", steps: [{ seq: 2, tool: "click_element", args: { index: 3 }, url: "https://b.com", text: "Click B", timestamp: 2000 }] },
      ],
    });

    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))
      .mockResolvedValueOnce(okResponse({ doc_id: "doc-789" }));

    await mod.indexRecording(rec as any, config);

    const content = realFs.readFileSync(path.join(DOCS_DIR, "global_rec-20260401-001.md"), "utf-8");
    expect(content).toContain("## 步骤组: Group A");
    expect(content).toContain("## 步骤组: Group B");
  });

  it("filters out empty args in markdown", async () => {
    const rec = makeRecording({
      stepGroups: [{
        label: "Test",
        steps: [{
          seq: 1, tool: "input_text",
          args: { index: 0, text: "hello", placeholder: "", extra: undefined },
          url: "https://example.com", text: "Input", timestamp: 1000,
        }],
      }],
    });

    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))
      .mockResolvedValueOnce(okResponse({ doc_id: "doc-aaa" }));

    await mod.indexRecording(rec as any, config);

    const content = realFs.readFileSync(path.join(DOCS_DIR, "global_rec-20260401-001.md"), "utf-8");
    expect(content).toContain("- text: hello");
    expect(content).toContain("- index: 0");
    expect(content).not.toContain("- placeholder:");
  });

  it("writes markdown even when service is unavailable", async () => {
    const rec = makeRecording();

    // Service never responds - but we don't want to wait 30s.
    // Instead, have fetch reject immediately on first call,
    // then the polling will retry. We set all future calls to reject too.
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    // Use a shorter timeout — the function signature doesn't expose timeout,
    // so this test verifies the markdown is written before the service call.
    // We can't easily test the 30s timeout, but we verify the doc was created.
    // Start the indexing (will be stuck in waitForService polling)
    const promise = mod.indexRecording(rec as any, config);

    // Wait a tiny bit for the sync writeRecordingDoc to complete
    await new Promise((r) => setTimeout(r, 100));

    // Markdown should already be written (sync operation before waitForService)
    const mdPath = path.join(DOCS_DIR, "global_rec-20260401-001.md");
    expect(realFs.existsSync(mdPath)).toBe(true);

    // Cancel the stuck promise by resolving fetch (simulating service coming up then failing)
    mockFetch.mockResolvedValue(okResponse({ status: "ok" }));

    // Let the promise settle
    await promise.catch(() => {});
  }, 35_000);
});

// =========================================================================
// removeProfile
// =========================================================================

describe("removeProfile", () => {
  beforeEach(() => {
    bootstrapPageIndexService(mod);
  });

  it("removes markdown doc and updates doc map", async () => {
    // Setup: doc + map (scope-aware format)
    realFs.writeFileSync(path.join(DOCS_DIR, "global_rec-001.md"), "# Test", "utf-8");
    realFs.writeFileSync(DOC_MAP_PATH, JSON.stringify({
      "rec-001": { docId: "doc-aaa", scope: "global" },
      "rec-002": { docId: "doc-bbb", scope: "global" },
    }), "utf-8");

    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))
      .mockResolvedValueOnce(okResponse({ removed: true }));

    await mod.removeProfile("rec-001");

    expect(realFs.existsSync(path.join(DOCS_DIR, "global_rec-001.md"))).toBe(false);

    const docMap = JSON.parse(realFs.readFileSync(DOC_MAP_PATH, "utf-8"));
    expect(docMap).not.toHaveProperty("rec-001");
    expect(docMap["rec-002"]).toEqual({ docId: "doc-bbb", scope: "global" });
  });

  it("handles missing doc map entry gracefully", async () => {
    await mod.removeProfile("rec-nonexistent");
    // Should not throw
  });
});

// =========================================================================
// rebuildAllProfiles
// =========================================================================

describe("rebuildAllProfiles", () => {
  const config = { baseUrl: "http://localhost:3398/v1", apiKey: "key", model: "gpt-4o" };

  beforeEach(() => {
    bootstrapPageIndexService(mod);
  });

  it("clears and re-indexes all recordings", async () => {
    // Stale doc
    realFs.writeFileSync(path.join(DOCS_DIR, "stale.md"), "old", "utf-8");

    const rec1 = makeRecording({ id: "rec-001", name: "Test 1" });
    const rec2 = makeRecording({ id: "rec-002", name: "Test 2" });

    mockListRecordings.mockReturnValue([{ id: "rec-001", scope: "global" }, { id: "rec-002", scope: "project" }]);
    mockGetRecording.mockReturnValueOnce(rec1).mockReturnValueOnce(rec2);

    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))                          // waitForService /status
      .mockResolvedValueOnce(okResponse({ documents: [{ doc_id: "old-1" }] }))      // /list
      .mockResolvedValueOnce(okResponse({ removed: true }))                          // /remove old-1
      .mockResolvedValueOnce(okResponse({ doc_id: "new-1" }))                        // /index rec-001
      .mockResolvedValueOnce(okResponse({ doc_id: "new-2" }));                       // /index rec-002

    const count = await mod.rebuildAllProfiles(config);

    expect(count).toBe(2);
    expect(realFs.existsSync(path.join(DOCS_DIR, "stale.md"))).toBe(false);
    expect(realFs.existsSync(path.join(DOCS_DIR, "global_rec-001.md"))).toBe(true);
    expect(realFs.existsSync(path.join(DOCS_DIR, "project_rec-002.md"))).toBe(true);

    const docMap = JSON.parse(realFs.readFileSync(DOC_MAP_PATH, "utf-8"));
    expect(docMap["rec-001"]).toEqual({ docId: "new-1", scope: "global" });
    expect(docMap["rec-002"]).toEqual({ docId: "new-2", scope: "project" });
  });
});

// =========================================================================
// Service API wrappers (direct HTTP calls — bypass waitForService)
// =========================================================================

describe("service API wrappers", () => {
  beforeEach(() => {
    bootstrapPageIndexService(mod);
  });

  it("getDocumentList calls /list endpoint", async () => {
    const docs = [{ doc_id: "d1", doc_name: "Login", doc_description: "Login flow", type: "md", path: "/docs/1.md" }];

    // waitForService polls /status first, then the actual /list call
    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))
      .mockResolvedValueOnce(okResponse({ documents: docs }));

    const result = await mod.getDocumentList();
    expect(result).toEqual(docs);
  });

  it("getDocumentStructure calls /structure with doc_id", async () => {

    const structure = { tree: [{ title: "Root" }] };

    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))
      .mockResolvedValueOnce(okResponse(structure));

    const result = await mod.getDocumentStructure("doc-123");
    expect(result).toEqual(structure);

    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("/structure"));
    expect(call).toBeTruthy();
    const body = JSON.parse(call![1].body);
    expect(body.doc_id).toBe("doc-123");
  });

  it("getDocumentContent calls /content with doc_id and pages", async () => {

    const content = { content: [{ page: 1, text: "line content" }] };

    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))
      .mockResolvedValueOnce(okResponse(content));

    const result = await mod.getDocumentContent("doc-123", "1-10");
    expect(result).toEqual(content);

    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("/content"));
    expect(call).toBeTruthy();
    const body = JSON.parse(call![1].body);
    expect(body.doc_id).toBe("doc-123");
    expect(body.pages).toBe("1-10");
  });

  it("getDocumentMeta calls /document with doc_id", async () => {

    const meta = { doc_name: "Test", doc_description: "Desc" };

    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))
      .mockResolvedValueOnce(okResponse(meta));

    const result = await mod.getDocumentMeta("doc-123");
    expect(result).toEqual(meta);
  });

  it("throws on service error response", async () => {


    mockFetch
      .mockResolvedValueOnce(okResponse({ status: "ok" }))
      .mockResolvedValueOnce(errorResponse({ error: "Not found" }, 404));

    await expect(mod.getDocumentStructure("bad-id")).rejects.toThrow("PageIndex service error: Not found");
  });
});

// =========================================================================
// startPageIndexService
// =========================================================================

describe("setPageIndexConfig", () => {
  it("stores config without spawning", () => {
    const config = { baseUrl: "http://localhost:3398/v1", apiKey: "test-key", model: "claude-sonnet" };
    mod.setPageIndexConfig(config);

    // No spawn should have happened
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("makes isPageIndexAvailable return true when script exists", () => {
    const resolveScriptPath = (): string => {
      const recorderDir = path.join(process.cwd(), "electron", "recorder");
      return path.join(recorderDir, "..", "..", "..", "lib", "pageindex-service.py");
    };

    const scriptPath = resolveScriptPath();
    const dir = path.dirname(scriptPath);
    realFs.mkdirSync(dir, { recursive: true });
    const existed = realFs.existsSync(scriptPath);
    if (!existed) {
      realFs.writeFileSync(scriptPath, "# placeholder", "utf-8");
    }

    try {
      mod.setPageIndexConfig({ baseUrl: "http://test", apiKey: "key", model: "m" });
      expect(mod.isPageIndexAvailable()).toBe(true);
    } finally {
      if (!existed) try { realFs.unlinkSync(scriptPath); } catch { /* ignore */ }
    }
  });
});

// =========================================================================
// stopPageIndexService
// =========================================================================

describe("stopPageIndexService", () => {
  it("does not throw when no service is running", () => {
    expect(() => mod.stopPageIndexService()).not.toThrow();
  });
});
