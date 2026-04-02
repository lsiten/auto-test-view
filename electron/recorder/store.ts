/**
 * Recorder data persistence layer.
 * Manages recordings as JSON files with dual-path support:
 *   - global: ~/.auto-test-view/recordings
 *   - project: <projectDir>/.auto-test-view/recordings
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "../core/logger";

// ---------------------------------------------------------------------------
// Data model types
// ---------------------------------------------------------------------------

export type RecordingScope = "project" | "global";

export interface RecordedStep {
  readonly seq: number;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly url: string;
  readonly text: string;
  readonly timestamp: number;
}

export interface StepGroup {
  readonly label: string;
  readonly steps: ReadonlyArray<RecordedStep>;
}

export interface Recording {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly startUrl: string;
  readonly urls: ReadonlyArray<string>;
  readonly stepGroups: ReadonlyArray<StepGroup>;
  readonly totalSteps: number;
  readonly duration: number;
  readonly createdAt: string;
  readonly summary: string;
}

export interface RecordingIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly startUrl: string;
  readonly urls: ReadonlyArray<string>;
  readonly totalSteps: number;
  readonly duration: number;
  readonly createdAt: string;
  readonly summary: string;
  readonly scope: RecordingScope;
}

export interface RecordingIndex {
  readonly recordings: ReadonlyArray<RecordingIndexEntry>;
  readonly groups: ReadonlyArray<string>;
  readonly dirty: boolean;
  readonly lastIndexBuildAt: string | null;
}

// ---------------------------------------------------------------------------
// Test suite export types (compatible with tests/suites/*.json)
// ---------------------------------------------------------------------------

interface TestSuiteStep {
  readonly tool: string;
  readonly args?: Record<string, unknown>;
  readonly note?: string;
}

interface TestSuiteCase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly steps: ReadonlyArray<TestSuiteStep>;
}

interface TestSuite {
  readonly suite: string;
  readonly description: string;
  readonly cases: ReadonlyArray<TestSuiteCase>;
}

// ---------------------------------------------------------------------------
// Module-level path state
// ---------------------------------------------------------------------------

let globalRecordingsDir: string = path.join(os.homedir(), ".auto-test-view", "recordings");
let projectRecordingsDir: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isProjectMode = (): boolean => projectRecordingsDir !== null;

/**
 * Resolve the effective scope. When no projectDir is configured, always
 * return "global" regardless of what was passed in.
 */
const resolveScope = (scope?: RecordingScope): RecordingScope => {
  if (!isProjectMode()) return "global";
  return scope ?? "project";
};

const getRecordingsDir = (scope: RecordingScope): string => {
  if (scope === "project" && projectRecordingsDir) {
    return projectRecordingsDir;
  }
  return globalRecordingsDir;
};

const getIndexPath = (scope: RecordingScope): string => {
  return path.join(getRecordingsDir(scope), "index.json");
};

const RECORDING_ID_PATTERN = /^rec-\d{8}-\d{3}$/;

const getRecordingPath = (id: string, scope: RecordingScope): string => {
  if (!RECORDING_ID_PATTERN.test(id)) {
    throw new Error(`Invalid recording id: ${id}`);
  }
  return path.join(getRecordingsDir(scope), `${id}.json`);
};

