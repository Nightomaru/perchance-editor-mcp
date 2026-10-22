// perch-core.js — in-process Perchance editor controller.
//
// Lives inside the perch MCP server process (same model @playwright/mcp uses):
// no TCP daemon, no per-call spawn.
//
// Design notes:
//   * Preview-frame resolution. The running generator is the subframe
//     #outputIframeEl. Resolve it by iframe id, then by the perchance
//     subdomain URL, then by any live non-blank child frame. Never compare
//     an ElementHandle's `.id` — it is always undefined.
//   * Cloudflare: stealth launch args + init script, and a 4-step escalation
//     ladder (reuse ctx -> new ctx -> relaunch browser -> relaunch headed).
//     CF flagging is intermittent, so the ladder is what makes it reliable.
//   * Browser-free code access: `pull()` fetches modelText + outputTemplate
//     straight from the public API via curl (~1.2s, no CF risk) and writes
//     local mirror files, so reading/grepping code needs no browser at all.
//   * Diagnostics: console + pageerror buffers captured from every frame.
//   * UI testing by text: `snapshot()` lists interactive elements in the live
//     preview so an agent can drive the UI without screenshots.
//   * engine option: 'firefox' (DEFAULT — plain playwright firefox; clears
//     Cloudflare on perchance.org subdomains where chromium engines are
//     flagged) | 'chromium' (plain playwright chromium escape hatch, also the
//     automatic fallback when the firefox binary is unavailable).
//
// NOTE ON eval(): the `evaluate(...)` calls below are a browser JS-expression
// evaluator — that IS the feature (perch_eval / perch_type drive the live
// generator under test). The "eval_injection" lint hit is expected here.

const path = require('path');
const fs = require('fs');

// UA for the browser-free curl path only. The live browser path derives its
// UA from the actual binary version (see _launch) so the UA string can never
// contradict the client-hints headers the browser itself sends.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IDLE_MS = 20 * 60 * 1000;
const MIRROR_ROOT = path.join(__dirname, '.perch-mirror');
// Locale/timezone are fingerprint inputs for the CF risk score; keep them
// consistent with the UA above and overridable by the caller.
const LOCALE = 'en-US';
const TIMEZONE = 'UTC';

// Reduce the automation fingerprint. Cloudflare scores navigator.webdriver +
// CDP artifacts; the init script handles the JS side, these flags the process.
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-default-browser-check',
  '--no-first-run',
  '--disable-infobars',
  '--disable-features=IsolateOrigins,site-per-process',
];

const STEALTH_INIT = () => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
  } catch (e) {}
};

// Standard playwright evaluate shape. Every evaluate that touches page globals
// goes through evalMain so the call shape has exactly one definition point.
function evalMain(target, fn, arg) {
  return target.evaluate(fn, arg);
}

// Default UA template per host OS (no fingerprint injection — this only
// exists to strip the "Headless" marker in headless mode, keeping the REAL
// browser version so UA and client hints always agree).
function platformUaPrefix() {
  switch (process.platform) {
    case 'darwin': return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
    case 'linux': return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)';
    default: return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)';
  }
}

// ---------------- engines ----------------
// One table, because a start can now walk ENGINES and not just steps: a browser that clears
// Cloudflare can still fail to boot the generator's PREVIEW (the platform's own "file loader"
// never arriving), and those two failures land on different engines.
//
//   firefox     plain playwright firefox        — default; clears perchance-subdomain CF
//   chrome      plain playwright chromium       — NO stealth args, NO init script (the control)
//   patchright  patchright's chromium           — drop-in playwright fork, patched CDP surface
//   chromium    playwright chromium + stealth   — the original escape hatch
//
// An engine must hand back a playwright-compatible Browser: this file drives pages, frames and
// evaluate() directly. That is also why the camofox-browser REST server cannot be an engine here
// — it exposes accessibility snapshots and clicks, not arbitrary JS in the page or its frames.
const ENGINES = {
  firefox:    { family: 'firefox',  stealth: false, label: 'playwright firefox' },
  chrome:     { family: 'chromium', stealth: false, label: 'playwright chromium, plain' },
  patchright: { family: 'chromium', stealth: false, label: 'patchright chromium' },
  chromium:   { family: 'chromium', stealth: true,  label: 'playwright chromium, stealth' },
};
// The order a start walks when it is asked for a chain — the engines that work first, and last the
// one that cannot read or write docs at all (kept because it is cheap to offer and the verdict may
// change with a platform update; see SKILL.md for the measured capability matrix).
//   firefox     the only engine that can ALSO use Perchance's server-side generation plugins
//               (ai-text replies / uploads) — those embeds are CF-flagged on chromium
//   chrome      plain chromium: clears CF headed, drives the editor + preview (no ai-text calls)
//   chromium    the same with the legacy stealth args
//   patchright  clears CF headed, but the platform's editor globals never publish -> cannot read
//               or write docs, so it is only reached once everything else has failed
const ENGINE_CHAIN = ['firefox', 'chrome', 'chromium', 'patchright'];

const _engineCache = {};
function loadChromium() {
  if (_engineCache.playwright) return _engineCache.playwright;
  const mod = require('playwright');
  _engineCache.playwright = { chromium: mod.chromium, firefox: mod.firefox };
  return _engineCache.playwright;
}
function loadPatchright() {
  if (_engineCache.patchright) return _engineCache.patchright;
  const mod = require('patchright');
  _engineCache.patchright = { chromium: mod.chromium };
  return _engineCache.patchright;
}

// Launch one engine. `effective` is what the caller reports back; it differs from the engine key
// only for the missing-firefox fallback (see _launch).
async function launchEngine(name, headed, width, height) {
  const spec = ENGINES[name];
  if (!spec) throw new Error('unknown engine "' + name + '" (have: ' + Object.keys(ENGINES).join(', ') + ')');
  const headless = !headed;
  if (name === 'patchright') {
    const pr = loadPatchright();
    return { browser: await pr.chromium.launch({ headless }), engine: name, effective: 'patchright' };
  }
  const pw = loadChromium();
  if (name === 'firefox') {
    if (!pw.firefox) throw new Error('playwright firefox binary missing — run `npx playwright install firefox`');
    return { browser: await pw.firefox.launch({ headless }), engine: name, effective: 'firefox' };
  }
  if (name === 'chrome') {
    return { browser: await pw.chromium.launch({ headless }), engine: name, effective: 'chrome' };
  }
  return { browser: await pw.chromium.launch({ headless, args: STEALTH_ARGS }), engine: name, effective: 'chromium' };
}

function buildEditorUrl(name, collabKey) {
  const base = `https://perchance.org/${name}`;
  return collabKey ? `${base}#edit:collab=${collabKey}` : `${base}#edit`;
}

