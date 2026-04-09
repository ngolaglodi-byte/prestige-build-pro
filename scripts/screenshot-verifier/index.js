// Prestige Build — Screenshot Verifier
// Isolated Playwright container that loads project preview pages, captures screenshots,
// console errors, network failures, and returns a structured health report.
//
// HTTP API:
//   POST /verify
//   Body: { url: string, projectId: number, timeout?: number }
//   Response: { ok, screenshot_b64?, issues: [], duration_ms, console_errors, network_errors }
//
// Privacy: NOT exposed externally. Listens on internal docker network only.
// No authentication needed because it's reachable only via the pbp-projects network.

'use strict';

const http = require('http');
const { chromium } = require('playwright');

const PORT = parseInt(process.env.PORT || '4000', 10);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_WAIT_AFTER_LOAD_MS = 2000; // Let React render after networkidle

let browser = null;

// Lazy-init the browser. Only one instance shared across requests for efficiency.
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  console.log('[verifier] chromium launched');
  return browser;
}

// Pixel variance check on the captured screenshot.
// A blank/white/black screen has near-zero variance in the central region.
// We don't load `sharp` to keep deps minimal — Playwright's screenshot returns PNG buffer
// and we can do a quick sample without an image library.
function quickBlankCheck(buffer) {
  // Sample 100 pixels from the center of the PNG. We can't decode without a lib,
  // but we can check that the file is not absurdly small (a blank PNG of size 1024x768
  // compresses to ~5KB; a populated page is typically 50KB+).
  if (!buffer || buffer.length < 8000) {
    return { likelyBlank: true, reason: 'screenshot too small (< 8KB)', size: buffer ? buffer.length : 0 };
  }
  return { likelyBlank: false, size: buffer.length };
}

async function verifyUrl(url, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  const result = {
    ok: true,
    issues: [],
    console_errors: [],
    network_errors: [],
    duration_ms: 0,
    screenshot_size: 0
  };

  let context, page;
  try {
    const b = await getBrowser();
    context = await b.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true
    });
    page = await context.newPage();

    // Capture console errors
    page.on('console', msg => {
      if (msg.type() === 'error') result.console_errors.push(msg.text().substring(0, 300));
    });
    page.on('pageerror', err => {
      result.console_errors.push(`PageError: ${err.message.substring(0, 300)}`);
    });
    // Capture failed network requests (4xx/5xx)
    page.on('response', resp => {
      const status = resp.status();
      if (status >= 400) {
        result.network_errors.push(`${status} ${resp.url().substring(0, 200)}`);
      }
    });
    page.on('requestfailed', req => {
      result.network_errors.push(`FAIL ${req.url().substring(0, 200)}: ${req.failure()?.errorText || 'unknown'}`);
    });

    // Navigate
    await page.goto(url, { timeout, waitUntil: 'networkidle' });
    // Give React a moment to mount
    await page.waitForTimeout(DEFAULT_WAIT_AFTER_LOAD_MS);

    // Take screenshot
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const blankCheck = quickBlankCheck(screenshot);
    result.screenshot_size = blankCheck.size;

    if (blankCheck.likelyBlank) {
      result.ok = false;
      result.issues.push({
        type: 'BLANK_SCREEN',
        severity: 'warning',
        message: `Likely blank screen: ${blankCheck.reason}`
      });
    }
    if (result.console_errors.length > 0) {
      result.ok = false;
      result.issues.push({
        type: 'JS_CONSOLE_ERRORS',
        severity: 'warning',
        message: `${result.console_errors.length} JS console error(s)`,
        details: result.console_errors.slice(0, 5)
      });
    }
    // Filter network errors: only flag if it's API calls, not asset 404s
    const apiNetErrors = result.network_errors.filter(e => /\/api\//.test(e));
    if (apiNetErrors.length > 0) {
      result.ok = false;
      result.issues.push({
        type: 'API_NETWORK_FAILURES',
        severity: 'warning',
        message: `${apiNetErrors.length} failed API request(s)`,
        details: apiNetErrors.slice(0, 5)
      });
    }
  } catch (e) {
    result.ok = false;
    result.issues.push({
      type: 'NAVIGATION_FAILED',
      severity: 'warning',
      message: `Navigation/load failed: ${e.message.substring(0, 300)}`
    });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    result.duration_ms = Date.now() - t0;
  }

  return result;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, browser: !!(browser && browser.isConnected()) }));
    return;
  }
  if (req.method === 'POST' && req.url === '/verify') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { url, projectId, timeout } = JSON.parse(body);
        if (!url || typeof url !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'url required' }));
          return;
        }
        console.log(`[verify] project=${projectId} url=${url}`);
        const result = await verifyUrl(url, { timeout });
        console.log(`[verify] project=${projectId} ok=${result.ok} issues=${result.issues.length} duration=${result.duration_ms}ms`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error('[verify] error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[verifier] listening on :${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[verifier] SIGTERM, closing browser');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
