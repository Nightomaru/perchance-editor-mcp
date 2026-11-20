// perch-upload.js — PUBLIC file upload via the perchance.org/upload embed.
//
// Independent of the editor session (no generator, no collab key, no owner
// save). Own browser: patchright chromium HEADED + persistent profile, one page
// parked on https://upload.perchance.org/embed#{} — the only engine combination
// measured to clear both the Cloudflare edge AND Turnstile on this embed
// (firefox/playwright-chromium fail Turnstile 600010; headless fails the CF edge).
//
// Patchright's page.evaluate runs in an ISOLATED world (page globals invisible),
// so every page interaction goes through raw CDP Runtime.evaluate, which lands
// in the MAIN world. The page's own uploadFileByUrl() provides Turnstile
// verification, key reuse, 4-attempt retry and >5MB chunking for free.
//
// Recipe + measurements: test/public-upload-probe.cjs and the perchance-editor
// skill's references/public-file-upload.md. Uploads are ANONYMOUS and PUBLIC to
// anyone with the link — callers must never send secrets or personal data.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const EMBED_URL = 'https://upload.perchance.org/embed#{}';
const PROFILE_DIR = path.join(__dirname, '.perch-upload-profile');
const IDLE_MS = 20 * 60 * 1000;          // matches perch-core's session idle teardown
const MAX_LOCAL_BYTES = 40 * 1024 * 1024; // CDP-expression guard; server quota is stricter anyway
const DELETE_WINDOW_MS = 3 * 24 * 3600 * 1000;

const EXPIRES_MAP = {
  never: 0,
  '1h': 3600000,
  '1d': 86400000,
  '1w': 604800000,
  '1mo': 2592000000,
  '3mo': 7776000000,
  '1y': 31536000000,
};

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  pdf: 'application/pdf', json: 'application/json', zip: 'application/zip', gz: 'application/gzip',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json',
};

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const extOf = (name) => String(name || '').split('.').pop().toLowerCase();
const mimeFor = (name, fallback) => MIME[extOf(name)] || fallback || 'application/octet-stream';

class PublicUploader {
  constructor() {
    this.ctx = null;
    this.page = null;
    this.cdp = null;
    this.ua = null;
    this.last = Date.now();
    this._idle = null;
    this._chain = Promise.resolve(); // serialize calls: one parked page, no racing uploads
  }

  _touch() { this.last = Date.now(); }

  _ensureIdle() {
    if (this._idle) return;
    this._idle = setInterval(() => {
      if (this.ctx && Date.now() - this.last > IDLE_MS) this.stop().catch(() => {});
    }, 30000);
    this._idle.unref();
  }