// Detect a Cloudflare Turnstile / "Just a moment" interstitial.
// NOTE: do NOT match the bare word "cloudflare" in page text — perchance.org
// is behind Cloudflare and references it in its own HTML. Match the
// interstitial's structural signals instead.
async function isCfBlocked(page) {
  try {
    return await evalMain(page, () => {
      const t = (document.body && document.body.innerText || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      const hasTurnstile = document.querySelector(
        '#cf-turnstile, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]') !== null;
      return hasTurnstile ||
        title.includes('just a moment') ||
        t.includes('just a moment') ||
        t.includes('performing security verification') ||
        t.includes('verifying you are human') ||
        t.includes('checking your browser') ||
        t.includes('verify you are human');
    });
  } catch { return true; }
}

class PerchSession {
  constructor() {
    this.browser = null;
    this.ctx = null;
    this.page = null;
    this.generator = null;
    this.collabKey = null;
    this.headed = null;      // true = visible window
    this.engine = 'firefox';
    this.effectiveEngine = null; // what is actually running (engine / fallback)
    this._runningEngine = null;  // 'firefox' | 'chromium' — set by _launch
    this.ready = false;
    this.last = Date.now();
    this._idle = null;
    this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
  }

  _touch() { this.last = Date.now(); }

  _ensureIdle() {
    if (this._idle) return;
    this._idle = setInterval(() => {
      if (this.ctx && Date.now() - this.last > IDLE_MS) {
        this.stop().catch(() => {});
      }
    }, 30000);
    this._idle.unref();
  }

  // ---------------- diagnostics (console + runtime errors) ----------------
  _pushDiag(arr, droppedKey, entry, cap = 300) {
    arr.push(entry);
    if (arr.length > cap) { arr.shift(); this.diag[droppedKey]++; }
  }

  _attachDiagnostics(page) {
    this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    const push = (arr, droppedKey, entry, cap = 300) => this._pushDiag(arr, droppedKey, entry, cap);
    try {
      page.on('console', (msg) => {
        const type = msg.type();
        if (type === 'debug') return;
        const loc = msg.location() || {};
        push(this.diag.console, 'droppedConsole',
          `[${type}] ${msg.text()}${loc.url ? ' @ ' + String(loc.url).slice(-60) + ':' + loc.lineNumber : ''}`);
      });
      page.on('pageerror', (err) => {
        push(this.diag.errors, 'droppedErrors', (err && err.message) ? err.message : String(err));
      });
      page.on('requestfailed', (req) => {
        const url = req.url() || '';
        if (/\.(woff2?|png|jpe?g|svg|gif|ico)(\?|$)/i.test(url)) return;
        const f = req.failure();
        push(this.diag.console, 'droppedConsole', `[net-fail] ${url.slice(0, 120)} — ${f ? f.errorText : 'unknown'}`);
      });
    } catch (e) {}
  }

  async errors({ clear = false } = {}) {
    const syntax = this.page
      ? await evalMain(this.page, () => {
          try { return window.getEditorSyntaxErrors ? window.getEditorSyntaxErrors() : null; } catch (e) { return 'err:' + e.message; }
        }).catch(() => null)
      : null;
    // The editor surfaces generator runtime errors in its own error view (the user-facing
    // "An error has occurred somewhere in your code" panel). Those never reach the pane syntax
    // check and drown in console noise, so read the panel directly. Selectors are defensive:
    // the editor build changes its DOM without notice (window.yjsProvider already vanished).
    const errorView = this.page
      ? await evalMain(this.page, () => {
          try {
            const texts = [];
            const sels = ['.perchance-error-view', '[class*="error-view"]', '[class*="errorView"]',
                          '[id*="error-view"]', '[id*="errorView"]', '#errorView'];
            for (const s of sels) {
              for (const el of document.querySelectorAll(s)) {
                const t = String(el.innerText || '').trim();
                if (t) texts.push(t.slice(0, 2000));
              }
            }
            if (!texts.length && document.body) {
              const re = /error (?:has )?occurred somewhere|unhandled promise rejection/i;
              const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
              let n, guard = 0;
              while ((n = w.nextNode()) && guard++ < 3000) {
                const t = String(n.textContent || '');
                if (re.test(t) && t.length < 4000) { texts.push(t.replace(/\s+/g, ' ').slice(0, 2000)); break; }
              }
            }
            return texts;
          } catch (e) { return ['err:' + e.message]; }
        }).catch(() => null)
      : null;
    const out = {
      ok: true,
      syntaxErrors: syntax,
      errorView: errorView && errorView.length ? errorView : null,
      runtimeErrors: this.diag.errors.slice(-50),
      consoleTail: this.diag.console.slice(-50),
      droppedConsole: this.diag.droppedConsole,
      droppedErrors: this.diag.droppedErrors,
    };
    if (clear) this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    return out;
  }

  // Poll until the Yjs provider has flushed the pending edit to the server.
  async settle(timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      this._touch();
      let s = null;
      try {
        s = await evalMain(this.page, () => ({
          synced: !!(window.yjsProvider && window.yjsProvider.synced),
          save: window.perchanceSaveState || null,
        }));
      } catch { break; }
      if (s && s.synced && s.save !== 'saving') return true;
      await this.page.waitForTimeout(300);
    }
    return false;
  }

  // Resolve a target frame.
  //   'editor'  -> the Perchance editor page itself (chrome: editors, buttons)
  //   'preview' -> the running generator (the outputIframeEl subframe)
  //
  // v2 bug: `f.frameElement()` returns an ElementHandle, whose `.id` is always
  // undefined, so the id test never matched and the code fell through to the
  // LAST child frame — normally a chrome-error or about:blank frame.
  async _frame(which) {
    if (which === 'editor') return this.page;
    const frames = this.page.frames();
    for (const f of frames) {
      if (f === this.page.mainFrame()) continue;
      let id = null;
      try {
        const el = await f.frameElement();
        if (el) id = await el.getAttribute('id');
      } catch {}
      if (id === 'outputIframeEl') return f;
    }
    // 2) the preview runs on a per-user perchance subdomain
    for (const f of frames) {
      let url = '';
      try { url = f.url(); } catch {}
      if (/^https:\/\/[0-9a-f]{16,}\.perchance\.org\//.test(url)) return f;
    }
    // 3) last resort: any live, non-blank, non-console child frame
    const kids = frames.filter(f => {
      try {
        const u = f.url();
        return f.parentFrame() && u && u !== 'about:blank' &&
          !u.startsWith('chrome-error') && f.name() !== 'console-output';
      } catch { return false; }
    });
    if (kids.length) return kids[kids.length - 1];
    throw new Error('preview iframe not found (preview not loaded?)');
  }

  async _newContext(width, height) {
    const running = ENGINES[this._runningEngine] || ENGINES.firefox;
    const opts = { viewport: { width, height } };
    if (running.family === 'firefox' || !running.stealth) {
      // Bare context. Firefox carries no "Headless" UA marker and the native fingerprint cleared
      // the CF challenges; plain chromium ('chrome') is here to send exactly what an ordinary
      // browser sends, so it gets no UA rewrite, no locale override and no init script either.
      return this.browser.newContext(opts);
    }
    if (this.browser && this.headed === false) {
      // Headless default UA contains the "Headless" marker; replace it with
      // the real binary version (the old hardcoded version drifted from the
      // actual browser and contradicted the client-hint headers).
      const real = String(this.browser.version() || '');
      if (real) opts.userAgent = platformUaPrefix() + ' Chrome/' + real + ' Safari/537.36';
      else opts.userAgent = UA;
    }
    opts.locale = LOCALE;
    opts.timezoneId = TIMEZONE;
    const ctx = await this.browser.newContext(opts);
    await ctx.addInitScript(STEALTH_INIT);
    return ctx;
  }

  async _launch(headed, width, height) {
    const want = this.engine || 'firefox';
    let r;
    try {
      r = await launchEngine(want, headed, width, height);
    } catch (e) {
      // The firefox binary is installed separately from the npm package, so keep the old grace
      // note: no binary means plain chromium rather than a failed start.
      if (want !== 'firefox') throw e;
      try { console.error('perch-mcp: playwright firefox unavailable (' + String((e && e.message) || e).slice(0, 140) + ') — falling back to chromium.'); } catch (e2) {}
      r = await launchEngine('chrome', headed, width, height);
      r.effective = 'chromium (firefox binary unavailable)';
    }
    this._runningEngine = r.engine;         // the engine KEY that is actually running
    this.effectiveEngine = r.effective;     // what gets reported (differs for the fallback above)
    this.browser = r.browser;
    this.ctx = await this._newContext(width, height);
    this._ensureIdle();
    return this.ctx;
  }

  // Make `name` the running engine: reuse it when it already is, else close what is running and
  // launch it. This is what lets a start() walk the engine chain instead of only re-trying steps
  // inside whichever browser it already had.
  async _ensureEngine(name, headed, width, height) {
    this.engine = name;
    if (this.browser && this._runningEngine === name) return;
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
    if (this.browser) { try { await this.browser.close(); } catch {} this.browser = null; }
    await this._launch(headed, width, height);
  }

  // Health of the generator PREVIEW (the frame the app actually runs in).
  //
  // The editor page can be perfectly healthy while the preview is dead: the platform's "file
  // loader" (root.loadDependencies, a script block of the page itself) sometimes never arrives
  // and the app never boots — the frame then shows "This generator could not start because its
  // file loader did not become available." Nothing used to look at the preview at all, so a
  // start could report ok:true while every perch_eval against it pended forever. These three
  // signals are read straight out of the frame.
  async previewHealth() {
    if (!this.page) return { ok: true, running: false, hint: 'not started' };
    let frame;
    try { frame = await this._frame('preview'); }
    catch (e) { return { ok: true, found: false, note: 'no preview frame yet' }; }
    try {
      const r = await evalMain(frame, () => {
        const errEl = document.querySelector('#perchance-src-loader-error');
        return {
          loaderError: !!errEl,
          loaderErrorText: errEl ? String(errEl.textContent || '').slice(0, 220) : null,
          booted: typeof window.getAiProvider === 'function',
          text: String((document.body && document.body.innerText) || '').slice(0, 160),
        };
      });
      return { ok: true, found: true, ...r, healthy: !!r.booted && !r.loaderError };
    } catch (e) {
      return { ok: true, found: true, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // Load the editor and wait until both docs are populated.
  // Returns { docsReady, cfBlocked, cfWaitedMs }.
  async _loadEditor(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let cfWaitedMs = 0;
    if (await isCfBlocked(page)) {
      // Turnstile can take 60-90s of "Waiting for token..." loops
      // before the challenge clears — 25s aborted a solve that was about to
      // succeed and sent the ladder into an endless relaunch cycle.
      const cfStart = Date.now();
      while (await isCfBlocked(page)) {
        if (Date.now() - cfStart > 90000) break;
        await page.waitForTimeout(2000);
      }
      cfWaitedMs = Date.now() - cfStart;
      if (await isCfBlocked(page)) return { docsReady: false, cfBlocked: true, cfWaitedMs };
      await page.waitForTimeout(2000);
    }
    await page.waitForFunction(() => {
      const w = window;
      if (w.__collabRoomFailed === true) return true;
      if (w.yjsProvider && w.yjsProvider.synced === true) return true;
      return false;
    }, null, { timeout: 45000 }).catch(() => {});
    await page.waitForFunction(() => window.outputTemplateEditor && window.modelTextEditor,
      null, { timeout: 25000 }).catch(() => {});
    const docsReady = async (timeoutMs) => {
      await page.waitForFunction(() => {
        const o = window.outputTemplateEditor, m = window.modelTextEditor;
        if (!o || !m) return false;
        return o.state.doc.length > 10 && m.state.doc.length > 10;
      }, null, { timeout: timeoutMs });
    };
    let ready = false;
    try { await docsReady(75000); ready = true; } catch { ready = false; }
    if (!ready) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      try { await docsReady(75000); ready = true; } catch { ready = false; }
    }
    await page.waitForTimeout(250);
    return { docsReady: ready, cfBlocked: false, cfWaitedMs };
  }

  // Load the editor, and hand back a preview that actually booted.
  //
  // Two ladders in one: the steps inside an engine (fresh context -> relaunch -> relaunch headed)
  // and, when an engine keeps producing a dead preview, the next engine in `engines`. The engine
  // switch is what a "file loader did not become available" preview needs — it is not a Cloudflare
  // block and no amount of re-trying the same browser fixes it.
  async _openWithLadder(url, { width, height, engines = null }) {
    const chain = (Array.isArray(engines) && engines.length ? engines : [this.engine || 'firefox']).slice();
    const attempts = [];
    let lastPreview = null;
    for (let ei = 0; ei < chain.length; ei++) {
      const engineName = chain[ei];
      const isLastEngine = ei === chain.length - 1;
      const steps = [
        { mode: 'newctx', headed: this.headed },
        { mode: 'relaunch', headed: this.headed },
      ];
      if (!this.headed) steps.push({ mode: 'relaunch', headed: true });
      for (const step of steps) {
        const label = engineName + ':' + step.mode + (step.headed ? '+headed' : '');
        const t0 = Date.now();
        try {
          if (step.mode === 'newctx' && this.browser && this._runningEngine === engineName && this.ctx) {
            // Same engine already up: a fresh context is the cheap first move.
            try { await this.ctx.close(); } catch {}
            this.ctx = await this._newContext(width, height);
          } else {
            this.headed = step.headed;
            await this._ensureEngine(engineName, step.headed, width, height);
            if (!this.ctx) this.ctx = await this._newContext(width, height);
          }
          this.page = await this.ctx.newPage();
          this._attachDiagnostics(this.page);
          const r = await this._loadEditor(this.page, url);
          const preview = r.docsReady ? await this.previewHealth() : null;
          if (preview) lastPreview = preview;
          attempts.push({
            step: label, engine: engineName, effectiveEngine: this.effectiveEngine,
            docsReady: r.docsReady, cfBlocked: r.cfBlocked,
            previewBooted: preview ? !!preview.booted : null,
            previewLoaderError: preview ? !!preview.loaderError : null,
            ms: Date.now() - t0,
          });
          if (r.docsReady && preview && preview.healthy) return { ok: true, attempts, step: label, preview };
          // Editor fine but the preview is dead: give the next engine a turn. Only the last
          // engine keeps spending its remaining steps (there is nowhere left to go).
          if (r.docsReady && !isLastEngine) break;
        } catch (e) {
          attempts.push({ step: label, engine: engineName, error: String((e && e.message) || e).slice(0, 180), ms: Date.now() - t0 });
        }
      }
    }
    const docsOk = attempts.some(a => a.docsReady);
    return { ok: docsOk, attempts, degraded: docsOk, preview: lastPreview };
  }

  // One-shot entry: launch (if needed) + load generator + collab key.
  async start({ name, collabKey = null, headed = false, width = 1500, height = 950, force = false, engine = null, engineChain = null } = {}) {
    this._touch();
    const t0 = Date.now();
    if (!name) throw new Error('missing generator name');
    if (engine) this.engine = engine; else this.engine = 'firefox'; // default: playwright firefox (clears perchance-subdomain CF challenges where chromium is flagged; falls back to chromium when the firefox binary is absent)
    // An explicit engine that differs from the RUNNING browser must take
    // effect: the ladder's 'newctx' step only recreates the context and would
    // otherwise silently keep the old engine (observed: engine:"chromium"
    // answered effectiveEngine:"patchright"). Force a relaunch in that case.
    if (engine && this.browser && this._runningEngine && this._runningEngine !== this.engine) {
      try { if (this.ctx) { await this.ctx.close(); } } catch {}
      try { await this.browser.close(); } catch {}
      this.ctx = null; this.browser = null; this.page = null; this.ready = false;
    }
    if (this.page && !force && this.ready && this.generator === name && this.collabKey === collabKey) {
      const s = await this.status();
      // Fall through to the ladder when the page is CF-blocked or the editor
      // views are gone — a plain re-call must actually escalate (fix: the old
      // fast path returned ok:true + cfBlocked:true forever, so the advertised
      // "call perch_start again" recovery never ran).
      if (!s.cfBlocked && s.hasOutputView && s.hasModelView) {
        return { ok: true, alreadyLoaded: true, ms: Date.now() - t0, ...s };
      }
    }
    this.headed = !!headed;
    const url = buildEditorUrl(name, collabKey);
    // The engine chain. An explicit array wins, `false` pins the one engine, and the DEFAULT walks
    // the recommended engines starting at the requested one — so a start that cannot load the editor,
    // or whose preview never boots, recovers by itself instead of leaving the caller with a dead
    // preview. A healthy start never leaves the first engine: the ladder returns as soon as the
    // preview is healthy, so the fallbacks cost nothing in the normal case.
    let chain = [this.engine];
    if (Array.isArray(engineChain) && engineChain.length) {
      chain = engineChain.slice();
    } else if (engineChain !== false) {
      const i = ENGINE_CHAIN.indexOf(this.engine);
      chain = i === -1 ? [this.engine] : ENGINE_CHAIN.slice(i);
    }
    // A typo'd or removed engine name must fail loudly. The ladder treats a launch failure as one
    // dead attempt and walks on, so without this an engine this build no longer ships (or a typo)
    // would silently start a different browser.
    const knownEngines = Object.keys(ENGINES);
    for (const e of chain) {
      if (!knownEngines.includes(e)) {
        throw new Error('unknown engine "' + e + '" (have: ' + knownEngines.join(', ') + ')');
      }
    }
    const r = await this._openWithLadder(url, { width, height, engines: chain });
    this.generator = name;
    this.collabKey = collabKey;
    if (!r.ok) {
      this.ready = false;
      return {
        ok: false, generator: name, collabKey, url, headed: this.headed, engine: this.engine,
        effectiveEngine: this.effectiveEngine || this.engine,
        ms: Date.now() - t0, cfBlocked: true, attempts: r.attempts,
        error: 'Cloudflare challenge not cleared after ' + r.attempts.length + ' attempt(s).',
        hint: 'CF flagging is intermittent — retry, or headed:true. The default firefox engine clears the subdomain challenges chromium cannot.',
      };
    }
    const st = await this.status();
    this.ready = !!(st.hasOutputView && st.hasModelView && !st.cfBlocked);
    const preview = r.preview || st.preview || null;
    const previewDead = !!(preview && preview.found && !preview.healthy);
    return {
      ok: true, generator: name, collabKey, url, headed: this.headed, engine: this.engine,
      effectiveEngine: this.effectiveEngine || this.engine,
      docsReady: st.hasOutputView, recoveryStep: r.step, attempts: r.attempts, ms: Date.now() - t0,
      engineChain: chain,
      preview,
      ...(previewDead ? {
        previewDegraded: true,
        warning: 'The editor loaded but the generator preview did not boot (' +
          (preview.loaderError ? 'its file loader never arrived' : 'unknown reason') +
          '). Evaluations and UI tests against the preview will hang. Re-call perch_start with engineChain:[...] to try another engine — ' + ENGINE_CHAIN.join(' / ') + '.',
      } : {}),
      ...(this.ready ? {} : { warning: 'Editor docs not fully ready — try perch_start again.' }),
    };
  }

  async status() {
    if (!this.page) return { ok: true, running: false, engine: this.engine, hint: 'call perch_start first' };
    this._touch();
    const cfNow = await isCfBlocked(this.page);
    const pageState = await evalMain(this.page, () => {
      let syntaxErrors = null;
      try { syntaxErrors = window.getEditorSyntaxErrors ? window.getEditorSyntaxErrors() : null; } catch (e) {}
      return {
        saveState: window.perchanceSaveState || null,
        syntaxErrors,
        collabSynced: !!(window.yjsProvider && window.yjsProvider.synced),
        cmEditors: document.querySelectorAll('.cm-editor').length,
        hasModelView: !!window.modelTextEditor,
        hasOutputView: !!window.outputTemplateEditor,
        modelLines: window.modelTextEditor ? window.modelTextEditor.state.doc.toString().split('\n').length : null,
        outputLines: window.outputTemplateEditor ? window.outputTemplateEditor.state.doc.toString().split('\n').length : null,
      };
    }).catch(() => ({}));
    const result = {
      ok: true, running: true, generator: this.generator, collabKey: this.collabKey,
      headed: this.headed, engine: this.engine,
      effectiveEngine: this.effectiveEngine || this.engine,
      consoleBuffered: this.diag.console.length, errorsBuffered: this.diag.errors.length,
      ...pageState,
    };
    if (cfNow) {
      result.cfBlocked = true;
      result.warning = 'Cloudflare challenge is blocking the page. Call perch_start again (it escalates automatically).';
    }
    // The preview is the surface every perch_eval/perch_click against the running generator uses,
    // and it can be dead while the editor is fine — report its health on every status call.
    try { result.preview = await this.previewHealth(); } catch (e) {}
    return result;
  }

  // ---------------- browser-free code access ----------------
  _curlJson(url, body) {
    const { execFileSync } = require('child_process');
    const out = execFileSync('curl', [
      '-s', '-X', 'POST', url,
      '-H', 'Content-Type: application/json',
      '-H', 'Origin: https://perchance.org',
      '-H', 'Referer: https://perchance.org/' + (this.generator || ''),
      '-A', UA, '-d', body,
    ], { timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
    return JSON.parse(out);
  }
  _curlText(url) {
    const { execFileSync } = require('child_process');
    return execFileSync('curl', ['-s', '-A', UA, url],
      { timeout: 60000, maxBuffer: 256 * 1024 * 1024 }).toString();
  }

  // Fetch the raw generator payload (modelText + outputTemplate + srcManifest)
  // via the public API. NO browser, NO Cloudflare risk, ~1-2s.
  apiData({ name = null } = {}) {
    const gen = name || this.generator;
    if (!gen) throw new Error('no generator — pass name or call perch_start first');
    const data = this._curlJson('https://perchance.org/api/getGeneratorPageData',
      JSON.stringify({ generatorName: gen }));
    return (data && data.generator) || {};
  }

  // Write the authoritative source to local files for instant ripgrep/reading.
  pull({ name = null, dir = null } = {}) {
    const t0 = Date.now();
    const g = this.apiData({ name });
    const gen = name || this.generator;
    const out = dir || path.join(MIRROR_ROOT, gen);
    fs.mkdirSync(out, { recursive: true });
    const model = g.modelText || '';
    const html = g.outputTemplate || '';
    const modelPath = path.join(out, 'main.pjs');
    const htmlPath = path.join(out, 'index.html');
    fs.writeFileSync(modelPath, model, 'utf8');
    fs.writeFileSync(htmlPath, html, 'utf8');
    return {
      ok: true, generator: gen, dir: out, ms: Date.now() - t0,
      model: { path: modelPath, bytes: Buffer.byteLength(model), lines: model.split('\n').length },
      html: { path: htmlPath, bytes: Buffer.byteLength(html), lines: html.split('\n').length },
      srcManifestKeys: Object.keys(g.srcManifest || {}).length,
      hint: 'Grep/read these local files directly — no browser round-trip needed.',
    };
  }

  // ---------------- pane access (live editor) ----------------
  async read({ pane = 'output', offset = 1, limit = 2000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    return await evalMain(this.page, ({ pane, offset, limit }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'editor view not ready' };
      const all = v.state.doc.toString().split('\n');
      const slice = all.slice(offset - 1, offset - 1 + limit);
      return { ok: true, pane, totalLines: all.length, lines: slice.map((l, i) => `${offset + i}|${l}`) };
    }, { pane, offset, limit });
  }

  async grep({ pattern, pane = null, contextLines = 0, limit = 200 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    return await evalMain(this.page, ({ pattern, pane, contextLines, limit }) => {
      let re;
      try { re = new RegExp(pattern, 'gi'); } catch (e) { return { ok: false, error: 'bad regex: ' + e.message }; }
      const readOne = p => {
        const v = p === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
        return v ? v.state.doc.toString() : null;
      };
      const panes = pane ? [pane] : ['model', 'output'];
      const matches = [];
      let total = 0;
      for (const p of panes) {
        const text = readOne(p);
        if (text == null) continue;
        const lines = text.split('\n');
        lines.forEach((l, i) => {
          re.lastIndex = 0;
          if (!re.test(l)) return;
          total++;
          if (matches.length >= limit) return;
          const entry = { pane: p, line: i + 1, text: l.length > 400 ? l.slice(0, 400) + '…' : l };
          if (contextLines > 0) entry.context = lines.slice(Math.max(0, i - contextLines), i + contextLines + 1);
          matches.push(entry);
        });
      }
      return { ok: true, count: total, returned: matches.length, matches };
    }, { pattern, pane, contextLines, limit });
  }

  async edit({ pane = 'output', oldString, newString, replaceAll = false, settle = true, nth = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const res = await evalMain(this.page, ({ pane, oldString, newString, replaceAll, nth }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      if (v.state.doc.length === 0)
        return { ok: false, error: 'docs not ready (empty doc) — call perch_start again' };
      const doc = v.state.doc.toString();
      if (oldString.length === 0) return { ok: false, error: 'empty oldString' };
      const changes = []; let from = 0, count = 0, seen = 0;
      while (true) {
        const idx = doc.indexOf(oldString, from);
        if (idx === -1) break;
        seen++;
        if (nth == null || seen === nth) {
          changes.push({ from: idx, to: idx + oldString.length, insert: newString });
          count++;
          if (!replaceAll && nth == null) break;
        }
        from = idx + oldString.length;
      }
      if (count === 0)
        return { ok: false, error: nth != null ? `occurrence #${nth} not found (${seen} total)` : 'oldString not found', occurrences: seen };
      v.dispatch({ changes, userEvent: 'input.delete' });
      return { ok: true, replacements: count, occurrences: seen };
    }, { pane, oldString, newString, replaceAll, nth });
    if (res && res.ok && settle !== false) await this.settle();
    return res;
  }

  async write({ pane = 'output', content, settle = true } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const res = await evalMain(this.page, ({ pane, content }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content }, userEvent: 'input' });
      return { ok: true, chars: content.length };
    }, { pane, content });
    if (res && res.ok && settle !== false) await this.settle();
    return res;
  }

  // write_file: same dispatch as write(), but the content is read from a LOCAL file in this
  // server process. Exists because the large-document path has two hard walls write() hits:
  // a 2.6 MB outputTemplate does not fit through one MCP tool call, and fetching it from the
  // editor page is dead (perchance.org's CSP allows no connect-src to localhost). Byte-exact:
  // the file never passes through the conversation or the page's network stack.
  async writeFile({ pane = 'output', filePath, settle = true } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    if (!filePath) throw new Error('filePath is required');
    this._touch();
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return { ok: false, error: 'read failed: ' + String((e && e.message) || e), filePath };
    }
    const res = await evalMain(this.page, ({ pane, content }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      const before = v.state.doc.length;
      v.dispatch({ changes: { from: 0, to: before, insert: content }, userEvent: 'input' });
      return { ok: true, chars: content.length, lines: content.split('\n').length, before };
    }, { pane, content });
    if (res && res.ok && settle !== false) await this.settle();
    return Object.assign({ filePath, bytes: Buffer.byteLength(content, 'utf8') }, res || { ok: false, error: 'dispatch failed' });
  }

  async patch({ changes = [], settle = true } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const results = [];
    for (const c of changes) results.push(await this.edit({ ...c, settle: false }));
    if (settle !== false) await this.settle();
    const failed = results.filter(r => !r.ok).length;
    return { ok: failed === 0, applied: results.length - failed, failed, results };
  }

  async outline({ pane = 'output', limit = 400 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    return await evalMain(this.page, ({ pane, limit }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'editor view not ready' };
      const re = /^\s*(?:export\s+)?(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
      const lines = v.state.doc.toString().split('\n');
      const entries = [];
      lines.forEach((l, i) => {
        const m = l.match(re);
        if (m) entries.push({ line: i + 1, kind: m[1], name: m[2] });
      });
      return { ok: true, pane, count: entries.length, entries: entries.slice(0, limit) };
    }, { pane, limit });
  }

  async copyLines({ fromPane = 'output', startLine, endLine, toPane = null, afterLine = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const dest = toPane || fromPane;
    const fromDoc = await evalMain(this.page, p => {
      const v = p === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      return v ? v.state.doc.toString() : null;
    }, fromPane);
    if (fromDoc == null) return { ok: false, error: 'source pane not ready' };
    const fromLines = fromDoc.split('\n');
    const end = endLine || startLine;
    if (!startLine || startLine < 1 || end > fromLines.length)
      return { ok: false, error: 'line range out of bounds', totalLines: fromLines.length };
    const copied = fromLines.slice(startLine - 1, end);
    const toDoc = await evalMain(this.page, p => {
      const v = p === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      return v ? v.state.doc.toString() : null;
    }, dest);
    if (toDoc == null) return { ok: false, error: 'dest pane not ready' };
    const toLines = toDoc.split('\n');
    const after = afterLine == null ? toLines.length : afterLine;
    if (after < 0 || after > toLines.length) return { ok: false, error: 'afterLine out of bounds' };
    const newDoc = toLines.slice(0, after).concat(copied, toLines.slice(after)).join('\n');
    const res = await evalMain(this.page, ({ pane, content }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content }, userEvent: 'input' });
      return { ok: true };
    }, { pane: dest, content: newDoc });
    if (res && res.ok) await this.settle();
    return { ok: true, copied: copied.length, after, result: res };
  }

  // ---------------- preview: eval / refresh / console ----------------
  async eval({ js, frame = 'preview' } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const fr = await this._frame(frame);
    try {
      const res = await evalMain(fr, js);
      return { ok: true, frame, result: res };
    } catch (e) {
      return { ok: false, frame, error: String((e && e.message) || e).slice(0, 300) };
    }
  }

  async refresh() {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const before = this.diag.console.length;
    {
      const fr = await this._frame('preview').catch(() => null);
      if (fr) await evalMain(fr, () => { window.__perchReloadFlag = true; }).catch(() => {});
    }
    await evalMain(this.page, () => {
      try { if (window.hardReloadOutputIframe) window.hardReloadOutputIframe(); } catch (e) {}
    });
    const t0 = Date.now();
    let loaded = false;
    while (Date.now() - t0 < 25000) {
      const fr = await this._frame('preview').catch(() => null);
      if (fr) {
        const st = await evalMain(fr, () => ({ flag: !!window.__perchReloadFlag, rs: document.readyState }))
          .catch(() => null);
        if (st && !st.flag && st.rs === 'complete') { loaded = true; break; }
      }
      await this.page.waitForTimeout(400);
    }
    await this.page.waitForTimeout(700);
    const syntaxErrors = await evalMain(this.page, () => {
      try { return window.getEditorSyntaxErrors ? window.getEditorSyntaxErrors() : null; } catch (e) { return null; }
    }).catch(() => null);
    return {
      ok: true, previewLoaded: loaded, syntaxErrors,
      runtimeErrors: this.diag.errors.slice(-30),
      newConsoleLines: this.diag.console.slice(before).slice(-40),
      panel: await this._readConsole(),
    };
  }

  async console({ clear = false } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const out = {
      ok: true,
      panel: (await this._readConsole()).slice(-6000),
      buffered: this.diag.console.slice(-80),
      runtimeErrors: this.diag.errors.slice(-40),
    };
    if (clear) this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    return out;
  }

  async _readConsole() {
    for (const f of this.page.frames()) {
      if (f === this.page.mainFrame()) continue;
      try {
        if (f.name() === 'console-output')
          return await evalMain(f, () => document.body ? (document.body.innerText || document.body.textContent || '') : '');
      } catch {}
    }
    try {
      return await this.page.$eval('#console-output', el =>
        (el.contentDocument && el.contentDocument.body) ? (el.contentDocument.body.innerText || '') : '');
    } catch { return ''; }
  }

  // ---------------- UI testing (text-first) ----------------
  // List interactive elements in the live preview so an agent can drive the UI
  // without a screenshot. Each entry carries a CSS selector for perch_click.
  async snapshot({ frame = 'preview', limit = 250, filter = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const fr = await this._frame(frame);
    // NOTE: the callback below is serialized and runs IN THE BROWSER — only
    // the argument object is in scope there, so nothing outer may be closed
    // over (v3 first cut returned the outer `frame` here and threw).
    const out = await evalMain(fr, ({ limit, filter }) => {
      const cssPath = (el) => {
        if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
        const parts = [];
        let cur = el;
        for (let d = 0; cur && cur.nodeType === 1 && d < 4; d++) {
          if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
          let sel = cur.tagName.toLowerCase();
          const cls = (cur.className || '').toString().trim().split(/\s+/)
            .filter(c => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
          if (cls.length) sel += '.' + cls.join('.');
          const sibs = cur.parentNode ? [...cur.parentNode.children].filter(s => s.tagName === cur.tagName) : [];
          if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
          parts.unshift(sel);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      };
      const sel = 'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="tab"], [role="menuitem"]';
      const all = [...document.querySelectorAll(sel)];
      const out = [];
      for (const el of all) {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' &&
          style.display !== 'none' && style.opacity !== '0';
        if (!visible) continue;
        const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value ||
          (el.innerText || el.textContent || '').trim() || el.getAttribute('title') || '')
          .replace(/\s+/g, ' ').slice(0, 80);
        if (filter && !(label + ' ' + el.tagName).toLowerCase().includes(filter.toLowerCase())) continue;
        out.push({
          tag: el.tagName.toLowerCase(), label,
          type: el.getAttribute('type') || undefined,
          id: el.id || undefined, disabled: el.disabled || undefined,
          selector: cssPath(el),
        });
        if (out.length >= limit) break;
      }
      return { ok: true, count: out.length, visibleCandidates: all.length, elements: out };
    }, { limit, filter });
    return { frame, ...out };
  }

  async wait({ selector = null, text = null, gone = false, frame = 'preview', timeout = 15000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const fr = await this._frame(frame);
    const t0 = Date.now();
    try {
      if (selector && selector.startsWith('text=')) { text = selector.slice(5); selector = null; }
      if (text != null) {
        const loc = fr.getByText(text, { exact: false }).first();
        await loc.waitFor({ state: gone ? 'detached' : 'visible', timeout });
      } else if (selector) {
        const loc = fr.locator(selector).first();
        await loc.waitFor({ state: gone ? 'detached' : 'visible', timeout });
      } else {
        await this.page.waitForTimeout(Math.min(timeout, 10000));
      }
      return { ok: true, waitedMs: Date.now() - t0, selector, text, gone };
    } catch (e) {
      return { ok: false, waitedMs: Date.now() - t0, error: String((e && e.message) || e).slice(0, 200), selector, text, gone };
    }
  }

  async click({ selector, frame = 'preview', timeout = 10000, nth = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!selector) throw new Error('missing selector');
    const fr = await this._frame(frame);
    const loc = selector.startsWith('text=')
      ? fr.getByText(selector.slice(5), { exact: false })
      : fr.locator(selector);
    const target = nth != null ? loc.nth(nth) : loc.first();
    try {
      await target.click({ timeout });
      return { ok: true, clicked: selector, frame, matches: await loc.count().catch(() => null) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200), matches: await loc.count().catch(() => 0) };
    }
  }

  async type({ selector, text, frame = 'preview', timeout = 10000, submit = false } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!selector) throw new Error('missing selector');
    const fr = await this._frame(frame);
    const loc = selector.startsWith('text=')
      ? fr.getByText(selector.slice(5), { exact: false }).first()
      : fr.locator(selector).first();
    try {
      await loc.fill(text, { timeout });
    } catch {
      await loc.click({ timeout });
      await loc.pressSequentially(text, { delay: 20 });
    }
    if (submit) await loc.press('Enter');
    return { ok: true, typed: text.length, frame, submitted: !!submit };
  }

  async press({ key, frame = 'editor' } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!key) throw new Error('missing key');
    // Keyboard lives on the page (frames have no .keyboard in this build).
    await this.page.keyboard.press(key);
    return { ok: true, pressed: key, frame };
  }

  async setViewport({ width = 1500, height = 950 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    await this.page.setViewportSize({ width, height });
    const rect = await evalMain(this.page, () => {
      const f = document.getElementById('outputIframeEl');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return { ok: true, viewport: { width, height }, iframe: rect };
  }

  async shot({ what = 'editor', path: p } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const out = p || path.join(__dirname, 'perch_shot.png');
    if (what === 'preview') {
      const el = await this.page.$('#outputIframeEl');
      if (el) await el.screenshot({ path: out });
      else {
        const frame = await this._frame('preview');
        if (typeof frame.screenshot === 'function') await frame.screenshot({ path: out });
        else throw new Error('cannot screenshot preview');
      }
    } else {
      await this.page.screenshot({ path: out, fullPage: false });
    }
    return { ok: true, what, path: out };
  }

  // ---------------- src/ access (via curl, passes CF) ----------------
  async _getManifest() {
    const data = this._curlJson('https://perchance.org/api/getGeneratorPageData',
      JSON.stringify({ generatorName: this.generator }));
    return (data.generator && data.generator.srcManifest) || {};
  }
  async src(p) {
    const manifest = await this._getManifest();
    const key = manifest[p] && manifest[p].key;
    if (!key) return { ok: false, error: 'src path not in manifest: ' + p, available: Object.keys(manifest) };
    const text = this._curlText('https://user.uploads.dev/file/' + key);
    return { ok: true, path: p, size: text.length, text: text.slice(0, 120000) };
  }
  async listSrc() {
    const manifest = await this._getManifest();
    const entries = Object.entries(manifest).map(([p, v]) => ({ path: p, size: v.size }));
    return { ok: true, count: entries.length, entries };
  }
  async fetchGenerator({ name, path: p } = {}) {
    if (!name) throw new Error('missing generator name');
    return this.pull({ name, dir: p ? path.dirname(p) : null });
  }

  // ---------------- top-level navigation (CF / preview recovery) ----------------
  // Navigates the whole editor PAGE (not just the preview iframe). Two uses:
  //  - recovering a session whose editor page got CF-challenged;
  //  - the subdomain-clearance recipe: a CF interstitial can never render
  //    inside an iframe, so a blocked embed (e.g. text-generation.perchance.org
  //    inside the ai-text-plugin) is cleared by visiting that URL top-level
  //    once, waiting out the challenge, then perch_start(force:true).
  async navigate({ url, timeout = 30000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!/^https:\/\//.test(url || '')) return { ok: false, error: 'only https:// URLs are allowed' };
    const t0 = Date.now();
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 60000) })
      .catch(e => ({ gotoError: String((e && e.message) || e).slice(0, 200) }));
    // Wait out a possible Cloudflare interstitial (auto-clearing JS challenge).
    let cf = true;
    while (Date.now() - t0 < timeout) {
      cf = await isCfBlocked(this.page);
      if (!cf) break;
      await this.page.waitForTimeout(1500);
    }
    const info = await evalMain(this.page, () => ({ url: location.href, title: document.title }))
      .catch(() => ({ url: null, title: null }));
    this.ready = false; // editor views are gone after leaving the editor page
    return {
      ok: !cf, cfBlocked: cf, elapsedMs: Date.now() - t0, ...info,
      note: cf ? 'challenge did not clear — retry, or open the URL once in a real browser'
               : 'navigated; call perch_start(force:true) to return to the editor',
    };
  }

  // ---------------- src/ upload + delete (proven against the live editor) ----------------
  // Uploads a file into the generator's src/ through the editor's file panel.
  // The src-tree uploader is <input data-ref="fileInput"> inside #aiAgentPanelEl;
  // #aiAgentFileInputEl is the AI-helper CHAT attachment input — do not confuse
  // them (attaching there does NOT create a src file).
  //
  // Names may carry virtual folders ('emoji/icon.svg'): the src store is a flat
  // string-keyed manifest, the tree groups '/' keys into folders, and the
  // editor's upload handler keeps the full path.
  // Re-uploading an existing path never overwrites: the editor RENAMES the
  // incoming file (name-2.ext) behind a modal notice. overwrite:true runs the
  // delete flow first — a staged delete clears the collision check, so the
  // re-upload lands on the exact same key (probed live).
  _validSrcName(name) {
    if (typeof name !== 'string' || !name.trim().length) return 'name is required';
    if (name !== name.trim()) return 'no leading/trailing whitespace';
    if (name.includes('\\')) return "use forward slashes: 'emoji/icon.svg'";
    if (name.startsWith('/') || name.endsWith('/')) return 'no leading/trailing slash';
    if (name.includes('//')) return 'empty path segment';
    const segs = name.split('/');
    if (segs.length > 8) return 'max 8 path segments';
    for (const seg of segs) {
      if (seg === '.' || seg === '..') return "dot segments are not allowed: '" + seg + "'";
      if (!/^[\w][\w .()-]{0,127}$/.test(seg)) return "segment '" + seg + "' may only hold letters/digits/_ . - ( ) and spaces, starting with a letter, digit or _";
      if (/[ .]$/.test(seg)) return "segment '" + seg + "' may not end with a space or dot";
    }
    if (name.length > 240) return 'path too long (max 240 chars)';
    return null;
  }

  async _ensureFilesPanel(ed) {
    // The helper chat view also contains the word "upload" (its 📤 button), so
    // check for the files view's actual markup instead: the src file input only
    // exists when the file tree is showing.
    const inputVisible = () => evalMain(ed, () => {
      const p = document.querySelector('#aiAgentPanelEl');
      return !!(p && p.querySelector('input[data-ref="fileInput"]'));
    }).catch(() => false);
    if (await inputVisible()) return true;
    try {
      await ed.locator('text=🗂 files').first().click({ timeout: 5000 });
    } catch { return false; }
    await this.page.waitForTimeout(700);
    return inputVisible();
  }

  _curlBuffer(url) {
    const { execFileSync } = require('child_process');
    return execFileSync('curl', ['-s', '-L', '-A', UA, url],
      { timeout: 120000, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' });
  }

  // Resolve the upload source to exactly one of: inline content (small text only
  // — it transits the calling model's context), an absolute local filePath (read
  // server-side, byte-exact, nothing transits), or a https url (fetched
  // server-side). Binary-vs-text is decided by CONTENT (NUL-byte + strict-UTF-8
  // sniff) unless the caller forces `binary` — an extension whitelist would
  // send unknown binary types (.onnx, .safetensors, custom blobs) down the text
  // path, which UTF-8-expands their bytes (~1.77x) and corrupts them.
  _looksTextual(buf) {
    // Mirrors the editor's own looksLikeText() (srcFiles.js): a NUL byte in the
    // first 4KiB means binary; plus a strict UTF-8 decode of the WHOLE buffer —
    // any invalid sequence means binary. Text that survives both round-trips
    // losslessly either way, so a false 'textual' is harmless, while a false
    // 'binary' is not — which is why an extension list is not used here.
    if (buf.subarray(0, 4096).includes(0)) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; }
    catch (e) { return false; }
  }

  _readUploadSource({ content, filePath, url, binary }) {
    // content counts only when non-empty: the caller's cached tool schema may
    // still require a `content` argument, so `content: ""` + filePath/url is the
    // supported way to use a server-side source through an old client schema
    const given = [!!content, !!filePath, !!url].filter(Boolean).length;
    if (given === 0) return { error: 'one of content, filePath or url is required' };
    if (given > 1) return { error: 'pass only ONE of content, filePath or url' };
    // sha256 of the exact bytes being sent, plus sha256 of what the editor's
    // UTF-8 text fallback would store — uploadSrc uses these to classify a
    // landed upload as intact ('match') vs utf8-mangled (binary corrupted by
    // a UTF-8 text round-trip)
    const { createHash } = require('crypto');
    const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
    const mangledSha256 = (buf) => createHash('sha256').update(buf.toString('utf8'), 'utf8').digest('hex');
    let ext = '';
    if (filePath) {
      if (typeof filePath !== 'string' || !(/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('/'))) {
        return { error: 'filePath must be an ABSOLUTE path (the server process has no reliable working directory), e.g. C:/Users/you/Workspace/app/src/emoji/x.svg' };
      }
      const fs = require('fs');
      if (!fs.existsSync(filePath)) return { error: 'filePath does not exist: ' + filePath };
      ext = (filePath.split('.').pop() || '').toLowerCase();
      const buf = fs.readFileSync(filePath);
      const isBinary = binary != null ? !!binary : !this._looksTextual(buf);
      if (isBinary) return { base64: buf.toString('base64'), bytes: buf.length, ext, source: 'file', sha256: sha256(buf), mangledSha256: mangledSha256(buf) };
      return { text: buf.toString('utf8'), bytes: buf.length, ext, source: 'file', sha256: sha256(buf), mangledSha256: mangledSha256(buf) };
    }
    if (url) {
      if (!/^https?:\/\//i.test(url)) return { error: 'url must start with http(s)://' };
      try { ext = (new URL(url)).pathname.split('.').pop().toLowerCase(); } catch { ext = ''; }
      let buf;
      try { buf = this._curlBuffer(url); } catch (e) { return { error: 'url fetch failed: ' + e.message }; }
      if (!buf || !buf.length) return { error: 'url fetch returned an empty body: ' + url };
      const isBinary = binary != null ? !!binary : !this._looksTextual(buf);
      if (isBinary) return { base64: buf.toString('base64'), bytes: buf.length, ext, source: 'url', sha256: sha256(buf), mangledSha256: mangledSha256(buf) };
      return { text: buf.toString('utf8'), bytes: buf.length, ext, source: 'url', sha256: sha256(buf), mangledSha256: mangledSha256(buf) };
    }
    const text = String(content);
    const cbuf = Buffer.from(text, 'utf8');
    return { text, bytes: cbuf.length, ext: '', source: 'content', sha256: sha256(cbuf), mangledSha256: mangledSha256(cbuf) };
  }

  // Shared row-menu delete flow. Row matching is TEXT-anchored (the ⋯ button whose
  // small row contains the file name): published tree rows carry no span[title]
  // and their name spans include the 📄 prefix, so title/exact-text lookups miss
  // them. Returns {existed, deleted?, error?} — existed:false means no such row.
  async _deleteSrcRow(ed, path, { timeout = 20000 } = {}) {
    const findRow = (fnName) => evalMain(ed, ({ path }) => {
      const panel = document.querySelector('#aiAgentPanelEl');
      if (!panel) return { ok: false, error: 'files panel not found' };
      const fname = path.split('/').pop();
      // Anchor on the unique NAME LEAF (shortest childless element containing
      // the basename) and climb to its own row button. Matching any <160-char
      // ancestor container instead can select a SIBLING row's button when
      // several files share one container — this deleted the wrong file once.
      const leaves = [...panel.querySelectorAll('*')].filter(el =>
        el.childElementCount === 0 && (el.textContent || '').indexOf(fname) !== -1 && (el.textContent || '').length < 80);
      for (const nameEl of leaves.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)) {
        let n = nameEl;
        while (n && n !== panel) {
          if ([...n.querySelectorAll('button')].some(b => (b.title || '').indexOf('download / rename / delete') !== -1)) {
            return { ok: true, found: true };
          }
          n = n.parentElement;
        }
      }
      // not rendered: expand the first folder segment if the path has one
      const segs = path.split('/');
      if (segs.length > 1) {
        const folderSpan = [...panel.querySelectorAll('span')].find(el => (el.textContent || '').trim() === '▸ 📁 ' + segs[0]);
        if (folderSpan) { (folderSpan.closest('div') || folderSpan).click(); return { ok: true, found: false, expanded: true }; }
      }
      return { ok: true, found: false };
    }, { path }).catch(e => ({ ok: false, error: String(e && e.message || e) }));
    let probe = await findRow(path);
    if (!probe.ok) return { existed: false, error: probe.error };
    if (!probe.found) {
      if (probe.expanded) await this.page.waitForTimeout(900);
      probe = await findRow(path);
      if (!probe.ok) return { existed: false, error: probe.error };
      if (!probe.found) return { existed: false };
    }
    // open the row's ⋯ menu (name-leaf anchored — see findRow above)
    const menu = await evalMain(ed, ({ path }) => {
      const panel = document.querySelector('#aiAgentPanelEl');
      const fname = path.split('/').pop();
      const leaves = [...panel.querySelectorAll('*')].filter(el =>
        el.childElementCount === 0 && (el.textContent || '').indexOf(fname) !== -1 && (el.textContent || '').length < 80);
      for (const nameEl of leaves.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)) {
        let n = nameEl;
        while (n && n !== panel) {
          const btn = [...n.querySelectorAll('button')].find(b => (b.title || '').indexOf('download / rename / delete') !== -1);
          if (btn) { btn.click(); return { ok: true }; }
          n = n.parentElement;
        }
      }
      return { ok: false, error: 'row menu button (⋯) not found' };
    }, { path });
    if (!menu.ok) return { existed: true, error: menu.error };
    await this.page.waitForTimeout(700);
    // the menu is a document-level popup: childless div, exact "🗑️ delete".
    // Firefox needs a REAL pointer click on the item — the synthetic
    // el.click() closes the menu without triggering its handler (observed:
    // the confirm modal never appears), while playwright's click works.
    try {
      await ed.click('text=🗑️ delete', { timeout: 5000 });
    } catch (e) {
      return { existed: true, error: 'delete item not clickable (menu closed?)' };
    }
    await this.page.waitForTimeout(700);
    // confirm modal inside the panel ("Delete src/…?"), ok is its last button
    const confirm = await evalMain(ed, () => {
      const panel = document.querySelector('#aiAgentPanelEl');
      const overlays = [...panel.querySelectorAll('div')].filter(d => {
        const s = d.style || {};
        return s.position === 'absolute' && d.offsetParent !== null && (d.innerText || '').length > 0 && (d.innerText || '').length < 400;
      });
      const ov = overlays[overlays.length - 1];
      if (!ov || (ov.innerText || '').indexOf('Delete') === -1) return { ok: false, error: 'confirm modal not found' };
      const btns = [...ov.querySelectorAll('button')];
      const okBtn = btns.find(b => /^ok$/i.test((b.textContent || '').trim())) || btns[btns.length - 1];
      if (!okBtn) return { ok: false, error: 'confirm button not found' };
      okBtn.click();
      return { ok: true };
    });
    if (!confirm.ok) return { existed: true, error: confirm.error };
    // the staged delete removes the row at once — verify it is gone
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const gone = await evalMain(ed, ({ path }) => {
        const panel = document.querySelector('#aiAgentPanelEl');
        if (!panel) return { gone: false };
        const fname = path.split('/').pop();
        // gone = no name leaf whose row still carries a ⋯ button (a transient
        // status line mentioning the file must not block the check)
        const leaves = [...panel.querySelectorAll('*')].filter(el =>
          el.childElementCount === 0 && (el.textContent || '').indexOf(fname) !== -1 && (el.textContent || '').length < 80);
        for (const nameEl of leaves) {
          let n = nameEl;
          while (n && n !== panel) {
            if ([...n.querySelectorAll('button')].some(b => (b.title || '').indexOf('download / rename / delete') !== -1)) return { gone: false };
            n = n.parentElement;
          }
        }
        return { gone: true };
      }, { path }).catch(() => null);
      if (gone && gone.gone) return { existed: true, deleted: true };
      await this.page.waitForTimeout(800);
    }
    return { existed: true, deleted: false, error: 'row still present after confirm (check the editor and retry)' };
  }

  async deleteSrc({ path, timeout = 20000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const bad = this._validSrcName(path);
    if (bad) return { ok: false, error: bad };
    const ed = await this._frame('editor');
    if (!(await this._ensureFilesPanel(ed))) return { ok: false, error: 'could not open the files panel' };
    const r = await this._deleteSrcRow(ed, path, { timeout });
    if (!r.existed) return { ok: false, error: 'src path not in the file tree: ' + path };
    // store-level confirmation: the tree row can vanish while the room-synced
    // store still lists the path (or lists a {deleted:true} tombstone, which
    // counts as deleted). The registry settles a beat after the row disappears,
    // so poll briefly. null = store not observable (older editor build).
    let storeConfirmed = null;
    const scT0 = Date.now();
    while (Date.now() - scT0 < 6000) {
      const st = await evalMain(ed, ({ path }) => {
        const w = window.srcState && window.srcState._internals && window.srcState._internals.working;
        const e = w ? w[path] : null;
        // tombstones ({deleted:true}) live in the room registry YMap
        let y = null;
        try {
          const share = window.yjsProvider && window.yjsProvider.doc && window.yjsProvider.doc.share;
          const m = share && share.get && share.get('___pendingSrc___');
          if (m && m.get) y = m.get(path) || null;
        } catch (err) { /* older editor without the registry */ }
        if (!e && !y) return { present: false };
        return { present: true, deleted: !!((y && y.deleted) || (e && e.deleted)) };
      }, { path }).catch(() => null);
      if (st) {
        storeConfirmed = !st.present || st.deleted === true;
        if (storeConfirmed) break;
      }
      await this.page.waitForTimeout(800);
    }
    const deleted = !!r.deleted && storeConfirmed !== false;
    return {
      ok: deleted,
      deleted: !!r.deleted,
      storeConfirmed,
      path,
      error: r.error || (!r.deleted ? undefined
        : (storeConfirmed === false ? 'row removed from the tree but the editor src store still lists this path — re-check or retry' : undefined)),
      hint: deleted ? 'staged in the editor store; visitors see it once the generator owner saves' : undefined,
    };
  }

  async uploadSrc({ name, content, filePath, url, binary, timeout = 25000, overwrite = false } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const bad = this._validSrcName(name);
    if (bad) return { ok: false, error: bad };
    const src = this._readUploadSource({ content, filePath, url, binary });
    if (src.error) return { ok: false, error: src.error };
    if (src.bytes > 64 * 1024 * 1024) return { ok: false, error: 'file too large for the panel uploader (>64MB): ' + src.bytes + ' bytes' };
    const ed = await this._frame('editor');
    if (!(await this._ensureFilesPanel(ed))) return { ok: false, error: 'could not open the files panel' };
    // Baseline BEFORE any delete/write: what the room currently holds for this
    // name. The wait loop below ignores entries matching this baseline — a fresh
    // tab still sees the PREVIOUS session's published entry (old hash) until this
    // tab's own publish lands, and a same-bytes re-upload keeps the hash and only
    // bumps the rev, so either alone would misclassify the landing.
    const readStoreEntry = () => evalMain(ed, ({ name }) => {
      try {
        const w = window.srcState && window.srcState._internals && window.srcState._internals.working;
        const e = w ? w[name] : null;
        let y = null;
        try {
          const share = window.yjsProvider && window.yjsProvider.doc && window.yjsProvider.doc.share;
          const m = share && share.get && share.get('___pendingSrc___');
          if (m && m.get) y = m.get(name) || null;
        } catch (err2) { /* older editor without the registry */ }
        const entry = y || e;
        if (!entry) return null;
        return {
          deleted: !!(entry.deleted || (e && e.deleted)),
          size: (entry.size !== undefined ? entry.size : (e ? e.size : null)),
          hash: (y && y.hash) || null,
          rev: entry.rev || null,
        };
      } catch (err) { return null; }
    }, { name }).catch(() => null);
    const baseline = await readStoreEntry();
    // Overwrite = delete the existing entry first (see the header comment).
    let overwrote = false;
    if (overwrite) {
      const del = await this._deleteSrcRow(ed, name);
      if (del.existed && !del.deleted) {
        return { ok: false, error: 'could not delete the existing file before overwrite' + (del.error ? ': ' + del.error : '') };
      }
      overwrote = !!del.existed;
    }
    // inject the file via DataTransfer (callback runs IN THE BROWSER); binary
    // arrives base64-encoded and is decoded to real bytes page-side
    const r = await evalMain(ed, ({ name, content, base64 }) => {
      const input = document.querySelector('#aiAgentPanelEl input[data-ref="fileInput"]');
      if (!input) return { ok: false, error: 'src file input not found — open the files panel first' };
      const ext = (name.split('.').pop() || '').toLowerCase();
      const mime = { md: 'text/markdown', txt: 'text/plain', js: 'text/javascript', mjs: 'text/javascript',
        json: 'application/json', html: 'text/html', css: 'text/css', svg: 'image/svg+xml',
        xml: 'application/xml', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
        woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
        zip: 'application/zip', pdf: 'application/pdf', wasm: 'application/wasm' }[ext] || (base64 ? 'application/octet-stream' : 'text/plain');
      let payload = content;
      if (base64) {
        const bin = atob(content);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        payload = u8;
      }
      const dt = new DataTransfer();
      dt.items.add(new File([payload], name, { type: mime }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }, { name, content: src.base64 || src.text, base64: !!src.base64 });
    if (!r.ok) return r;
    // Wait for the upload to land. The panel's innerText "saved" marker is
    // NOT authoritative: folder-path rows render the basename only (the full
    // path never appears in the text), and a fresh tab can show the previous
    // session's state. Authoritative signal: the room-synced store entry —
    // window.srcState._internals.working[name] plus the sha256-carrying
    // ___pendingSrc___ registry entry — REFRESHED relative to the baseline.
    const t0 = Date.now();
    let saved = false;
    let renamedTo = null;
    let storeInfo = null;
    let savedAt = 0;
    while (Date.now() - t0 < timeout) {
      const state = await evalMain(ed, ({ name }) => {
        const panel = document.querySelector('#aiAgentPanelEl');
        const txt = panel ? (panel.innerText || '') : '';
        let renamed = null;
        const overlays = [...panel.querySelectorAll('div')].filter(d => {
          const s = d.style || {};
          return s.position === 'absolute' && d.offsetParent !== null && (d.innerText || '').indexOf('were renamed') !== -1;
        });
        const ov = overlays[overlays.length - 1];
        if (ov) {
          const m = (ov.innerText || '').match(/([\w./-]+)\s+→\s+([\w./-]+)/);
          if (m) renamed = m[2];
          const okBtn = [...ov.querySelectorAll('button')].pop();
          if (okBtn) okBtn.click(); // dismiss so later calls are not blocked
        }
        let store = null;
        try {
          const w = window.srcState && window.srcState._internals && window.srcState._internals.working;
          const e = w ? w[name] : null;
          // the sha256 lives in the room registry YMap, not in working[]
          let y = null;
          try {
            const share = window.yjsProvider && window.yjsProvider.doc && window.yjsProvider.doc.share;
            const m = share && share.get && share.get('___pendingSrc___');
            if (m && m.get) y = m.get(name) || null;
          } catch (err2) { /* older editor without the registry */ }
          const entry = y || e;
          if (entry) store = {
            deleted: !!(entry.deleted || (e && e.deleted)),
            committed: !!(y && y.committed),
            size: (entry.size !== undefined ? entry.size : (e ? e.size : null)),
            hash: (y && y.hash) || null,
            rev: entry.rev || null,
          };
        } catch (err) { /* best-effort probe */ }
        return { txt, renamed, store };
      }, { name }).catch(() => null);
      if (state && state.renamed) { renamedTo = state.renamed; break; }
      if (state && state.store && !state.store.deleted) {
        // fresh = differs from the pre-upload baseline (rev preferred — a
        // same-bytes re-upload keeps the hash but bumps the rev; hash fallback
        // for builds whose entries carry no rev; neither → treat as fresh)
        const fresh = !baseline || (state.store.rev && baseline.rev
          ? state.store.rev !== baseline.rev
          : (baseline.hash && state.store.hash ? state.store.hash !== baseline.hash : true));
        if (fresh) {
          storeInfo = state.store;
          if (state.store.hash) break; // complete entry — classify integrity
        }
      }
      if (state && state.txt.includes(name) && /saved/i.test(state.txt)) {
        saved = true;
        // the room-registry entry (carrying sha256) can lag the panel marker
        // by a beat — keep polling a few more seconds so integrity gets
        // classified instead of reporting an unverified landing
        if (!savedAt) savedAt = Date.now();
        else if (Date.now() - savedAt > 6000) break;
      }
      await this.page.waitForTimeout(800);
    }
    // integrity: what the room actually holds vs the exact bytes injected.
    // 'utf8-mangled' = the panel's text fallback stored the file through a
    // UTF-8 decode, which corrupts binary files (text files round-trip
    // losslessly, so their hash still matches the source).
    let integrity = 'unknown';
    if (storeInfo && src.sha256) {
      if (storeInfo.hash === src.sha256) integrity = 'match';
      else if (src.mangledSha256 && storeInfo.hash === src.mangledSha256) integrity = 'utf8-mangled';
    }
    const landed = !!storeInfo;
    const mangled = integrity === 'utf8-mangled';
    const embedBlocked = this.diag.console.some(l => String(l).indexOf('upload.perchance.org') !== -1 &&
      (String(l).indexOf('ERR_BLOCKED') !== -1 || String(l).indexOf('X-Frame-Options') !== -1));
    return {
      ok: !mangled && (landed || saved),
      file: name, saved, landed, integrity,
      overwritten: overwrote, renamedTo, ms: Date.now() - t0,
      bytes: src.bytes, source: src.source,
      sha256: src.sha256 || null,
      storeHash: storeInfo ? storeInfo.hash : null,
      storeSize: storeInfo ? storeInfo.size : null,
      embedBlocked,
      error: renamedTo
        ? 'the editor renamed the upload because the name already exists — it landed at ' + renamedTo + '; retry with overwrite:true to replace the original'
        : (mangled
          ? 'landed in the editor src store but the bytes are CORRUPTED (integrity utf8-mangled): the file went through UTF-8 text storage, which expands/corrupts binary data (stored ' + storeInfo.size + ' bytes vs source ' + src.bytes + '). Usual cause: binary:false was forced on a non-UTF-8 file. Retry with overwrite:true and no binary flag — content sniffing picks the byte-exact path.'
          : undefined),
      hint: mangled
        ? 'do not treat this file as uploaded — the staged bytes do not match the source'
        : (landed
          ? 'landed in the editor src store (integrity: ' + integrity + '); visitors see it once the generator owner saves'
          : (saved
            ? 'panel reported "saved" but no store entry was observed — verify with perch_eval {frame:"editor", js:"JSON.stringify(window.srcState._internals.working)"}'
            : (renamedTo ? undefined : 'file was injected but never landed in the editor src store and the panel never reported "saved" — check perch_errors and retry'))),
    };
  }

  async stop() {
    if (this._idle) { clearInterval(this._idle); this._idle = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
    if (this.browser) { try { await this.browser.close(); } catch {} this.browser = null; }
    this.page = null;
    this.ready = false;
    this.generator = null;
    this.collabKey = null;
    this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    return { ok: true, stopped: true };
  }
}

module.exports = { PerchSession, buildEditorUrl, isCfBlocked, MIRROR_ROOT };