const ensureDir = (scope: RecordingScope): void => {
  const dir = getRecordingsDir(scope);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Created recordings directory: ${dir}`);
  }
};

const readIndex = (scope: RecordingScope): RecordingIndex => {
  const indexPath = getIndexPath(scope);
  if (!fs.existsSync(indexPath)) {
    return { recordings: [], groups: [], dirty: false, lastIndexBuildAt: null };
  }
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    return JSON.parse(raw) as RecordingIndex;
  } catch (err) {
    logger.error(`Failed to read index.json for scope ${scope}`, err);
    return { recordings: [], groups: [], dirty: false, lastIndexBuildAt: null };
  }
};

const writeIndex = (index: RecordingIndex, scope: RecordingScope): void => {
  ensureDir(scope);
  fs.writeFileSync(getIndexPath(scope), JSON.stringify(index, null, 2), "utf-8");
};

const toIndexEntry = (rec: Recording, scope: RecordingScope): RecordingIndexEntry => ({
  id: rec.id,
  name: rec.name,
  group: rec.group,
  startUrl: rec.startUrl,
  urls: rec.urls,
  totalSteps: rec.totalSteps,
  duration: rec.duration,
  createdAt: rec.createdAt,
  summary: rec.summary,
  scope,
});

const rebuildGroups = (recordings: ReadonlyArray<RecordingIndexEntry>): ReadonlyArray<string> => {
  const groupSet = new Set<string>();
  for (const r of recordings) {
    if (r.group) {
      groupSet.add(r.group);
    }
  }
  return [...groupSet].sort();
};

/**
 * Return the available scopes in priority order (project first, then global).
 */
const availableScopes = (): ReadonlyArray<RecordingScope> => {
  if (isProjectMode()) {
    return ["project", "global"];
  }
  return ["global"];
};

/**
 * Find which scope contains a recording with the given id.
 * Searches project first, then global.
 */
const findScope = (id: string): RecordingScope | null => {
  for (const scope of availableScopes()) {
    try {
      const filePath = getRecordingPath(id, scope);
      if (fs.existsSync(filePath)) {
        return scope;
      }
    } catch {
      // invalid id format
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const initRecorderStore = (projectDir?: string): void => {
  globalRecordingsDir = path.join(os.homedir(), ".auto-test-view", "recordings");
  projectRecordingsDir = projectDir
    ? path.join(projectDir, ".auto-test-view", "recordings")
    : null;

  ensureDir("global");
  if (isProjectMode()) {
    ensureDir("project");
  }

  const dirs = [globalRecordingsDir, projectRecordingsDir].filter(Boolean).join(", ");
  logger.info(`Recorder store initialized at ${dirs}`);
};

/**
 * Generate a new recording ID in the format rec-YYYYMMDD-NNN.
 */
export const generateRecordingId = (scope?: RecordingScope): string => {
  const effectiveScope = resolveScope(scope);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const index = readIndex(effectiveScope);
  const todayPrefix = `rec-${dateStr}-`;
  const todayRecordings = index.recordings.filter((r) => r.id.startsWith(todayPrefix));
  const maxSeq = todayRecordings.reduce((max, r) => {
    const seq = parseInt(r.id.slice(todayPrefix.length), 10);
    return Number.isNaN(seq) ? max : Math.max(max, seq);
  }, 0);
  const nextNum = maxSeq + 1;
  const numStr = String(nextNum).padStart(3, "0");
  return `${todayPrefix}${numStr}`;
};

export const saveRecording = (recording: Recording, scope?: RecordingScope): void => {
  const effectiveScope = resolveScope(scope);
  ensureDir(effectiveScope);
  fs.writeFileSync(
    getRecordingPath(recording.id, effectiveScope),
    JSON.stringify(recording, null, 2),
    "utf-8"
  );

  const index = readIndex(effectiveScope);
  const existing = index.recordings.filter((r) => r.id !== recording.id);
  const newRecordings = [...existing, toIndexEntry(recording, effectiveScope)];
  const newGroups = rebuildGroups(newRecordings);
  writeIndex(
    {
      recordings: newRecordings,
      groups: newGroups,
      dirty: false,
      lastIndexBuildAt: new Date().toISOString(),
    },
    effectiveScope
  );
  logger.info(`Recording saved: ${recording.id} (scope: ${effectiveScope})`);
};

export const listRecordings = (
  group?: string,
  scope?: RecordingScope
): ReadonlyArray<RecordingIndexEntry> => {
  const scopes: ReadonlyArray<RecordingScope> = scope
    ? [resolveScope(scope)]
    : availableScopes();

  const allEntries: Array<RecordingIndexEntry> = [];
  for (const s of scopes) {
    const index = readIndex(s);
    const entries = index.recordings.map((r) => ({ ...r, scope: s }));
    allEntries.push(...entries);
  }

  if (group) {
    return allEntries.filter((r) => r.group === group);
  }
  return allEntries;
};

export const getRecording = (id: string, scope?: RecordingScope): Recording | null => {
  const effectiveScope = scope ? resolveScope(scope) : findScope(id);
  if (!effectiveScope) return null;

  const filePath = getRecordingPath(id, effectiveScope);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Recording;
  } catch (err) {
    logger.error(`Failed to read recording ${id}`, err);
    return null;
  }
};

export const updateRecording = (
  id: string,
  data: { readonly name?: string; readonly group?: string },
  scope?: RecordingScope
): Recording | null => {
  const effectiveScope = scope ? resolveScope(scope) : findScope(id);
  if (!effectiveScope) return null;

  const recording = getRecording(id, effectiveScope);
  if (!recording) return null;

  const updated: Recording = {
    ...recording,
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.group !== undefined ? { group: data.group } : {}),
  };
  fs.writeFileSync(
    getRecordingPath(id, effectiveScope),
    JSON.stringify(updated, null, 2),
    "utf-8"
  );

  const index = readIndex(effectiveScope);
  const newRecordings = index.recordings.map((r) =>
    r.id === id ? toIndexEntry(updated, effectiveScope) : r
  );
  const newGroups = rebuildGroups(newRecordings);
  writeIndex(
    {
      recordings: newRecordings,
      groups: newGroups,
      dirty: false,
      lastIndexBuildAt: new Date().toISOString(),
    },
    effectiveScope
  );
  logger.info(`Recording updated: ${id} (scope: ${effectiveScope})`);
  return updated;
};

export const deleteRecording = (id: string, scope?: RecordingScope): boolean => {
  const effectiveScope = scope ? resolveScope(scope) : findScope(id);
  if (!effectiveScope) return false;

  const filePath = getRecordingPath(id, effectiveScope);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  const index = readIndex(effectiveScope);
  const newRecordings = index.recordings.filter((r) => r.id !== id);
  if (newRecordings.length === index.recordings.length) {
    return false;
  }
  const newGroups = rebuildGroups(newRecordings);
  writeIndex(
    {
      recordings: newRecordings,
      groups: newGroups,
      dirty: false,
      lastIndexBuildAt: new Date().toISOString(),
    },
    effectiveScope
  );
  logger.info(`Recording deleted: ${id} (scope: ${effectiveScope})`);
  return true;
};

/**
 * Export a recording as a test suite JSON compatible with tests/suites/*.json.
 */
export const exportRecording = (id: string, scope?: RecordingScope): TestSuite | null => {
  const effectiveScope = scope ? resolveScope(scope) : findScope(id);
  if (!effectiveScope) return null;

  const recording = getRecording(id, effectiveScope);
  if (!recording) return null;

  const allSteps: Array<TestSuiteStep> = [];
  for (const sg of recording.stepGroups) {
    for (const step of sg.steps) {
      const suiteStep: TestSuiteStep = {
        tool: step.tool,
        ...(Object.keys(step.args).length > 0 ? { args: step.args } : {}),
        ...(step.text ? { note: step.text } : {}),
      };
      allSteps.push(suiteStep);
    }
  }

  return {
    suite: recording.id,
    description: `${recording.name} - ${recording.summary}`,
    cases: [
      {
        id: `${recording.id}-TC-001`,
        name: recording.name,
        description: recording.summary,
        steps: allSteps,
      },
    ],
  };
};

/**
 * Search recordings by query string (matches name, group, urls, summary).
 */
export const searchRecordings = (
  query: string,
  scope?: RecordingScope
): ReadonlyArray<RecordingIndexEntry> => {
  const scopes: ReadonlyArray<RecordingScope> = scope
    ? [resolveScope(scope)]
    : availableScopes();

  const lower = query.toLowerCase();
  const results: Array<RecordingIndexEntry> = [];

  for (const s of scopes) {
    const index = readIndex(s);
    const matched = index.recordings
      .filter((r) => {
        const searchable = [r.name, r.group, r.summary, r.startUrl, ...r.urls]
          .join(" ")
          .toLowerCase();
        return searchable.includes(lower);
      })
      .map((r) => ({ ...r, scope: s }));
    results.push(...matched);
  }

  return results;
};

export const getRecordingGroups = (scope?: RecordingScope): ReadonlyArray<string> => {
  if (scope) {
    const index = readIndex(resolveScope(scope));
    return index.groups;
  }
  // Merge groups from all scopes
  const groupSet = new Set<string>();
  for (const s of availableScopes()) {
    const index = readIndex(s);
    for (const g of index.groups) {
      groupSet.add(g);
    }
  }
  return [...groupSet].sort();
};

/**
 * Delete a single step from a recording.
 * Returns the updated recording, or null if not found.
 */
export const deleteStep = (
  id: string,
  groupIndex: number,
  stepIndex: number,
  scope?: RecordingScope
): Recording | null => {
  const effectiveScope = scope ? resolveScope(scope) : findScope(id);
  if (!effectiveScope) return null;

  const recording = getRecording(id, effectiveScope);
  if (!recording) return null;

  const newStepGroups = recording.stepGroups.map((sg, sgIdx) => {
    if (sgIdx !== groupIndex) return sg;
    const newSteps = sg.steps.filter((_, sIdx) => sIdx !== stepIndex);
    // Re-sequence
    const reSeqSteps = newSteps.map((s, i) => ({ ...s, seq: i + 1 }));
    return { ...sg, steps: reSeqSteps };
  });

  // Remove empty step groups (except keep at least one)
  const filteredGroups = newStepGroups.filter((sg) => sg.steps.length > 0);
  const finalGroups = filteredGroups.length > 0 ? filteredGroups : [{ label: "default", steps: [] }];

  const totalSteps = finalGroups.reduce((sum, sg) => sum + sg.steps.length, 0);
  const updated: Recording = {
    ...recording,
    stepGroups: finalGroups,
    totalSteps,
  };

  fs.writeFileSync(
    getRecordingPath(id, effectiveScope),
    JSON.stringify(updated, null, 2),
    "utf-8"
  );

  // Update index
  const index = readIndex(effectiveScope);
  const newRecordings = index.recordings.map((r) =>
    r.id === id ? toIndexEntry(updated, effectiveScope) : r
  );
  writeIndex(
    {
      recordings: newRecordings,
      groups: index.groups,
      dirty: false,
      lastIndexBuildAt: new Date().toISOString(),
    },
    effectiveScope
  );
  logger.info(`Step deleted from ${id}: group ${groupIndex}, step ${stepIndex} (scope: ${effectiveScope})`);
  return updated;
};

/**
 * Update a single step in a recording.
 * Returns the updated recording, or null if not found.
 */
export const updateStep = (
  id: string,
  groupIndex: number,
  stepIndex: number,
  data: { readonly tool?: string; readonly text?: string; readonly args?: Record<string, unknown> },
  scope?: RecordingScope
): Recording | null => {
  const effectiveScope = scope ? resolveScope(scope) : findScope(id);
  if (!effectiveScope) return null;

  const recording = getRecording(id, effectiveScope);
  if (!recording) return null;

  const newStepGroups = recording.stepGroups.map((sg, sgIdx) => {
    if (sgIdx !== groupIndex) return sg;
    const newSteps = sg.steps.map((s, sIdx) => {
      if (sIdx !== stepIndex) return s;
      const baseUpdate = {
        ...s,
        ...(data.tool !== undefined ? { tool: data.tool } : {}),
        ...(data.text !== undefined ? { text: data.text } : {}),
        ...(data.args !== undefined ? { args: data.args } : {}),
      };
      // For input_text steps, also sync args.text with the display text
      if (baseUpdate.tool === "input_text" && data.text !== undefined && !data.args) {
        return { ...baseUpdate, args: { ...baseUpdate.args, text: data.text } };
      }
      return baseUpdate;
    });
    return { ...sg, steps: newSteps };
  });

  const updated: Recording = { ...recording, stepGroups: newStepGroups };
  fs.writeFileSync(
    getRecordingPath(id, effectiveScope),
    JSON.stringify(updated, null, 2),
    "utf-8"
  );
  logger.info(`Step updated in ${id}: group ${groupIndex}, step ${stepIndex} (scope: ${effectiveScope})`);
  return updated;
};

/**
 * Delete multiple recordings by IDs. Returns the count of actually deleted items.
 */
export const batchDeleteRecordings = (
  ids: ReadonlyArray<string>,
  scope?: RecordingScope
): number => {
  let deletedCount = 0;
  for (const id of ids) {
    const effectiveScope = scope ? resolveScope(scope) : findScope(id);
    if (!effectiveScope) continue;

    const filePath = getRecordingPath(id, effectiveScope);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    const index = readIndex(effectiveScope);
    const newRecordings = index.recordings.filter((r) => r.id !== id);
    if (newRecordings.length < index.recordings.length) {
      const newGroups = rebuildGroups(newRecordings);
      writeIndex(
        {
          recordings: newRecordings,
          groups: newGroups,
          dirty: false,
          lastIndexBuildAt: new Date().toISOString(),
        },
        effectiveScope
      );
      deletedCount++;
    }
  }
  logger.info(`Batch deleted ${deletedCount} recordings: ${ids.join(", ")}`);
  return deletedCount;
};

/**
 * Export multiple recordings as test suites. Returns an array of suites.
 */
export const batchExportRecordings = (
  ids: ReadonlyArray<string>,
  scope?: RecordingScope
): ReadonlyArray<TestSuite> => {
  const suites: Array<TestSuite> = [];
  for (const id of ids) {
    const suite = exportRecording(id, scope);
    if (suite) {
      suites.push(suite);
    }
  }
  return suites;
};

/**
 * Move multiple recordings to a new group. Returns the count of updated items.
 */
export const batchMoveRecordings = (
  ids: ReadonlyArray<string>,
  group: string,
  scope?: RecordingScope
): number => {
  let updatedCount = 0;
  for (const id of ids) {
    const result = updateRecording(id, { group }, scope);
    if (result) {
      updatedCount++;
    }
  }
  logger.info(`Batch moved ${updatedCount} recordings to group "${group}"`);
  return updatedCount;
};
