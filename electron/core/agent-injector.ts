/**
 * Handles injecting the page-agent IIFE bundle into loaded pages.
 * Reads the local node_modules copy, injects it via executeJavaScript,
 * then manually creates a PageAgent instance with the correct LLM config
 * and registers the IPC command dispatcher.
 */

import * as fs from "fs";
import * as path from "path";
import { type BrowserWindow } from "electron";
import { logger } from "./logger";

const PAGE_AGENT_BUNDLE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "node_modules",
  "page-agent",
  "dist",
  "iife",
  "page-agent.demo.js"
);

interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 5000;

let cachedBundle: string | null = null;

const readBundle = (): string => {
  if (cachedBundle) {
    return cachedBundle;
  }
  try {
    cachedBundle = fs.readFileSync(PAGE_AGENT_BUNDLE_PATH, "utf-8");
    return cachedBundle;
  } catch (err) {
    logger.error("Failed to read page-agent bundle", err);
    throw new Error(`Cannot read page-agent bundle at ${PAGE_AGENT_BUNDLE_PATH}`);
  }
};

/**
 * Build the injection script:
 * 1. Inject the IIFE bundle (defines window.PageAgent class and auto-creates window.pageAgent)
 * 2. Wait for window.PageAgent to be available via polling
 * 3. Dispose the auto-created demo instance and create a new one with correct LLM config
 * 4. Register the IPC command dispatcher that bridges autoTestBridge to page-agent API
 */
const buildInjectionScript = (bundle: string, config: LlmConfig): string => {
  const initAndDispatchScript = `
;(function() {
  var POLL_INTERVAL = ${POLL_INTERVAL_MS};
  var POLL_TIMEOUT = ${POLL_TIMEOUT_MS};
  var startTime = Date.now();

  function waitForPageAgent(callback) {
    // Wait for window.pageAgent (the demo INSTANCE created by the IIFE's deferred setTimeout),
    // not just window.PageAgent (the class, available immediately).
    // The demo bundle creates the instance in a setTimeout(()=>{...}, 0),
    // so we must wait for it to fire before we can dispose and recreate.
    if (window.pageAgent && window.PageAgent) {
      callback();
      return;
    }
    if (Date.now() - startTime > POLL_TIMEOUT) {
      console.error('[auto-test-view] Timed out waiting for window.pageAgent instance');
      return;
    }
    setTimeout(function() { waitForPageAgent(callback); }, POLL_INTERVAL);
  }

  waitForPageAgent(function() {
    // Dispose the auto-created demo instance if it exists
    if (window.pageAgent) {
      try { window.pageAgent.dispose(); } catch(e) { /* ignore */ }
    }

    // Create a customFetch that proxies through Electron IPC to bypass mixed content
    var ipcFetch = async function(url, init) {
      init = init || {};
      var headerObj = {};
      if (init.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach(function(v, k) { headerObj[k] = v; });
        } else if (typeof init.headers === 'object') {
          headerObj = Object.assign({}, init.headers);
        }
      }
      var ipcResult = await window.autoTestBridge.llmFetch(url, {
        method: init.method || 'POST',
        headers: headerObj,
        body: typeof init.body === 'string' ? init.body : undefined
      });
      // Return a Response-like object that page-agent's OpenAIClient expects
      return {
        ok: ipcResult.ok,
        status: ipcResult.status,
        statusText: ipcResult.statusText,
        json: function() { return Promise.resolve(JSON.parse(ipcResult.bodyText)); },
        text: function() { return Promise.resolve(ipcResult.bodyText); }
      };
    };

    // Create a new instance with the correct LLM config
    window.pageAgent = new window.PageAgent({
      model: ${JSON.stringify(config.model)},
      baseURL: ${JSON.stringify(config.baseUrl)},
      apiKey: ${JSON.stringify(config.apiKey)},
      language: 'zh-CN',
      customFetch: ipcFetch
    });
    window.pageAgent.panel.show();
    console.log('[auto-test-view] page-agent re-initialized with custom LLM config');

    // Auto-index DOM so click/scroll work immediately without needing get_page_state first
    try {
      window.pageAgent.pageController.getBrowserState().then(function() {
        console.log('[auto-test-view] DOM auto-indexed');
      }).catch(function(e) {
        console.warn('[auto-test-view] DOM auto-index failed:', e);
      });
    } catch(e) {
      console.warn('[auto-test-view] DOM auto-index sync error:', e);
    }

    // Register IPC command dispatcher
    if (window.autoTestBridge && window.autoTestBridge.onCommand) {
      window.autoTestBridge.onCommand(async function(command) {
        try {
          var result;
          var agent = window.pageAgent;
          if (!agent) {
            throw new Error('page-agent is not initialized');
          }

          switch (command.type) {
            case 'execute_task':
              result = await agent.execute(command.payload.task);
              break;

            case 'get_page_state':
              result = await agent.pageController.getBrowserState();
              break;

            case 'click_element':
              result = await agent.pageController.clickElement(command.payload.index);
              break;

            case 'input_text':
              result = await agent.pageController.inputText(
                command.payload.index,
                command.payload.text
              );
              break;

            case 'scroll': {
              var p = command.payload;
              var scrollOpts = { down: true, numPages: p.pages || 1 };
              if (p.direction === 'up') {
                scrollOpts.down = false;
              } else if (p.direction === 'left') {
                result = await agent.pageController.scrollHorizontally({
                  right: false, pixels: (p.pages || 1) * 300
                });
                break;
              } else if (p.direction === 'right') {
                result = await agent.pageController.scrollHorizontally({
                  right: true, pixels: (p.pages || 1) * 300
                });
                break;
              }
              result = await agent.pageController.scroll(scrollOpts);
              break;
            }

            case 'get_status':
              result = { status: agent.status };
              break;

            case 'stop_task':
              agent.stop();
              result = { stopped: true };
              break;

            default:
              throw new Error('Unknown command type: ' + command.type);
          }

          await window.autoTestBridge.sendResult(result);
        } catch (err) {
          await window.autoTestBridge.sendResult({
            error: err.message || String(err)
          });
        }
      });
      console.log('[auto-test-view] IPC command dispatcher registered');
      // Signal readiness to the main process
      if (window.autoTestBridge.signalReady) {
        window.autoTestBridge.signalReady();
      }
    } else {
      console.error('[auto-test-view] autoTestBridge not available - command dispatcher not registered');
    }
  });
})();
`;
  return bundle + "\n" + initAndDispatchScript;
};

export const injectPageAgent = async (
  win: BrowserWindow,
  config: LlmConfig
): Promise<void> => {
  const bundle = readBundle();
  const script = buildInjectionScript(bundle, config);

  try {
    await win.webContents.executeJavaScript(script);
    logger.info("page-agent injected successfully");
  } catch (err) {
    logger.error("Failed to inject page-agent", err);
  }
};
