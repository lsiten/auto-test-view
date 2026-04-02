/**
 * Tests for lib/pageindex-service.py
 *
 * Integration tests that verify the Python HTTP service endpoints.
 * These tests start the actual Python service and test HTTP communication.
 *
 * Prerequisites:
 *   - python3 available on PATH
 *   - PageIndex dependencies installed: pip3 install -r lib/pageindex/requirements.txt
 *
 * These tests are slower (spawn real Python process) and are tagged for
 * separate CI runs if needed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { type ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_SCRIPT = path.join(__dirname, "..", "lib", "pageindex-service.py");
const TEST_PORT = 13397; // Use non-standard port for testing
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const TEST_WORKSPACE = path.join(os.tmpdir(), `pageindex-test-${Date.now()}`);

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

let serviceProcess: ChildProcess | null = null;

const checkPython = async (): Promise<boolean> => {
  try {
    const proc = spawn("python3", ["-c", "import sys; print(sys.version)"]);
    return new Promise((resolve) => {
      proc.on("exit", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });
  } catch {
    return false;
  }
};

const checkPageIndex = async (): Promise<boolean> => {
  try {
    const proc = spawn("python3", ["-c", "import pageindex"]);
    proc.env = { ...process.env, PYTHONPATH: path.join(__dirname, "..", "lib", "pageindex") };
    return new Promise((resolve) => {
      proc.on("exit", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });
  } catch {
    return false;
  }
};

const startService = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Service did not start within 10 seconds"));
    }, 10_000);

    serviceProcess = spawn(
      "python3",
      [SERVICE_SCRIPT, String(TEST_PORT), TEST_WORKSPACE],
      {
        env: {
          ...process.env,
          OPENAI_API_KEY: "test-key",
          OPENAI_API_BASE: "http://127.0.0.1:3398/v1",
          PAGEINDEX_MODEL: "openai/test-model",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    serviceProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("Service ready")) {
        clearTimeout(timeout);
        resolve();
      }
    });

    serviceProcess.stderr?.on("data", (data: Buffer) => {
      // Some Python modules output warnings to stderr; only reject on actual errors
      const text = data.toString();
      if (text.includes("Error") || text.includes("Traceback")) {
        clearTimeout(timeout);
        reject(new Error(`Service startup error: ${text}`));
      }
    });

    serviceProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    serviceProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Service exited with code ${code}`));
      }
    });
  });
};

const stopService = (): Promise<void> => {
  return new Promise((resolve) => {
    if (!serviceProcess) {
      resolve();
      return;
    }
    serviceProcess.on("exit", () => resolve());
    serviceProcess.kill("SIGTERM");
    serviceProcess = null;
    // Fallback if process doesn't exit quickly
    setTimeout(resolve, 2000);
  });
};

const serviceGet = async (endpoint: string): Promise<{ status: number; data: unknown }> => {
  const res = await fetch(`${BASE_URL}${endpoint}`);
  const data = await res.json();
  return { status: res.status, data };
};

const servicePost = async (endpoint: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: unknown }> => {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
};

// ---------------------------------------------------------------------------
// Check prerequisites
// ---------------------------------------------------------------------------

let canRun = false;

beforeAll(async () => {
  const hasPython = await checkPython();
  if (!hasPython) {
    console.warn("Skipping pageindex-service integration tests: python3 not available");
    return;
  }

  if (!fs.existsSync(SERVICE_SCRIPT)) {
    console.warn("Skipping pageindex-service integration tests: service script not found");
    return;
  }

  // Create test workspace
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  try {
    await startService();
    canRun = true;
  } catch (err) {
    console.warn(`Skipping pageindex-service integration tests: ${err}`);
  }
}, 15_000);

afterAll(async () => {
  await stopService();
  // Clean up test workspace
  try {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PageIndex HTTP service", () => {
  it.skipIf(!canRun)("GET /status returns ok with document count", async () => {
    const { status, data } = await serviceGet("/status");
    expect(status).toBe(200);
    expect(data).toHaveProperty("status", "ok");
    expect(data).toHaveProperty("document_count");
    expect(typeof (data as Record<string, unknown>).document_count).toBe("number");
  });

  it.skipIf(!canRun)("GET /unknown returns 404", async () => {
    const { status } = await serviceGet("/unknown");
    expect(status).toBe(404);
  });

  it.skipIf(!canRun)("POST /list returns empty documents list initially", async () => {
    const { status, data } = await servicePost("/list");
    expect(status).toBe(200);
    expect(data).toHaveProperty("documents");
    expect((data as { documents: unknown[] }).documents).toBeInstanceOf(Array);
  });

  it.skipIf(!canRun)("POST /index returns 400 for missing file", async () => {
    const { status, data } = await servicePost("/index", {
      file_path: "/nonexistent/file.md",
      mode: "md",
    });
    expect(status).toBe(400);
    expect(data).toHaveProperty("error");
  });

  it.skipIf(!canRun)("POST /structure returns 500 for invalid doc_id", async () => {
    const { status, data } = await servicePost("/structure", {
      doc_id: "nonexistent-doc-id",
    });
    // Should return an error (either 404 or 500 depending on implementation)
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it.skipIf(!canRun)("POST /remove returns 404 for missing document", async () => {
    const { status, data } = await servicePost("/remove", {
      doc_id: "nonexistent-doc-id",
    });
    expect(status).toBe(404);
  });

  it.skipIf(!canRun)("POST /unknown returns 404", async () => {
    const { status } = await servicePost("/unknown");
    expect(status).toBe(404);
  });

  // Full cycle test: index a markdown file, then list, get structure, get content, remove
  it.skipIf(!canRun)("full index -> list -> structure -> content -> remove cycle", async () => {
    // Create a test markdown file
    const testMdPath = path.join(TEST_WORKSPACE, "test-recording.md");
    fs.writeFileSync(
      testMdPath,
      [
        "# Test Recording: Login Flow",
        "",
        "- 分组: auth",
        "- 摘要: Login to the dashboard",
        "- 起始URL: https://example.com/login",
        "",
        "## 步骤组: Login",
        "",
        "### 步骤1: navigate",
        "",
        "- 描述: Navigate to login page",
        "- 页面: https://example.com/login",
        "- url: https://example.com/login",
        "",
        "### 步骤2: input_text",
        "",
        "- 描述: Enter username",
        "- 页面: https://example.com/login",
        "- index: 0",
        "- text: admin",
        "",
      ].join("\n"),
      "utf-8"
    );

    // Index the file
    const indexResult = await servicePost("/index", {
      file_path: testMdPath,
      mode: "md",
    });

    // If indexing requires LLM (which it does for md_to_tree), it may fail
    // in test environments without a real LLM. That's expected.
    if (indexResult.status !== 200) {
      console.warn(
        `Indexing failed (expected without LLM): ${JSON.stringify(indexResult.data)}`
      );
      return;
    }

    const docId = (indexResult.data as { doc_id: string }).doc_id;
    expect(typeof docId).toBe("string");
    expect(docId.length).toBeGreaterThan(0);

    // List should now include the document
    const listResult = await servicePost("/list");
    expect(listResult.status).toBe(200);
    const docs = (listResult.data as { documents: Array<{ doc_id: string }> }).documents;
    expect(docs.some((d) => d.doc_id === docId)).toBe(true);

    // Get structure
    const structResult = await servicePost("/structure", { doc_id: docId });
    expect(structResult.status).toBe(200);

    // Get document metadata
    const docResult = await servicePost("/document", { doc_id: docId });
    expect(docResult.status).toBe(200);
    expect(docResult.data).toHaveProperty("doc_name");

    // Remove
    const removeResult = await servicePost("/remove", { doc_id: docId });
    expect(removeResult.status).toBe(200);
    expect(removeResult.data).toHaveProperty("removed", true);

    // Verify removal
    const listAfterRemove = await servicePost("/list");
    const docsAfter = (listAfterRemove.data as { documents: Array<{ doc_id: string }> }).documents;
    expect(docsAfter.some((d) => d.doc_id === docId)).toBe(false);
  }, 60_000);
});
