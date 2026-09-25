// routes/scrape.js
// Server-side page fetcher used by the dashboard's "Train AI" step.
// A browser can't fetch another site's raw HTML directly (CORS blocks it),
// which is why the dashboard used to bounce through free public CORS-proxy
// services. Those are unreliable and get rate-limited constantly. A server
// has no such restriction — it can just fetch the URL directly — so this
// replaces that whole flaky proxy chain with one reliable endpoint.
//
// Two modes:
//  - Plain fetch (default): fast, cheap, works for any normal HTML page.
//    Misses content that only appears after client-side JavaScript runs
//    (React/Vue/etc. single-page apps).
//  - Rendered (opt-in via {render:true} in the request body): launches a
//    real headless Chromium via Playwright, lets the page's own JS run,
//    then reads the resulting DOM. Catches what plain fetch can't, at the
//    cost of being much heavier — this is NOT run automatically for every
//    scrape, only when explicitly requested, since a full browser process
//    is real memory/CPU weight to add to a service that's also serving
//    live chat traffic. If Chromium fails to launch for any reason (not
//    installed, out of memory, whatever), this silently falls back to the
//    plain fetch result rather than failing the whole request.

const express = require('express');
const { requireAuth, requireRole } = require('../lib/auth');
const { refineForKnowledgeBase } = require('../lib/gemini');
const router = express.Router();

// Basic SSRF guard — this endpoint fetches whatever URL it's given, so make
// sure that can't be pointed at localhost, private networks, or cloud
// metadata endpoints. Not bulletproof (doesn't resolve DNS to check the
// actual IP a hostname points to), but blocks the obvious cases.
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^\[?::1\]?$/,
  /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local + cloud metadata (169.254.169.254)
  /^\[?fe80:/i, /^\[?fc00:/i, /^\[?fd00:/i,
];

function isBlockedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const host = u.hostname;
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(host));
}

async function fetchPlain(url) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // A normal browser UA/header set — many sites (Cloudflare, etc.) block
        // requests that obviously identify as a bot/script, even for
        // perfectly legitimate uses like this (an owner training their own
        // chatbot on their own public marketing pages).
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);
    if (!r.ok) {
      const blocked = r.status === 403 || r.status === 429 || r.status === 503;
      const err = new Error(blocked
        ? `That site blocked the request (HTTP ${r.status}) — it likely has bot/scraper protection (Cloudflare or similar) that's rejecting this.`
        : `Site responded with ${r.status}`);
      err.status = 502;
      throw err;
    }

    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && contentType !== '') {
      const err = new Error('That URL did not return an HTML page.');
      err.status = 415;
      throw err;
    }

    // Cap how much we read, in case of an enormous page.
    const reader = r.body?.getReader ? r.body.getReader() : null;
    let html = '';
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      const MAX_BYTES = 5 * 1024 * 1024; // 5MB
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        html += decoder.decode(value, { stream: true });
        if (bytes > MAX_BYTES) { ctrl.abort(); break; }
      }
    } else {
      html = await r.text();
    }

    if (!html || html.length < 50) {
      const err = new Error('Page returned no usable content.');
      err.status = 502;
      throw err;
    }
    return html;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') { const e = new Error('Timed out fetching that page.'); e.status = 504; throw e; }
    throw err;
  }
}

// Single shared browser instance, launched lazily on first use and reused
// after that — launching Chromium fresh per request would be far too slow
// and memory-hungry for a service that's also handling live chat traffic.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    const { chromium } = require('playwright');
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    }).catch((err) => {
      browserPromise = null; // let the next call retry rather than staying permanently broken
      throw err;
    });
  }
  return browserPromise;
}

// Only one render at a time — a second concurrent Chromium page while
// Render's free-tier instance is already tight on memory is how you take
// the whole backend down mid-render, taking live chat with it.
let renderInFlight = false;

async function fetchRendered(url) {
  if (renderInFlight) {
    const err = new Error('Already rendering another page — try again in a moment.');
    err.status = 429;
    throw err;
  }
  renderInFlight = true;
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    // A short extra pause for anything that hydrates just after the network
    // goes idle (common with client-side frameworks) — cheap insurance.
    await page.waitForTimeout(600);
    const html = await page.content();
    if (!html || html.length < 50) {
      const err = new Error('Rendered page returned no usable content.');
      err.status = 502;
      throw err;
    }
    return html;
  } finally {
    if (page) await page.close().catch(() => {});
    renderInFlight = false;
  }
}

