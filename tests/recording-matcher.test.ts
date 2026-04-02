/**
 * Tests for recording-matcher.ts
 *
 * These tests verify the PageIndex-based matching pipeline:
 *   - Phase 1: Document selection from indexed list
 *   - Phase 2: Node identification from tree structure
 *   - Phase 3: Content verification
 *   - Confidence threshold enforcement
 *   - Error handling at each phase
 *   - Replay execution
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/test-userdata") },
}));

vi.mock("../electron/core/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mocks for recording-semantic-index exports
const mockIsPageIndexAvailable = vi.fn(() => true);
const mockCallLlm = vi.fn();
const mockGetDocumentList = vi.fn();
const mockGetDocumentStructure = vi.fn();
const mockGetDocumentContent = vi.fn();
const mockGetDocMap = vi.fn(() => ({}));

vi.mock("../electron/recorder/semantic-index", () => ({
  isPageIndexAvailable: () => mockIsPageIndexAvailable(),
  callLlm: (...args: unknown[]) => mockCallLlm(...args),
  getDocumentList: (...args: unknown[]) => mockGetDocumentList(...args),
  getDocumentStructure: (...args: unknown[]) => mockGetDocumentStructure(...args),
  getDocumentContent: (...args: unknown[]) => mockGetDocumentContent(...args),
  getDocMap: (...args: unknown[]) => mockGetDocMap(...args),
}));

// Mocks for recorder-store
const mockGetRecording = vi.fn();
vi.mock("../electron/recorder/store", () => ({
  getRecording: (...args: unknown[]) => mockGetRecording(...args),
}));

// Mocks for ipc-handlers (replay functions)
const mockNavigateTo = vi.fn(() => Promise.resolve({ url: "", title: "" }));
const mockClickElement = vi.fn(() => Promise.resolve(null));
const mockInputText = vi.fn(() => Promise.resolve(null));
const mockScrollPage = vi.fn(() => Promise.resolve(null));
const mockExecuteTask = vi.fn(() => Promise.resolve(null));
const mockGoBack = vi.fn(() => Promise.resolve({ url: "", title: "" }));
const mockGoForward = vi.fn(() => Promise.resolve({ url: "", title: "" }));
const mockReloadPage = vi.fn(() => Promise.resolve({ url: "", title: "" }));

vi.mock("../electron/core/ipc-handlers", () => ({
  navigateTo: (...args: unknown[]) => mockNavigateTo(...args),
  clickElement: (...args: unknown[]) => mockClickElement(...args),
  inputText: (...args: unknown[]) => mockInputText(...args),
  scrollPage: (...args: unknown[]) => mockScrollPage(...args),
  executeTask: (...args: unknown[]) => mockExecuteTask(...args),
  goBack: () => mockGoBack(),
  goForward: () => mockGoForward(),
  reloadPage: () => mockReloadPage(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const config = { baseUrl: "http://localhost:3398/v1", apiKey: "key", model: "gpt-4o" };

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
        { seq: 1, tool: "navigate", args: { url: "https://example.com/login" }, url: "https://example.com/login", text: "Navigate to login", timestamp: 1000 },
        { seq: 2, tool: "input_text", args: { index: 0, text: "admin" }, url: "https://example.com/login", text: "Enter username", timestamp: 2000 },
        { seq: 3, tool: "click_element", args: { index: 5 }, url: "https://example.com/login", text: "Click login", timestamp: 3000 },
      ],
    },
  ],
  totalSteps: 3,
  duration: 5000,
  createdAt: "2026-04-01T10:00:00Z",
  summary: "Login with admin",
  ...overrides,
});

const makeLlmResponse = (data: unknown): string => JSON.stringify(data);

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

let matchRecording: typeof import("../electron/playback/matcher").matchRecording;
let replayRecording: typeof import("../electron/playback/matcher").replayRecording;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  mockIsPageIndexAvailable.mockReturnValue(true);

  const mod = await import("../electron/playback/matcher");
  matchRecording = mod.matchRecording;
  replayRecording = mod.replayRecording;
});

// ---------------------------------------------------------------------------
// matchRecording - Full pipeline
// ---------------------------------------------------------------------------

describe("matchRecording", () => {
  it("returns no match when PageIndex is not available", async () => {
    mockIsPageIndexAvailable.mockReturnValue(false);

    const result = await matchRecording("login to dashboard", null, config);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("not available");
  });

  it("returns no match when no documents are indexed", async () => {
    // Both project and global scopes return empty
    mockGetDocumentList.mockResolvedValue([]);

    const result = await matchRecording("login to dashboard", null, config);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("No recordings indexed");
  });

  it("completes full 3-phase pipeline for a confident match", async () => {
    // Round 1 (project): has documents, LLM matches
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "doc-aaa", doc_name: "Login Test", doc_description: "Login flow", path: "/docs/rec-001.md" },
          { doc_id: "doc-bbb", doc_name: "Logout Test", doc_description: "Logout flow", path: "/docs/rec-002.md" },
        ]);
      }
      return Promise.resolve([]);
    });

    mockGetDocMap.mockReturnValue({ "rec-20260401-001": { docId: "doc-aaa", scope: "project" }, "rec-002": { docId: "doc-bbb", scope: "project" } });

    // Phase 1 LLM response: select doc-aaa
    mockCallLlm
      .mockResolvedValueOnce(
        makeLlmResponse({
          reasoning: "Login Test matches user intent",
          matchDocId: "doc-aaa",
          confidence: 0.9,
          reason: "Name and description match login intent",
        })
      )
      // Phase 2 LLM response: identify nodes
      .mockResolvedValueOnce(
        makeLlmResponse({
          reasoning: "Need to see step details",
          pages: "1-30",
          initialConfidence: 0.85,
        })
      )
      // Phase 3 LLM response: verify match
      .mockResolvedValueOnce(
        makeLlmResponse({
          match: true,
          confidence: 0.92,
          reason: "Recording matches login intent completely",
        })
      );

    // Phase 2: Structure
    mockGetDocumentStructure.mockResolvedValue({
      structure: [{ title: "Login", children: [] }],
    });

    // Phase 3: Content
    mockGetDocumentContent.mockResolvedValue({
      content: [{ page: 1, text: "# Login Test\n..." }],
    });

    // Recording lookup
    const recording = makeRecording();
    mockGetRecording.mockReturnValue(recording);

    const result = await matchRecording(
      "login to dashboard",
      "https://example.com/login",
      config
    );

    expect(result.matched).toBe(true);
    expect(result.recordingId).toBe("rec-20260401-001");
    expect(result.recordingName).toBe("Login Test");
    expect(result.confidence).toBe(0.92);
    expect(result.recording).toBeTruthy();

    // Verify all 3 LLM calls were made (project scope matched, no global round)
    expect(mockCallLlm).toHaveBeenCalledTimes(3);

    // Verify Phase 1 prompt includes current URL
    const phase1Prompt = mockCallLlm.mock.calls[0][0][0].content;
    expect(phase1Prompt).toContain("login to dashboard");
    expect(phase1Prompt).toContain("https://example.com/login");

    // Verify Phase 2 called with correct doc ID
    expect(mockGetDocumentStructure).toHaveBeenCalledWith("doc-aaa");

    // Verify Phase 3 called with correct pages
    expect(mockGetDocumentContent).toHaveBeenCalledWith("doc-aaa", "1-30");
  });

  it("returns no match when Phase 1 confidence is below threshold", async () => {
    // Project scope: has doc but low confidence; Global scope: empty
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "doc-aaa", doc_name: "Unrelated Task", doc_description: "Something else", path: "/docs/rec-001.md" },
        ]);
      }
      return Promise.resolve([]);
    });

    mockCallLlm.mockResolvedValueOnce(
      makeLlmResponse({
        reasoning: "No good match found",
        matchDocId: "doc-aaa",
        confidence: 0.3,
        reason: "Low relevance",
      })
    );

    const result = await matchRecording("login to dashboard", null, config);

    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0.3);
    // Should NOT proceed to Phase 2
    expect(mockGetDocumentStructure).not.toHaveBeenCalled();
    expect(mockCallLlm).toHaveBeenCalledTimes(1);
  });

  it("returns no match when Phase 1 LLM returns null docId", async () => {
    // Project has docs but LLM says no match; Global empty
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "doc-aaa", doc_name: "Test", doc_description: "Test", path: "/docs/1.md" },
        ]);
      }
      return Promise.resolve([]);
    });

    mockCallLlm.mockResolvedValueOnce(
      makeLlmResponse({
        reasoning: "Nothing matches",
        matchDocId: null,
        confidence: 0.1,
        reason: "No matching recording",
      })
    );

    const result = await matchRecording("some unique task", null, config);

    expect(result.matched).toBe(false);
    expect(result.recordingId).toBeNull();
  });

  it("returns no match when recording not found on disk", async () => {
    // Project scope has the doc
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "doc-aaa", doc_name: "Deleted", doc_description: "Gone", path: "/docs/1.md" },
        ]);
      }
      return Promise.resolve([]);
    });

    mockGetDocMap.mockReturnValue({ "rec-gone": { docId: "doc-aaa", scope: "project" } });

    mockCallLlm.mockResolvedValueOnce(
      makeLlmResponse({
        reasoning: "Matches",
        matchDocId: "doc-aaa",
        confidence: 0.9,
        reason: "Good match",
      })
    );

    mockGetRecording.mockReturnValue(null);

    const result = await matchRecording("task", null, config);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("not found on disk");
  });

  it("returns no match when Phase 3 verification rejects", async () => {
    // Project scope has docs, global empty
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "doc-aaa", doc_name: "Login", doc_description: "Login flow", path: "/docs/1.md" },
        ]);
      }
      return Promise.resolve([]);
    });

    mockGetDocMap.mockReturnValue({ "rec-001": { docId: "doc-aaa", scope: "project" } });
    mockGetRecording.mockReturnValue(makeRecording({ id: "rec-001" }));
    mockGetDocumentStructure.mockResolvedValue({ structure: [] });
    mockGetDocumentContent.mockResolvedValue({ content: [] });

    mockCallLlm
      .mockResolvedValueOnce(makeLlmResponse({ reasoning: "ok", matchDocId: "doc-aaa", confidence: 0.9, reason: "match" }))
      .mockResolvedValueOnce(makeLlmResponse({ reasoning: "ok", pages: "1-10", initialConfidence: 0.85 }))
      .mockResolvedValueOnce(makeLlmResponse({ match: false, confidence: 0.4, reason: "Actually different system" }));

    const result = await matchRecording("login", null, config);

    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0.4);
    expect(result.reason).toContain("different system");
    expect(result.recording).toBeNull();
  });

  it("returns no match when no doc map entry found for selected doc", async () => {
    // Project has orphan doc, global empty
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "doc-orphan", doc_name: "Orphan", doc_description: "No mapping", path: "/docs/1.md" },
        ]);
      }
      return Promise.resolve([]);
    });

    mockGetDocMap.mockReturnValue({}); // Empty map

    mockCallLlm.mockResolvedValueOnce(
      makeLlmResponse({ reasoning: "ok", matchDocId: "doc-orphan", confidence: 0.95, reason: "match" })
    );

    const result = await matchRecording("task", null, config);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("No recording mapping found");
  });
});

// ---------------------------------------------------------------------------
// matchRecording - Error handling
// ---------------------------------------------------------------------------

describe("matchRecording - error handling", () => {
  it("handles document list fetch failure", async () => {
    mockGetDocumentList.mockRejectedValue(new Error("Network error"));

    const result = await matchRecording("task", null, config);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("Failed to get document list");
  });

  it("handles Phase 1 LLM failure", async () => {
    // Project has docs but LLM fails; global empty
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "d1", doc_name: "Test", doc_description: "Test", path: "/docs/1.md" },
        ]);
      }
      return Promise.resolve([]);
    });

    mockCallLlm.mockRejectedValueOnce(new Error("LLM timeout"));

    const result = await matchRecording("task", null, config);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("Document selection error");
  });

  it("handles Phase 2 structure fetch failure", async () => {
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "d1", doc_name: "Test", doc_description: "Test", path: "/docs/1.md" },
        ]);
      }
      return Promise.resolve([]);
    });
    mockGetDocMap.mockReturnValue({ "rec-001": { docId: "d1", scope: "project" } });
    mockGetRecording.mockReturnValue(makeRecording({ id: "rec-001" }));

    mockCallLlm.mockResolvedValueOnce(
      makeLlmResponse({ reasoning: "ok", matchDocId: "d1", confidence: 0.9, reason: "match" })
    );
    mockGetDocumentStructure.mockRejectedValue(new Error("Service down"));

    const result = await matchRecording("task", null, config);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("Structure retrieval error");
    expect(result.recordingId).toBe("rec-001");
  });

  it("handles Phase 2 LLM (node selection) failure", async () => {
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "d1", doc_name: "Test", doc_description: "Test", path: "/docs/1.md" },
        ]);
      }
      return Promise.resolve([]);
    });
    mockGetDocMap.mockReturnValue({ "rec-001": { docId: "d1", scope: "project" } });
    mockGetRecording.mockReturnValue(makeRecording({ id: "rec-001" }));
    mockGetDocumentStructure.mockResolvedValue({ structure: [] });

    mockCallLlm
      .mockResolvedValueOnce(makeLlmResponse({ reasoning: "ok", matchDocId: "d1", confidence: 0.9, reason: "match" }))
      .mockRejectedValueOnce(new Error("LLM parse error"));

    const result = await matchRecording("task", null, config);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("Node selection error");
  });

  it("handles Phase 3 content fetch failure", async () => {
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "d1", doc_name: "Test", doc_description: "Test", path: "/docs/1.md" },
        ]);
      }
      return Promise.resolve([]);
    });
    mockGetDocMap.mockReturnValue({ "rec-001": { docId: "d1", scope: "project" } });
    mockGetRecording.mockReturnValue(makeRecording({ id: "rec-001" }));
    mockGetDocumentStructure.mockResolvedValue({ structure: [] });

    mockCallLlm
      .mockResolvedValueOnce(makeLlmResponse({ reasoning: "ok", matchDocId: "d1", confidence: 0.9, reason: "match" }))
      .mockResolvedValueOnce(makeLlmResponse({ reasoning: "ok", pages: "1-10", initialConfidence: 0.85 }));

    mockGetDocumentContent.mockRejectedValue(new Error("Content error"));

    const result = await matchRecording("task", null, config);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("Content retrieval error");
  });

  it("handles Phase 3 LLM (verification) failure", async () => {
    mockGetDocumentList.mockImplementation((scope?: string) => {
      if (scope === "project") {
        return Promise.resolve([
          { doc_id: "d1", doc_name: "Test", doc_description: "Test", path: "/docs/1.md" },
        ]);
      }
      return Promise.resolve([]);
    });
    mockGetDocMap.mockReturnValue({ "rec-001": { docId: "d1", scope: "project" } });
    mockGetRecording.mockReturnValue(makeRecording({ id: "rec-001" }));
    mockGetDocumentStructure.mockResolvedValue({ structure: [] });
    mockGetDocumentContent.mockResolvedValue({ content: [] });

    mockCallLlm
      .mockResolvedValueOnce(makeLlmResponse({ reasoning: "ok", matchDocId: "d1", confidence: 0.9, reason: "match" }))
      .mockResolvedValueOnce(makeLlmResponse({ reasoning: "ok", pages: "1-10", initialConfidence: 0.85 }))
      .mockRejectedValueOnce(new Error("Verification LLM error"));

    const result = await matchRecording("task", null, config);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("Verification error");
  });
});

// ---------------------------------------------------------------------------
// replayRecording
// ---------------------------------------------------------------------------

describe("replayRecording", () => {
  it("executes all steps in order", async () => {
    const recording = makeRecording() as any;

    const result = await replayRecording(recording);

    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(3);
    expect(result.totalSteps).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Step 1: navigate
    expect(mockNavigateTo).toHaveBeenCalledWith("https://example.com/login");
    // Step 2: input_text
    expect(mockInputText).toHaveBeenCalledWith(0, "admin");
    // Step 3: click_element
    expect(mockClickElement).toHaveBeenCalledWith(5);
  });

  it("handles scroll steps", async () => {
    const recording = makeRecording({
      stepGroups: [
        {
          label: "Scroll",
          steps: [
            { seq: 1, tool: "scroll", args: { direction: "down", pages: 3 }, url: "https://example.com", text: "Scroll down", timestamp: 1000 },
          ],
        },
      ],
      totalSteps: 1,
    }) as any;

    await replayRecording(recording);
    expect(mockScrollPage).toHaveBeenCalledWith("down", 3);
  });

  it("handles go_back, go_forward, refresh steps", async () => {
    const recording = makeRecording({
      stepGroups: [
        {
          label: "Nav",
          steps: [
            { seq: 1, tool: "go_back", args: {}, url: "https://example.com", text: "Go back", timestamp: 1000 },
            { seq: 2, tool: "go_forward", args: {}, url: "https://example.com", text: "Go forward", timestamp: 2000 },
            { seq: 3, tool: "refresh", args: {}, url: "https://example.com", text: "Refresh", timestamp: 3000 },
          ],
        },
      ],
      totalSteps: 3,
    }) as any;

    const result = await replayRecording(recording);

    expect(result.success).toBe(true);
    expect(mockGoBack).toHaveBeenCalledOnce();
    expect(mockGoForward).toHaveBeenCalledOnce();
    expect(mockReloadPage).toHaveBeenCalledOnce();
  });

  it("delegates placeholder inputs to page-agent", async () => {
    const recording = makeRecording({
      stepGroups: [
        {
          label: "Input",
          steps: [
            {
              seq: 1,
              tool: "input_text",
              args: { index: 0, text: "{{username}}", placeholder: "Enter your username" },
              url: "https://example.com",
              text: "Enter username",
              timestamp: 1000,
            },
          ],
        },
      ],
      totalSteps: 1,
    }) as any;

    await replayRecording(recording);

    // Should delegate to executeTask (page-agent) instead of inputText
    expect(mockInputText).not.toHaveBeenCalled();
    expect(mockExecuteTask).toHaveBeenCalledOnce();
    expect(mockExecuteTask.mock.calls[0][0]).toContain("Enter your username");
  });

  it("recognizes different placeholder formats", async () => {
    const recordings = [
      makeRecording({
        stepGroups: [{
          label: "Test",
          steps: [
            { seq: 1, tool: "input_text", args: { index: 0, text: "[placeholder]" }, url: "https://example.com", text: "Test", timestamp: 1000 },
          ],
        }],
        totalSteps: 1,
      }),
      makeRecording({
        stepGroups: [{
          label: "Test",
          steps: [
            { seq: 1, tool: "input_text", args: { index: 0, text: "<dynamic_value>" }, url: "https://example.com", text: "Test", timestamp: 1000 },
          ],
        }],
        totalSteps: 1,
      }),
    ];

    for (const rec of recordings) {
      mockExecuteTask.mockClear();
      mockInputText.mockClear();
      await replayRecording(rec as any);
      expect(mockExecuteTask).toHaveBeenCalled();
      expect(mockInputText).not.toHaveBeenCalled();
    }
  });

  it("collects errors but continues execution", async () => {
    mockNavigateTo.mockRejectedValueOnce(new Error("Navigation failed"));

    const recording = makeRecording() as any;
    const result = await replayRecording(recording);

    // Should continue despite first step error
    expect(result.success).toBe(false);
    expect(result.stepsExecuted).toBe(2); // steps 2 and 3 succeed
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Step 1 [navigate] failed");
  });

  it("skips unknown tool types gracefully", async () => {
    const recording = makeRecording({
      stepGroups: [
        {
          label: "Test",
          steps: [
            { seq: 1, tool: "unknown_tool", args: {}, url: "https://example.com", text: "Unknown", timestamp: 1000 },
            { seq: 2, tool: "click_element", args: { index: 1 }, url: "https://example.com", text: "Click", timestamp: 2000 },
          ],
        },
      ],
      totalSteps: 2,
    }) as any;

    const result = await replayRecording(recording);

    // Unknown tool is "skipped" but counted as executed
    expect(result.stepsExecuted).toBe(2);
    expect(result.success).toBe(true);
    expect(mockClickElement).toHaveBeenCalledWith(1);
  });

  it("handles empty recording", async () => {
    const recording = makeRecording({
      stepGroups: [],
      totalSteps: 0,
    }) as any;

    const result = await replayRecording(recording);

    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(0);
    expect(result.totalSteps).toBe(0);
  });
});
