/**
 * Builds the JavaScript string injected into pages to capture user interactions
 * during recording. Communicates with the main process via IPC through the preload bridge.
 */

import { type BrowserWindow } from "electron";
import { logger } from "../core/logger";

/**
 * Build the injection script for the recording overlay and event capture.
 */
const buildRecorderScript = (): string => {
  return `
;(function() {
  // Guard against double injection
  if (window.__autoTestRecorderInjected) return;
  window.__autoTestRecorderInjected = true;

  // -----------------------------------------------------------------------
  // Floating control bar (fixed bottom)
  // -----------------------------------------------------------------------
  var bar = document.createElement('div');
  bar.id = '__auto-test-recorder-bar';
  bar.style.cssText = [
    'position: fixed',
    'bottom: 0',
    'left: 0',
    'right: 0',
    'height: 40px',
    'background: #1a1a2e',
    'border-top: 2px solid #e94560',
    'display: flex',
    'align-items: center',
    'padding: 0 16px',
    'gap: 8px',
    'z-index: 2147483647',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'font-size: 13px',
    'color: #e1e4e8',
    'user-select: none'
  ].join(';');

  var navBtnStyle = [
    'padding: 4px 8px',
    'background: #30363d',
    'color: #e1e4e8',
    'border: 1px solid #484f58',
    'border-radius: 4px',
    'font-size: 14px',
    'cursor: pointer',
    'line-height: 1'
  ].join(';');

  var actionBtnStyle = [
    'padding: 4px 12px',
    'color: #fff',
    'border: none',
    'border-radius: 4px',
    'font-size: 12px',
    'cursor: pointer'
  ].join(';');

  // -- Navigation buttons (back / forward / refresh) --
  var backBtn = document.createElement('button');
  backBtn.innerHTML = '&#9664;';
  backBtn.title = '后退';
  backBtn.style.cssText = navBtnStyle;
  backBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (window.autoTestBridge && window.autoTestBridge.navBack) {
      window.autoTestBridge.navBack();
    }
  });
  bar.appendChild(backBtn);

  var fwdBtn = document.createElement('button');
  fwdBtn.innerHTML = '&#9654;';
  fwdBtn.title = '前进';
  fwdBtn.style.cssText = navBtnStyle;
  fwdBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (window.autoTestBridge && window.autoTestBridge.navForward) {
      window.autoTestBridge.navForward();
    }
  });
  bar.appendChild(fwdBtn);

  var refreshBtn = document.createElement('button');
  refreshBtn.innerHTML = '&#8635;';
  refreshBtn.title = '刷新';
  refreshBtn.style.cssText = navBtnStyle;
  refreshBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (window.autoTestBridge && window.autoTestBridge.navRefresh) {
      window.autoTestBridge.navRefresh();
    }
  });
  bar.appendChild(refreshBtn);

  // Separator after nav buttons
  var navSep = document.createElement('span');
  navSep.textContent = '|';
  navSep.style.cssText = 'color:#30363d;margin:0 2px';
  bar.appendChild(navSep);

  // Red dot
  var dot = document.createElement('span');
  dot.style.cssText = 'width:10px;height:10px;background:#e94560;border-radius:50%;animation:__rec-blink 1s infinite';
  bar.appendChild(dot);

  // "Recording" label
  var lbl = document.createElement('span');
  lbl.textContent = '录制中';
  lbl.style.cssText = 'color:#e94560;font-weight:600;margin-right:4px';
  bar.appendChild(lbl);

  // Step count
  var stepSpan = document.createElement('span');
  stepSpan.id = '__rec-step-count';
  stepSpan.textContent = '步骤: 0';
  stepSpan.style.cssText = 'color:#8b949e';
  bar.appendChild(stepSpan);

  // Separator
  var sep1 = document.createElement('span');
  sep1.textContent = '|';
  sep1.style.cssText = 'color:#30363d';
  bar.appendChild(sep1);

  // Current group name
  var groupSpan = document.createElement('span');
  groupSpan.id = '__rec-group-name';
  groupSpan.textContent = '分组: 默认';
  groupSpan.style.cssText = 'color:#58a6ff';
  bar.appendChild(groupSpan);

  // Spacer
  var spacer = document.createElement('span');
  spacer.style.cssText = 'flex:1';
  bar.appendChild(spacer);

  // "New Group" button
  var newGroupBtn = document.createElement('button');
  newGroupBtn.textContent = '新建分组';
  newGroupBtn.style.cssText = actionBtnStyle + ';background:#1f6feb';
  newGroupBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var label = prompt('请输入步骤分组名称:');
    if (label && label.trim()) {
      window.autoTestBridge.sendRecordControl({ type: 'add_step_group', label: label.trim() });
      groupSpan.textContent = '分组: ' + label.trim();
    }
  });
  bar.appendChild(newGroupBtn);

  // "Stop" button
  var stopBtn = document.createElement('button');
  stopBtn.textContent = '停止';
  stopBtn.style.cssText = actionBtnStyle + ';background:#e94560;margin-left:4px';
  stopBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    window.autoTestBridge.sendRecordControl({ type: 'stop' });
    removeBar();
    showPostRecordingBar();
  });
  bar.appendChild(stopBtn);

  // Blink animation
  var style = document.createElement('style');
  style.textContent = '@keyframes __rec-blink{0%,100%{opacity:1}50%{opacity:0.3}}';
  document.head.appendChild(style);

  document.body.appendChild(bar);

  // Declared here so removeBar() can clear it
  var stateSyncInterval = null;

  function removeBar() {
    var el = document.getElementById('__auto-test-recorder-bar');
    if (el) el.remove();
    if (style.parentNode) style.remove();
    if (stateSyncInterval) { clearInterval(stateSyncInterval); stateSyncInterval = null; }
    window.__autoTestRecorderInjected = false;
  }

  // Keep a local step count for display
  var localStepCount = 0;

  function incrementStepCount() {
    localStepCount++;
    var el = document.getElementById('__rec-step-count');
    if (el) el.textContent = '步骤: ' + localStepCount;
  }

  // -----------------------------------------------------------------------
  // Helper: get meaningful text from element
  // -----------------------------------------------------------------------
  function getElementText(el) {
    if (!el) return '';
    // For inputs, return value or placeholder
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      return el.value || el.placeholder || '';
    }
    // aria-label or title as fallback for icon buttons
    var ariaLabel = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (ariaLabel) return ariaLabel;
    // For buttons, anchors, etc. return textContent
    var text = (el.textContent || '').trim();
    // Limit length
    return text.length > 100 ? text.substring(0, 100) + '...' : text;
  }

  // -----------------------------------------------------------------------
  // Helper: find element index using page-agent's element tree if available
  // -----------------------------------------------------------------------
  function getElementIndex(el) {
    // page-agent adds data-highlight-index attributes to interactive elements
    var idx = el.getAttribute('data-highlight-index');
    if (idx !== null) return parseInt(idx, 10);
    // Walk up parents (for nested elements like span inside button)
    var parent = el.parentElement;
    var depth = 0;
    while (parent && depth < 5) {
      idx = parent.getAttribute('data-highlight-index');
      if (idx !== null) return parseInt(idx, 10);
      parent = parent.parentElement;
      depth++;
    }
    return -1;
  }

  // -----------------------------------------------------------------------
  // Filter: detect interactive elements worth recording
  // -----------------------------------------------------------------------
  var INTERACTIVE_TAGS = {
    A: true, BUTTON: true, INPUT: true, TEXTAREA: true, SELECT: true,
    OPTION: true, LABEL: true, SUMMARY: true, DETAILS: true
  };
  var INTERACTIVE_ROLES = {
    button: true, link: true, tab: true, menuitem: true, checkbox: true,
    radio: true, switch: true, option: true, combobox: true, listbox: true,
    treeitem: true, gridcell: true
  };

  function isInteractiveElement(el) {
    if (!el || !el.tagName) return false;
    // Has page-agent index -> definitely interactive
    if (getElementIndex(el) >= 0) return true;
    // Check tag name
    if (INTERACTIVE_TAGS[el.tagName]) return true;
    // Check role attribute
    var role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES[role]) return true;
    // Check if it has click-like attributes
    if (el.onclick || el.getAttribute('onclick') || el.getAttribute('tabindex') !== null) return true;
    // Check cursor style (computed)
    try {
      var cursor = window.getComputedStyle(el).cursor;
      if (cursor === 'pointer') return true;
    } catch(e) {}
    // Walk up max 3 levels to find an interactive parent (span inside button)
    var parent = el.parentElement;
    var depth = 0;
    while (parent && depth < 3) {
      if (INTERACTIVE_TAGS[parent.tagName]) return true;
      var pRole = parent.getAttribute('role');
      if (pRole && INTERACTIVE_ROLES[pRole]) return true;
      if (getElementIndex(parent) >= 0) return true;
      parent = parent.parentElement;
      depth++;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Filter: is click inside the recorder bar?
  // -----------------------------------------------------------------------
  function isRecorderBarClick(el) {
    var node = el;
    while (node) {
      if (node.id === '__auto-test-recorder-bar') return true;
      node = node.parentElement;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Dedup: prevent rapid duplicate clicks on the same element
  // -----------------------------------------------------------------------
  var lastClickTarget = null;
  var lastClickTime = 0;
  var DEDUP_INTERVAL_MS = 400;

  // -----------------------------------------------------------------------
  // Click capture (with filtering)
  // -----------------------------------------------------------------------
  document.addEventListener('click', function(e) {
    var target = e.target;

    // Skip clicks on the recorder control bar
    if (isRecorderBarClick(target)) return;

    // Skip non-interactive elements
    if (!isInteractiveElement(target)) return;

    // Dedup rapid clicks on the same element
    var now = Date.now();
    if (target === lastClickTarget && (now - lastClickTime) < DEDUP_INTERVAL_MS) return;
    lastClickTarget = target;
    lastClickTime = now;

    // Resolve the actual interactive element (may be a parent)
    var resolvedEl = target;
    if (getElementIndex(target) < 0) {
      var p = target.parentElement;
      var d = 0;
      while (p && d < 3) {
        if (getElementIndex(p) >= 0 || INTERACTIVE_TAGS[p.tagName]) { resolvedEl = p; break; }
        p = p.parentElement;
        d++;
      }
    }

    var index = getElementIndex(resolvedEl);
    var text = getElementText(resolvedEl);
    var args = {};
    if (index >= 0) {
      args.index = index;
    }
    window.autoTestBridge.sendRecordEvent({
      tool: 'click_element',
      args: args,
      url: window.location.href,
      text: text
    });
    incrementStepCount();
  }, true);

  // -----------------------------------------------------------------------
  // Input capture (debounced, multi-event)
  // -----------------------------------------------------------------------
  var inputTimers = new WeakMap();
  var inputSent = new WeakMap();

  function getInputLabel(el) {
    // Try to find a descriptive label for this input
    var placeholder = el.getAttribute('placeholder') || '';
    var ariaLabel = el.getAttribute('aria-label') || '';
    var name = el.getAttribute('name') || '';
    // Try associated <label>
    var id = el.id;
    if (id) {
      var label = document.querySelector('label[for="' + id + '"]');
      if (label) return (label.textContent || '').trim();
    }
    // Walk up to find label parent
    var parent = el.closest('label');
    if (parent) {
      var labelText = (parent.textContent || '').trim();
      if (labelText) return labelText;
    }
    return ariaLabel || placeholder || name || '';
  }

  function sendInputEvent(target) {
    var index = getElementIndex(target);
    var value = target.value || '';
    var label = getInputLabel(target);
    // Build display text: "label: value" or just value
    var displayText = label ? (label + ': ' + value) : value;
    // Build args
    var args = { text: value };
    if (index >= 0) {
      args.index = index;
    }
    // Store placeholder info for AI decision during trial run
    if (label) {
      args.placeholder = label;
    }
    window.autoTestBridge.sendRecordEvent({
      tool: 'input_text',
      args: args,
      url: window.location.href,
      text: displayText
    });
    incrementStepCount();
    inputSent.set(target, value);
  }

  function handleInputCapture(target) {
    if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && target.tagName !== 'SELECT')) return;
    if (isRecorderBarClick(target)) return;

    var existing = inputTimers.get(target);
    if (existing) clearTimeout(existing);

    inputTimers.set(target, setTimeout(function() {
      var value = target.value || '';
      if (!value.trim()) return;
      // Skip if we already sent this exact value
      var lastSent = inputSent.get(target);
      if (lastSent === value) return;
      sendInputEvent(target);
    }, 500));
  }

  // Primary: 'input' event fires on each keystroke
  document.addEventListener('input', function(e) {
    handleInputCapture(e.target);
  }, true);

  // Fallback: 'change' event fires on blur after value changed (covers select, autofill, etc.)
  document.addEventListener('change', function(e) {
    var target = e.target;
    if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && target.tagName !== 'SELECT')) return;
    if (isRecorderBarClick(target)) return;
    var value = target.value || '';
    if (!value.trim()) return;
    var lastSent = inputSent.get(target);
    if (lastSent === value) return;
    sendInputEvent(target);
  }, true);

  // Fallback: 'blur' captures final value when user tabs/clicks away
  document.addEventListener('blur', function(e) {
    var target = e.target;
    if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && target.tagName !== 'SELECT')) return;
    if (isRecorderBarClick(target)) return;
    // Clear any pending debounce
    var existing = inputTimers.get(target);
    if (existing) clearTimeout(existing);
    var value = target.value || '';
    if (!value.trim()) return;
    var lastSent = inputSent.get(target);
    if (lastSent === value) return;
    sendInputEvent(target);
  }, true);

  // -----------------------------------------------------------------------
  // Scroll capture (debounced, with higher threshold)
  // -----------------------------------------------------------------------
  var scrollTimer = null;
  var lastScrollY = window.scrollY;
  window.addEventListener('scroll', function() {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function() {
      var currentY = window.scrollY;
      var delta = currentY - lastScrollY;
      if (Math.abs(delta) < 100) { lastScrollY = currentY; return; }
      var direction = delta > 0 ? 'down' : 'up';
      var pages = Math.max(1, Math.round(Math.abs(delta) / window.innerHeight));
      lastScrollY = currentY;

      window.autoTestBridge.sendRecordEvent({
        tool: 'scroll',
        args: { direction: direction, pages: pages },
        url: window.location.href,
        text: '滚动 ' + direction + ' ' + pages + ' 页'
      });
      incrementStepCount();
    }, 1000);
  }, true);

  // -----------------------------------------------------------------------
  // Post-recording navigation bar
  // -----------------------------------------------------------------------
  function showPostRecordingBar() {
    var postBar = document.createElement('div');
    postBar.id = '__auto-test-post-bar';
    postBar.style.cssText = [
      'position: fixed',
      'bottom: 0',
      'left: 0',
      'right: 0',
      'height: 40px',
      'background: #1a1a2e',
      'border-top: 2px solid #58a6ff',
      'display: flex',
      'align-items: center',
      'padding: 0 16px',
      'gap: 12px',
      'z-index: 2147483647',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'font-size: 13px',
      'color: #e1e4e8',
      'user-select: none'
    ].join(';');

    var checkIcon = document.createElement('span');
    checkIcon.textContent = '\\u2714';
    checkIcon.style.cssText = 'color:#3fb950;font-size:16px';
    postBar.appendChild(checkIcon);

    var msg = document.createElement('span');
    msg.textContent = '录制已完成';
    msg.style.cssText = 'color:#e1e4e8;font-weight:600';
    postBar.appendChild(msg);

    var spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1';
    postBar.appendChild(spacer);

    var manageBtn = document.createElement('button');
    manageBtn.textContent = '录制管理';
    manageBtn.style.cssText = [
      'padding: 4px 12px',
      'background: #1f6feb',
      'color: #fff',
      'border: none',
      'border-radius: 4px',
      'font-size: 12px',
      'cursor: pointer'
    ].join(';');
    manageBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (window.autoTestBridge && window.autoTestBridge.openRecorderUI) {
        window.autoTestBridge.openRecorderUI();
      }
    });
    postBar.appendChild(manageBtn);

    var homeBtn = document.createElement('button');
    homeBtn.textContent = '返回首页';
    homeBtn.style.cssText = [
      'padding: 4px 12px',
      'background: #30363d',
      'color: #8b949e',
      'border: 1px solid #484f58',
      'border-radius: 4px',
      'font-size: 12px',
      'cursor: pointer'
    ].join(';');
    homeBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (window.autoTestBridge && window.autoTestBridge.openWelcome) {
        window.autoTestBridge.openWelcome();
      }
    });
    postBar.appendChild(homeBtn);

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '\\u2715';
    closeBtn.style.cssText = 'background:none;border:none;color:#8b949e;cursor:pointer;font-size:16px;padding:4px';
    closeBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var el = document.getElementById('__auto-test-post-bar');
      if (el) el.remove();
    });
    postBar.appendChild(closeBtn);

    document.body.appendChild(postBar);
  }

  // Periodic state sync from main process
  stateSyncInterval = setInterval(function() {
    if (window.autoTestBridge && window.autoTestBridge.getRecordingState) {
      window.autoTestBridge.getRecordingState().then(function(state) {
        if (!state || state.state !== 'recording') {
          removeBar();
          return;
        }
        var el = document.getElementById('__rec-step-count');
        if (el) el.textContent = '步骤: ' + state.totalSteps;
        var gEl = document.getElementById('__rec-group-name');
        if (gEl && state.currentGroupLabel) gEl.textContent = '分组: ' + state.currentGroupLabel;
      }).catch(function() {});
    }
  }, 3000);
})();
`;
};

/**
 * Inject the recorder capture script into the given window.
 */
export const injectRecorder = async (win: BrowserWindow): Promise<void> => {
  try {
    const script = buildRecorderScript();
    await win.webContents.executeJavaScript(script);
    logger.info("Recorder script injected");
  } catch (err) {
    logger.error("Failed to inject recorder script", err);
  }
};
