/**
 * Trial runner: replays recorded steps in the browser.
 * Runs in the main process, injecting a control bar into each navigated page.
 */

import { type BrowserWindow } from "electron";
import { logger } from "../core/logger";
import {
  type Recording,
  type RecordedStep,
  getRecording,
} from "../recorder/store";
import {
  navigateTo,
  clickElement,
  inputText,
  scrollPage,
  executeTask,
  goBack,
  goForward,
  reloadPage,
} from "../core/ipc-handlers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrialState = "idle" | "running" | "paused" | "stepping";

interface FlatStep {
  readonly step: RecordedStep;
  readonly groupIndex: number;
  readonly stepIndex: number;
  readonly groupLabel: string;
}

interface TrialStatus {
  readonly state: TrialState;
  readonly recordingId: string | null;
  readonly recordingName: string | null;
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly currentStepText: string;
  readonly currentTool: string;
  readonly passed: number;
  readonly failed: number;
  readonly stepStates: ReadonlyArray<"pending" | "running" | "pass" | "fail">;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state: TrialState = "idle";
let recordingId: string | null = null;
let recordingName: string | null = null;
let flatSteps: Array<FlatStep> = [];
let currentIdx = 0;
let passed = 0;
let failed = 0;
let stepStates: Array<"pending" | "running" | "pass" | "fail"> = [];
let pauseResolve: (() => void) | null = null;
let aborted = false;
let mainWin: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isPlaceholder = (text: string): boolean => {
  if (!text) return false;
  return /^\{\{.*\}\}$/.test(text) || /^\[.*\]$/.test(text) || /^<.*>$/.test(text);
};

// ---------------------------------------------------------------------------
// Inject control bar
// ---------------------------------------------------------------------------

const buildTrialBarScript = (status: TrialStatus): string => {
  const statusJson = JSON.stringify(status).replace(/'/g, "\\'").replace(/\\/g, "\\\\");
  return `
;(function() {
  var status = JSON.parse('${JSON.stringify(status).replace(/\\/g, "\\\\").replace(/'/g, "\\\\'")}');

  // Remove existing bar if any
  var existing = document.getElementById('__auto-test-trial-bar');
  if (existing) existing.remove();

  var bar = document.createElement('div');
  bar.id = '__auto-test-trial-bar';
  bar.style.cssText = [
    'position: fixed',
    'bottom: 0',
    'left: 0',
    'right: 0',
    'height: 44px',
    'background: #1a1a2e',
    'border-top: 2px solid #1f6feb',
    'display: flex',
    'align-items: center',
    'padding: 0 12px',
    'gap: 6px',
    'z-index: 2147483647',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'font-size: 13px',
    'color: #e1e4e8',
    'user-select: none'
  ].join(';');

  var btnStyle = 'padding:4px 8px;background:#30363d;color:#e1e4e8;border:1px solid #484f58;border-radius:4px;font-size:13px;cursor:pointer;line-height:1';
  var actionStyle = 'padding:4px 10px;color:#fff;border:none;border-radius:4px;font-size:12px;cursor:pointer';

  // Back to management
  var homeBtn = document.createElement('button');
  homeBtn.textContent = '\\u2302';
  homeBtn.title = '返回录制管理';
  homeBtn.style.cssText = btnStyle;
  homeBtn.onclick = function(e) { e.stopPropagation(); window.autoTestBridge.trialControl('stop_and_return'); };
  bar.appendChild(homeBtn);

  // Separator
  var sep0 = document.createElement('span');
  sep0.textContent = '|';
  sep0.style.cssText = 'color:#30363d;margin:0 2px';
  bar.appendChild(sep0);

  // Nav buttons
  var backBtn = document.createElement('button');
  backBtn.innerHTML = '&#9664;';
  backBtn.title = '浏览器后退';
  backBtn.style.cssText = btnStyle;
  backBtn.onclick = function(e) { e.stopPropagation(); window.autoTestBridge.navBack(); };
  bar.appendChild(backBtn);

  var fwdBtn = document.createElement('button');
  fwdBtn.innerHTML = '&#9654;';
  fwdBtn.title = '浏览器前进';
  fwdBtn.style.cssText = btnStyle;
  fwdBtn.onclick = function(e) { e.stopPropagation(); window.autoTestBridge.navForward(); };
  bar.appendChild(fwdBtn);

  var refreshBtn = document.createElement('button');
  refreshBtn.innerHTML = '&#8635;';
  refreshBtn.title = '刷新';
  refreshBtn.style.cssText = btnStyle;
  refreshBtn.onclick = function(e) { e.stopPropagation(); window.autoTestBridge.navRefresh(); };
  bar.appendChild(refreshBtn);

  // Separator
  var sep1 = document.createElement('span');
  sep1.textContent = '|';
  sep1.style.cssText = 'color:#30363d;margin:0 2px';
  bar.appendChild(sep1);

  // Step nav: prev / next
  var prevBtn = document.createElement('button');
  prevBtn.innerHTML = '&#9198;';
  prevBtn.title = '上一步';
  prevBtn.style.cssText = btnStyle;
  prevBtn.onclick = function(e) { e.stopPropagation(); window.autoTestBridge.trialControl('prev_step'); };
  bar.appendChild(prevBtn);

  // Pause / Resume
  var isPaused = status.state === 'paused' || status.state === 'stepping';
  var pauseBtn = document.createElement('button');
  pauseBtn.textContent = isPaused ? '\\u25B6' : '\\u23F8';
  pauseBtn.title = isPaused ? '继续' : '暂停';
  pauseBtn.style.cssText = actionStyle + ';background:#1f6feb';
  pauseBtn.onclick = function(e) { e.stopPropagation(); window.autoTestBridge.trialControl(isPaused ? 'resume' : 'pause'); };
  bar.appendChild(pauseBtn);

  var nextBtn = document.createElement('button');
  nextBtn.innerHTML = '&#9197;';
  nextBtn.title = '下一步';
  nextBtn.style.cssText = btnStyle;
  nextBtn.onclick = function(e) { e.stopPropagation(); window.autoTestBridge.trialControl('next_step'); };
  bar.appendChild(nextBtn);

  // Separator
  var sep2 = document.createElement('span');
  sep2.textContent = '|';
  sep2.style.cssText = 'color:#30363d;margin:0 2px';
  bar.appendChild(sep2);

  // Blue dot
  var dot = document.createElement('span');
  dot.style.cssText = 'width:8px;height:8px;background:#1f6feb;border-radius:50%' + (status.state === 'running' ? ';animation:__trial-blink 1s infinite' : '');
  bar.appendChild(dot);

  // Progress text
  var progressText = document.createElement('span');
  var label = status.state === 'paused' ? '已暂停' : status.state === 'stepping' ? '单步' : '试运行';
  progressText.textContent = label + ' ' + (status.currentStep + 1) + '/' + status.totalSteps;
  progressText.style.cssText = 'color:#58a6ff;font-weight:600;font-size:12px';
  bar.appendChild(progressText);

  // Current step info
  var stepInfo = document.createElement('span');
  var infoText = status.currentTool;
  if (status.currentStepText) {
    var txt = status.currentStepText;
    infoText += ': ' + (txt.length > 40 ? txt.substring(0, 40) + '...' : txt);
  }
  stepInfo.textContent = infoText;
  stepInfo.style.cssText = 'color:#8b949e;font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  bar.appendChild(stepInfo);

  // Pass/fail counts
  var counts = document.createElement('span');
  counts.style.cssText = 'font-size:11px';
  counts.innerHTML = '<span style="color:#3fb950">' + status.passed + ' \\u2714</span> <span style="color:#f85149">' + status.failed + ' \\u2718</span>';
  bar.appendChild(counts);

  // Stop button
  var stopBtn = document.createElement('button');
  stopBtn.textContent = '停止';
  stopBtn.style.cssText = actionStyle + ';background:#da3633;margin-left:4px';
  stopBtn.onclick = function(e) { e.stopPropagation(); window.autoTestBridge.trialControl('stop'); };
  bar.appendChild(stopBtn);

  // Blink animation
  if (!document.getElementById('__trial-blink-style')) {
    var style = document.createElement('style');
    style.id = '__trial-blink-style';
    style.textContent = '@keyframes __trial-blink{0%,100%{opacity:1}50%{opacity:0.3}}';
    document.head.appendChild(style);
  }

  document.body.appendChild(bar);
})();
`;
};

const removeTrialBar = (win: BrowserWindow): void => {
  try {
    win.webContents.executeJavaScript(`
      var el = document.getElementById('__auto-test-trial-bar');
      if (el) el.remove();
    `).catch(() => {});
  } catch {
    // page may have navigated
  }
};

const injectTrialBar = async (win: BrowserWindow, status: TrialStatus): Promise<void> => {
  try {
    const script = buildTrialBarScript(status);
    await win.webContents.executeJavaScript(script);
  } catch {
    // page may not be ready
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const getTrialStatus = (): TrialStatus => ({
  state,
  recordingId,
  recordingName,
  currentStep: currentIdx,
  totalSteps: flatSteps.length,
  currentStepText: flatSteps[currentIdx]?.step.text ?? "",
  currentTool: flatSteps[currentIdx]?.step.tool ?? "",
  passed,
  failed,
  stepStates: [...stepStates],
});

export const startTrialRun = async (
  win: BrowserWindow,
  id: string
): Promise<{ started: boolean; error?: string }> => {
  if (state !== "idle") {
    return { started: false, error: "Trial run already in progress" };
  }

  const rec = getRecording(id);
  if (!rec) {
    return { started: false, error: "Recording not found" };
  }

  mainWin = win;
  recordingId = id;
  recordingName = rec.name;
  flatSteps = [];
  currentIdx = 0;
  passed = 0;
  failed = 0;
  aborted = false;
  pauseResolve = null;

  for (let sgIdx = 0; sgIdx < rec.stepGroups.length; sgIdx++) {
    const sg = rec.stepGroups[sgIdx];
    for (let stIdx = 0; stIdx < sg.steps.length; stIdx++) {
      flatSteps.push({
        step: sg.steps[stIdx],
        groupIndex: sgIdx,
        stepIndex: stIdx,
        groupLabel: sg.label,
      });
    }
  }

  stepStates = flatSteps.map(() => "pending" as const);
  state = "running";

  logger.info(`Trial run started: ${id} (${flatSteps.length} steps)`);

  // Run steps asynchronously
  runSteps(win).catch((err) => {
    logger.error("Trial run error", err);
  });

  return { started: true };
};

export const trialControl = (command: string): void => {
  switch (command) {
    case "pause":
      if (state === "running") {
        state = "paused";
        updateBar();
      }
      break;
    case "resume":
      if (state === "paused" || state === "stepping") {
        state = "running";
        if (pauseResolve) {
          pauseResolve();
          pauseResolve = null;
        }
        updateBar();
      }
      break;
    case "next_step":
      if (state === "paused" || state === "stepping") {
        state = "stepping";
        if (pauseResolve) {
          pauseResolve();
          pauseResolve = null;
        }
      } else if (state === "running") {
        // Switch to stepping mode
        state = "stepping";
        updateBar();
      }
      break;
    case "prev_step":
      if ((state === "paused" || state === "stepping") && currentIdx > 0) {
        currentIdx = Math.max(0, currentIdx - 1);
        stepStates[currentIdx] = "pending";
        state = "stepping";
        if (pauseResolve) {
          pauseResolve();
          pauseResolve = null;
        }
        updateBar();
      }
      break;
    case "stop":
      aborted = true;
      if (pauseResolve) {
        pauseResolve();
        pauseResolve = null;
      }
      break;
    case "stop_and_return":
      aborted = true;
      if (pauseResolve) {
        pauseResolve();
        pauseResolve = null;
      }
      // Navigate back to recorder UI after cleanup
      setTimeout(() => {
        if (mainWin && !mainWin.isDestroyed()) {
          const path = require("path");
          const recorderUrl = `file://${path.join(__dirname, "..", "..", "..", "electron", "ui", "recorder-ui.html")}`;
          mainWin.loadURL(recorderUrl).catch(() => {});
        }
      }, 200);
      break;
  }
};

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

const updateBar = (): void => {
  if (mainWin && !mainWin.isDestroyed()) {
    injectTrialBar(mainWin, getTrialStatus()).catch(() => {});
  }
};

const waitIfPaused = (): Promise<void> => {
  if (state === "paused" || state === "stepping") {
    return new Promise<void>((resolve) => {
      pauseResolve = resolve;
    });
  }
  return Promise.resolve();
};

const executeStep = async (flat: FlatStep): Promise<boolean> => {
  const { step } = flat;
  const args = { ...step.args };

  try {
    switch (step.tool) {
      case "navigate": {
        const url = (args.url as string) ||
          (step.text?.startsWith("Navigated to ") ? step.text.replace("Navigated to ", "") : "");
        if (url) {
          await navigateTo(url);
          // Re-inject bar after navigation
          await delay(500);
          await updateBar();
        }
        break;
      }
      case "click_element": {
        const index = args.index as number;
        if (typeof index === "number" && index >= 0) {
          await clickElement(index);
        }
        break;
      }
      case "input_text": {
        const index = args.index as number;
        const text = args.text as string || "";
        if (isPlaceholder(text)) {
          const placeholder = (args.placeholder as string) || text;
          await executeTask(`In the current input field, enter appropriate content. Field description: ${placeholder}`);
        } else if (typeof index === "number" && index >= 0 && text) {
          await inputText(index, text);
        }
        break;
      }
      case "scroll": {
        const dir = args.direction as "up" | "down" | "left" | "right";
        const pages = (args.pages as number) || 1;
        await scrollPage(dir, pages);
        break;
      }
      case "go_back":
        await goBack();
        await delay(300);
        await updateBar();
        break;
      case "go_forward":
        await goForward();
        await delay(300);
        await updateBar();
        break;
      case "refresh":
        await reloadPage();
        await delay(300);
        await updateBar();
        break;
      default:
        logger.warn(`Trial run: unknown tool "${step.tool}", skipping`);
        break;
    }
    return true;
  } catch (err) {
    logger.warn(`Trial run step failed: ${step.tool}`, err);
    return false;
  }
};

const runSteps = async (win: BrowserWindow): Promise<void> => {
  // Listen for navigation to re-inject bar
  const onNavigate = (): void => {
    setTimeout(() => updateBar(), 800);
  };
  win.webContents.on("did-finish-load", onNavigate);

  try {
    while (currentIdx < flatSteps.length && !aborted) {
      // Wait if paused
      await waitIfPaused();
      if (aborted) break;

      const flat = flatSteps[currentIdx];
      stepStates[currentIdx] = "running";
      await updateBar();

      const ok = await executeStep(flat);
      stepStates[currentIdx] = ok ? "pass" : "fail";
      if (ok) passed++;
      else failed++;

      await updateBar();
      await delay(500);

      currentIdx++;

      // If stepping mode, pause after each step
      if (state === "stepping" && currentIdx < flatSteps.length) {
        state = "paused";
        await updateBar();
        await waitIfPaused();
        if (aborted) break;
      }
    }
  } finally {
    win.webContents.removeListener("did-finish-load", onNavigate);

    if (!aborted && mainWin && !mainWin.isDestroyed()) {
      // Show completion in bar
      state = "idle";
      const finalStatus = getTrialStatus();
      // Inject a final summary bar
      try {
        await win.webContents.executeJavaScript(`
          ;(function() {
            var existing = document.getElementById('__auto-test-trial-bar');
            if (existing) existing.remove();
            var bar = document.createElement('div');
            bar.id = '__auto-test-trial-bar';
            bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:44px;background:#1a1a2e;border-top:2px solid #3fb950;display:flex;align-items:center;padding:0 16px;gap:12px;z-index:2147483647;font-family:-apple-system,sans-serif;font-size:13px;color:#e1e4e8;user-select:none';
            bar.innerHTML = '<span style="color:#3fb950;font-size:16px">\\u2714</span>'
              + '<span style="color:#e1e4e8;font-weight:600">试运行完成</span>'
              + '<span style="color:#8b949e;font-size:12px">${passed} 通过, ${failed} 失败 (${flatSteps.length} 步)</span>'
              + '<span style="flex:1"></span>'
              + '<button onclick="window.autoTestBridge.openRecorderUI()" style="padding:4px 12px;background:#1f6feb;color:#fff;border:none;border-radius:4px;font-size:12px;cursor:pointer">录制管理</button>'
              + '<button onclick="window.autoTestBridge.openWelcome()" style="padding:4px 12px;background:#30363d;color:#8b949e;border:1px solid #484f58;border-radius:4px;font-size:12px;cursor:pointer">返回首页</button>'
              + '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:#8b949e;cursor:pointer;font-size:16px;padding:4px">\\u2715</button>';
            document.body.appendChild(bar);
          })();
        `);
      } catch {
        // page might not be ready
      }
    }

    // Reset state
    state = "idle";
    recordingId = null;
    recordingName = null;
    flatSteps = [];
    stepStates = [];
    currentIdx = 0;
    passed = 0;
    failed = 0;
    mainWin = null;

    logger.info("Trial run finished");
  }
};