router.post('/scrape', requireAuth, requireRole('owner', 'worker'), async (req, res) => {
  const { url, render } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
  if (isBlockedUrl(url)) return res.status(400).json({ error: 'That URL is not allowed.' });

  let renderFallbackReason = null;
  if (render) {
    try {
      const html = await fetchRendered(url);
      return res.json({ html, rendered: true });
    } catch (err) {
      // Rendering is best-effort — if Chromium isn't available in this
      // environment, crashed, or timed out, fall back to the plain fetch
      // instead of failing the whole request. The owner still gets
      // something rather than nothing. But silently swallowing WHY it
      // failed made "Could not extract readable content" a dead end with
      // no way to tell rendering-failed-so-we-got-an-empty-SPA-shell apart
      // from the site genuinely having too little text — so pass the
      // reason back to the client instead of only logging it server-side.
      renderFallbackReason = err.message || String(err);
      console.error('Rendered scrape failed, falling back to plain fetch:', renderFallbackReason);
    }
  }

  try {
    const html = await fetchPlain(url);
    res.json({ html, rendered: false, renderFallbackReason });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Failed to fetch that page.', renderFallbackReason });
  }
});

// Refines raw scraped/extracted page text into clean knowledge-base notes
// via Gemini — the server-side replacement for the old client-side
// "refineWithGemini" call (which had its API key exposed directly in the
// browser). The browser does the HTML-to-text extraction (see
// htmlToReadableText in agency.html) and sends the resulting plain text
// here; this only ever talks to Gemini from the server.
router.post('/refine', requireAuth, requireRole('owner', 'worker'), async (req, res) => {
  const { text, url } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const refined = await refineForKnowledgeBase(text, url);
    res.json({ refined });
  } catch (err) {
    console.error('Gemini refine error:', err.message);
    // 502 (bad gateway / upstream failure) rather than 500 — this failing
    // is Gemini's problem, not this server's, and the caller (agency.html)
    // is expected to catch this and fall back to the raw text rather than
    // blocking the whole import over it.
    res.status(502).json({ error: err.message || 'Refinement failed' });
  }
});

// File extensions that are never worth offering as a "page" to train on.
const SKIP_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|svg|webp|ico|css|js|json|xml|zip|mp4|mp3|woff2?|ttf|eot)$/i;

// Turns a URL path into a readable label without an extra fetch per page —
// e.g. "/pricing" -> "Pricing", "/about-us" -> "About us", "/" -> "Home".
function labelFromPath(pathname) {
  if (!pathname || pathname === '/') return 'Home';
  const last = pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || 'Home';
  const words = decodeURIComponent(last).replace(/[-_]+/g, ' ').trim();
  return words.length ? words.charAt(0).toUpperCase() + words.slice(1) : pathname;
}

// Discovers same-site pages linked FROM the given URL, so a worker can pick
// which ones actually matter for training instead of manually typing each
// URL in one at a time. Doesn't follow links recursively (one hop only) —
// deep crawling a whole site from the dashboard would be slow and easy to
// abuse; most marketing/support sites link everything worth training on
// from the homepage or nav anyway.
router.post('/crawl', requireAuth, requireRole('owner', 'worker'), async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
  if (isBlockedUrl(url)) return res.status(400).json({ error: 'That URL is not allowed.' });

  let baseUrl;
  try { baseUrl = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    const html = await fetchPlain(url);
    const hrefs = [...html.matchAll(/<a\s+[^>]*href=["']([^"'#]+)["']/gi)].map(m => m[1]);

    const seen = new Map(); // pathname -> {url, label}
    seen.set(baseUrl.pathname || '/', { url: baseUrl.href, label: labelFromPath(baseUrl.pathname) });

    for (const href of hrefs) {
      if (seen.size >= 30) break;
      if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
      let resolved;
      try { resolved = new URL(href, baseUrl); } catch { continue; }
      if (resolved.hostname !== baseUrl.hostname) continue; // same-site only
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      if (SKIP_EXTENSIONS.test(resolved.pathname)) continue;
      resolved.hash = '';
      const key = resolved.pathname || '/';
      if (!seen.has(key)) seen.set(key, { url: resolved.href, label: labelFromPath(resolved.pathname) });
    }

    res.json({ pages: [...seen.values()] });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Failed to crawl that page.' });
  }
});

module.exports = router;
