/**
 * Recorder state machine.
 * Manages the lifecycle of a recording session: start -> capture events -> stop.
 */

import { logger } from "../core/logger";
import {
  type Recording,
  type RecordedStep,
  type RecordingScope,
  type StepGroup,
  generateRecordingId,
  saveRecording,
} from "./store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RecorderState = "idle" | "recording" | "paused";

interface RecordEvent {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly url: string;
  readonly text: string;
}

interface RecorderStatus {
  readonly state: RecorderState;
  readonly recordingId: string | null;
  readonly name: string | null;
  readonly group: string | null;
  readonly totalSteps: number;
  readonly currentGroupLabel: string | null;
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Mutable state (module-level singleton)
// ---------------------------------------------------------------------------

let state: RecorderState = "idle";
let currentId: string | null = null;
let currentName: string | null = null;
let currentGroup: string | null = null;
let startUrl: string = "";
let startTime: number = 0;
let seqCounter: number = 0;
let lastUrl: string = "";

// Step groups as mutable array during recording, frozen on stop
let stepGroups: Array<{ label: string; steps: Array<RecordedStep> }> = [];

// Track all visited URLs for the urls field
const visitedUrls = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const extractHostname = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const getCurrentGroupIndex = (): number => {
  return stepGroups.length - 1;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const startRecording = (name: string, group?: string): string => {
  if (state === "recording") {
    throw new Error("Already recording. Stop current recording first.");
  }

  const id = generateRecordingId();
  currentId = id;
  currentName = name;
  currentGroup = group ?? "";
  startTime = Date.now();
  seqCounter = 0;
  lastUrl = "";
  startUrl = "";
  stepGroups = [{ label: "default", steps: [] }];
  visitedUrls.clear();
  state = "recording";

  logger.info(`Recording started: ${id} (name=${name}, group=${group ?? ""})`);
  return id;
};

export const addStepGroup = (label: string): void => {
  if (state !== "recording") {
    throw new Error("Not recording. Cannot add step group.");
  }
  stepGroups.push({ label, steps: [] });
  logger.info(`Step group added: ${label}`);
};

export const onEvent = (event: RecordEvent): void => {
  if (state !== "recording") {
    logger.warn("Received record event while not recording, ignoring.");
    return;
  }

  // Track the first URL as startUrl
  if (!startUrl && event.url) {
    startUrl = event.url;
  }

  // Track visited URLs
  if (event.url) {
    visitedUrls.add(extractHostname(event.url));
  }

  // Auto-insert navigate step when URL changes
  if (event.url && event.url !== lastUrl && lastUrl !== "") {
    if (event.tool !== "navigate") {
      seqCounter += 1;
      const navStep: RecordedStep = {
        seq: seqCounter,
        tool: "navigate",
        args: { url: event.url },
        url: event.url,
        text: `Navigated to ${event.url}`,
        timestamp: Date.now() - startTime,
      };
      const groupIdx = getCurrentGroupIndex();
      if (groupIdx >= 0) {
        stepGroups[groupIdx].steps.push(navStep);
      }
    }
  }
  lastUrl = event.url || lastUrl;

  seqCounter += 1;
  const step: RecordedStep = {
    seq: seqCounter,
    tool: event.tool,
    args: event.args,
    url: event.url,
    text: event.text,
    timestamp: Date.now() - startTime,
  };

  const groupIdx = getCurrentGroupIndex();
  if (groupIdx >= 0) {
    stepGroups[groupIdx].steps.push(step);
  }
};

export const stopRecording = (scope?: RecordingScope): Recording => {
  if (state !== "recording") {
    throw new Error("Not recording. Cannot stop.");
  }

  const duration = Date.now() - startTime;
  const totalSteps = stepGroups.reduce((sum, sg) => sum + sg.steps.length, 0);

  // Build summary from step group labels
  const nonEmptyGroups = stepGroups.filter((sg) => sg.steps.length > 0);
  const summary = nonEmptyGroups.map((sg) => sg.label).join(" -> ");

  // Freeze step groups
  const frozenGroups: ReadonlyArray<StepGroup> = stepGroups.map((sg) => ({
    label: sg.label,
    steps: [...sg.steps],
  }));

  const recording: Recording = {
    id: currentId!,
    name: currentName!,
    group: currentGroup!,
    startUrl,
    urls: [...visitedUrls],
    stepGroups: frozenGroups,
    totalSteps,
    duration,
    createdAt: new Date().toISOString(),
    summary,
  };

  saveRecording(recording, scope);

  // Reset state
  state = "idle";
  const savedId = currentId;
  currentId = null;
  currentName = null;
  currentGroup = null;
  startUrl = "";
  startTime = 0;
  seqCounter = 0;
  lastUrl = "";
  stepGroups = [];
  visitedUrls.clear();

  logger.info(`Recording stopped: ${savedId} (${totalSteps} steps, ${duration}ms)`);
  return recording;
};

export const getCurrentState = (): RecorderStatus => {
  if (state !== "recording") {
    return {
      state,
      recordingId: null,
      name: null,
      group: null,
      totalSteps: 0,
      currentGroupLabel: null,
      elapsedMs: 0,
    };
  }

  const totalSteps = stepGroups.reduce((sum, sg) => sum + sg.steps.length, 0);
  const groupIdx = getCurrentGroupIndex();
  const currentGroupLabel = groupIdx >= 0 ? stepGroups[groupIdx].label : null;

  return {
    state,
    recordingId: currentId,
    name: currentName,
    group: currentGroup,
    totalSteps,
    currentGroupLabel,
    elapsedMs: Date.now() - startTime,
  };
};

export const isRecording = (): boolean => {
  return state === "recording";
};