  // ---- main-world bridge (patchright's own evaluate is an isolated world) ----
  async _ev(fn, arg) {
    if (!this.cdp) this.cdp = await this.ctx.newCDPSession(this.page);
    const expression = `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`;
    const r = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text;
      throw new Error('upload-page eval: ' + String(d).slice(0, 300));
    }
    return r.result ? r.result.value : null;
  }

  async _ensurePage() {
    this._ensureIdle();
    if (!this.ctx) {
      let patchright;
      try { patchright = require('patchright'); }
      catch (e) {
        throw new Error('patchright is not installed in the perch-mcp checkout — run: npm i patchright && npx patchright install chromium');
      }
      // HEADED is mandatory: the CF edge flags headless chromium regardless of stealth.
      this.ctx = await patchright.chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
      this.page = this.ctx.pages()[0] || (await this.ctx.newPage());
      this.page.on('dialog', (d) => d.dismiss().catch(() => {}));
      this.cdp = null;
      this.ua = null;
    }
    // (Re)load the embed if the page is blank, navigated away, or lost its globals.
    let ready = false;
    try { ready = (await this._ev(() => typeof uploadFileByUrl)) === 'function'; } catch (e) { ready = false; }
    if (!ready) {
      this.cdp = null; // fresh session after any navigation
      await this.page.goto(EMBED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const t0 = Date.now();
      let cf = true;
      while (Date.now() - t0 < 90000) {
        cf = await this.page.evaluate(() => (document.title || '').toLowerCase().includes('just a moment')).catch(() => true);
        if (!cf) break;
        await this.page.waitForTimeout(1500);
      }
      if (cf) {
        const err = new Error('Cloudflare challenge did not clear on upload.perchance.org (90s). Retry; if it persists, open the embed once in the visible upload window.');
        err.payload = { ok: false, error: 'cf_blocked', engine: 'patchright-headed' };
        throw err;
      }
      const tf = Date.now();
      while (Date.now() - tf < 30000) {
        ready = (await this._ev(() => typeof uploadFileByUrl).catch(() => null)) === 'function';
        if (ready) break;
        await this.page.waitForTimeout(500);
      }
      if (!ready) throw new Error('upload embed loaded but uploadFileByUrl never appeared (page scripts blocked?)');
      // Standalone embed without a #hash leaves urlHashData undefined (JSON.parse('') throws).
      await this._ev(() => { if (!window.urlHashData) window.urlHashData = { sessionToken: '', email: '' }; });
      // Main-world diagnostics: patchright surfaces no console/pageerror events.
      await this._ev(() => {
        if (window.__mwLog) return true;
        window.__mwLog = [];
        const push = (s) => { window.__mwLog.push(String(s).slice(0, 220)); if (window.__mwLog.length > 100) window.__mwLog.shift(); };
        for (const k of ['error', 'warn']) {
          const orig = console[k].bind(console);
          console[k] = (...a) => { try { push(k + ': ' + a.map((x) => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x))).join(' ')); } catch (e) {} orig(...a); };
        }
        window.addEventListener('error', (e) => push('onerror: ' + e.message));
        window.addEventListener('unhandledrejection', (e) => push('rejection: ' + ((e.reason && e.reason.message) || e.reason)));
        return true;
      });
      this.ua = await this._ev(() => navigator.userAgent);
    }
    if (!this.ua) this.ua = await this._ev(() => navigator.userAgent).catch(() => null);
  }

  async _mwLogTail() {
    try { return (await this._ev(() => (window.__mwLog || []).slice(-12))) || []; } catch (e) { return []; }
  }

  // ---- source resolution: filePath > url > content (deterministic precedence) ----
  _resolveSource(a) {
    if (a.filePath) {
      const p = path.resolve(String(a.filePath));
      let bytes;
      try { bytes = fs.readFileSync(p); }
      catch (e) { return { error: 'cannot read filePath: ' + String(e.message || e).slice(0, 200) }; }
      if (bytes.length === 0) return { error: 'filePath is empty (0 bytes)' };
      if (bytes.length > MAX_LOCAL_BYTES) return { error: `file too large for the upload bridge (${bytes.length} bytes > ${MAX_LOCAL_BYTES}); the server quota is stricter anyway` };
      const name = a.name || path.basename(p);
      return { name, url: `data:${mimeFor(name)};base64,${bytes.toString('base64')}`, localSha: sha256(bytes), localBytes: bytes.length };
    }
    if (a.url) {
      const u = String(a.url);
      if (!/^https:\/\//i.test(u)) return { error: 'url must be https:// (Perchance\'s server fetches it directly)' };
      let name = a.name;
      if (!name) {
        try { name = decodeURIComponent(new URL(u).pathname.split('/').pop() || '') || 'upload.bin'; }
        catch (e) { name = 'upload.bin'; }
      }
      return { name, url: u, localSha: null, localBytes: null }; // server-side fetch: no local bytes to compare
    }
    if (typeof a.content === 'string') {
      const bytes = Buffer.from(a.content, 'utf8');
      if (bytes.length === 0) return { error: 'content is empty' };
      const name = a.name || 'upload.txt';
      return { name, url: `data:${mimeFor(name, 'text/plain')};base64,${bytes.toString('base64')}`, localSha: sha256(bytes), localBytes: bytes.length };
    }
    return { error: 'provide one of filePath (absolute local path, read server-side), url (https, fetched by Perchance\'s server), or content (small inline text)' };
  }

  _resolveExpires(a) {
    const key = a.expires === undefined || a.expires === null || a.expires === '' ? 'never' : String(a.expires);
    if (!(key in EXPIRES_MAP)) return { error: `invalid expires '${key}' — use: ${Object.keys(EXPIRES_MAP).join(', ')}` };
    const ms = EXPIRES_MAP[key];
    return { key, abs: ms ? Date.now() + ms : undefined, iso: ms ? new Date(Date.now() + ms).toISOString() : null };
  }

  // ---- public tool entry points (serialized) ----
  upload(a) {
    const p = this._chain.then(() => this._upload(a || {}));
    this._chain = p.catch(() => {});
    return p;
  }

  delete(a) {
    const p = this._chain.then(() => this._delete(a || {}));
    this._chain = p.catch(() => {});
    return p;
  }

  async _upload(a) {
    this._touch();
    const t0 = Date.now();
    const src = this._resolveSource(a);
    if (src.error) return { ok: false, error: src.error };
    const exp = this._resolveExpires(a);
    if (exp.error) return { ok: false, error: exp.error };
    try {
      await this._ensurePage();
      // Let any stray in-flight upload (e.g. one that outlived a tool timeout) finish first.
      const tw = Date.now();
      while (Date.now() - tw < 60000) {
        const inflight = await this._ev(() => (window.uploadDiag && window.uploadDiag.inflight ? window.uploadDiag.inflight.size : 0)).catch(() => 0);
        if (!inflight) break;
        await this.page.waitForTimeout(1000);
      }
      // Budget: verification worst-case ~60s + retries, plus chunking time for big files.
      const capMs = Math.min(600000, 120000 + Math.ceil((src.localBytes || 0) / (5 * 1024 * 1024)) * 30000);
      let timer = null;
      const result = await Promise.race([
        this._ev(async (x) => await uploadFileByUrl(x), { url: src.url, name: src.name, expires: exp.abs }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('upload_timeout')), capMs); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (!result || result.error || !result.url) {
        const error = (result && result.error) || 'upload_failed';
        const hints = {
          file_too_big: 'convert PNG to WebP (much smaller, keeps transparency) and/or set an expiry — expiry raises the max size (1d ~400x)',
          over_daily_allowance: 'daily upload quota exhausted — try tomorrow' + (result && result.cause === 'vpn' ? ', or disable the VPN for a higher quota' : ''),
          anti_bot_verification_failed: 'Turnstile failed — keep the upload browser window visible (not minimized/occluded) and retry',
          anti_bot_script_blocked: 'the Turnstile script was blocked (network/filtering) — retry',
        };
        return { ok: false, error, message: (result && result.message) || null, cause: (result && result.cause) || null, hint: hints[error] || null, log: await this._mwLogTail(), ms: Date.now() - t0 };
      }
      // Integrity: read the public URL back with a browser UA (the file CDN serves
      // plain HTTP clients) and hash-compare against the local bytes when we have them.
      let integrity = null;
      try {
        const r = await fetch(result.url, { headers: { 'User-Agent': this.ua || 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
        const buf = Buffer.from(await r.arrayBuffer());
        integrity = {
          status: r.status, contentType: r.headers.get('content-type'), bytes: buf.length, sha256: sha256(buf),
          match: src.localSha ? sha256(buf) === src.localSha : null,
        };
      } catch (e) {
        integrity = { error: String(e.message || e).slice(0, 200), match: null };
      }
      return {
        ok: true,
        url: result.url,
        name: src.name,
        fileId: result.fileId,
        deletionKey: result.deletionKey || null,
        size: result.size,
        fileExtension: result.fileExtension || null,
        fileAlreadyExisted: !!result.fileAlreadyExisted,
        note: result.fileAlreadyExisted ? 'content-hash dedup hit: same bytes were already uploaded; delete rights may not apply to this key' : null,
        expires: exp.key,
        expiresAt: exp.iso,
        deleteExpiresAt: new Date(Date.now() + DELETE_WINDOW_MS).toISOString(),
        integrity,
        log: await this._mwLogTail(),
        ms: Date.now() - t0,
      };
    } catch (e) {
      if (e && e.payload) return { ...e.payload, log: await this._mwLogTail(), ms: Date.now() - t0 };
      const msg = String((e && e.message) || e);
      if (msg === 'upload_timeout') {
        return { ok: false, error: 'upload_timeout', hint: 'the page-side upload may still complete; wait a moment and retry — a dedup hit (fileAlreadyExisted) means it landed', log: await this._mwLogTail(), ms: Date.now() - t0 };
      }
      return { ok: false, error: msg.slice(0, 400), log: await this._mwLogTail(), ms: Date.now() - t0 };
    }
  }

  async _delete(a) {
    this._touch();
    const t0 = Date.now();
    const fileId = a.fileId && String(a.fileId);
    const deletionKey = a.deletionKey && String(a.deletionKey);
    if (!fileId || !deletionKey) return { ok: false, error: 'fileId and deletionKey are both required (from perch_upload_file\'s result)' };
    try {
      await this._ensurePage();
      const result = await this._ev(async (x) => {
        return await fetch(`/api/delete?fileId=${encodeURIComponent(x.fileId)}&deletionKey=${encodeURIComponent(x.deletionKey)}&__cacheBust=${Math.random()}`)
          .then((r) => r.json()).catch((e) => ({ status: 'network_failure', message: String(e) }));
      }, { fileId, deletionKey });
      const ok = !!(result && result.success === true);
      const expired = result && String(result.status || '').includes('expire');
      return {
        ok,
        deleted: ok,
        status: (result && result.status) || null,
        message: (result && result.message) || null,
        hint: ok ? 'deletion is cached server-side — the file should be fully gone within ~a day'
          : expired ? 'the 3-day delete window for this file has passed; storage is permanent unless an expiry was set'
          : null,
        ms: Date.now() - t0,
      };
    } catch (e) {
      if (e && e.payload) return { ...e.payload, ms: Date.now() - t0 };
      return { ok: false, error: String((e && e.message) || e).slice(0, 400), ms: Date.now() - t0 };
    }
  }

  async stop() {
    const ctx = this.ctx;
    this.ctx = null; this.page = null; this.cdp = null; this.ua = null;
    if (ctx) await ctx.close().catch(() => {});
    return { ok: true, stopped: true };
  }
}

module.exports = { publicUploader: new PublicUploader(), EXPIRES_MAP, EMBED_URL, PROFILE_DIR };