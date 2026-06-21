// Naukri JD scraper via Puppeteer. PRD §8.1.
// Cache by sha256(url) in Redis for 24h (PRD §8.4) — Naukri JDs don't change
// daily and re-scraping risks rate-limit blocks.
const crypto = require('crypto');
const { getClient } = require('../store/redis');
const logger = require('../logger');

const CACHE_TTL_SEC = 24 * 60 * 60;
const PAGE_TIMEOUT_MS = 12000;
const SELECTOR_TIMEOUT_MS = 5000;

// PRD §8.1 names .styles_jhc__main__J-rDk as the JD container, but PRD §20 flags
// this for verification at build time. We try a small list of likely selectors
// and fall back to body.innerText if none match. The LLM keyword extractor
// handles noisy input fine, so we err toward "scrape anything readable".
const JD_SELECTORS = [
  '.styles_jhc__main__J-rDk',
  '[class*="JDC__main"]',
  '[class*="jd-container"]',
  '[class*="jdSection"]',
  '.jd-desc',
  '.dang-inner-html',
];

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  const puppeteer = require('puppeteer');
  _browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  return _browser;
}

async function scrapeNaukri(url) {
  const cacheKey = `jd:${crypto.createHash('sha256').update(url).digest('hex')}`;
  const redis = getClient();

  const cached = await redis.get(cacheKey);
  if (cached) {
    logger.info({ url, fromCache: true, len: cached.length }, 'naukri scrape: cache hit');
    return cached;
  }

  let page;
  const t0 = Date.now();
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-IN,en;q=0.9' });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });

    let text = '';
    let matched = null;
    for (const sel of JD_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: SELECTOR_TIMEOUT_MS });
        text = await page.$eval(sel, (el) => el.innerText);
        if (text && text.length > 200) { matched = sel; break; }
      } catch {
        // Try next selector
      }
    }

    if (!text || text.length < 200) {
      // Fallback: whole body (LLM extractor will sift the noise).
      text = await page.evaluate(() => document.body ? document.body.innerText : '');
      matched = matched || 'body-fallback';
    }

    text = text.replace(/\s+/g, ' ').trim().slice(0, 8000);

    if (text.length > 100) {
      await redis.set(cacheKey, text, 'EX', CACHE_TTL_SEC);
    }

    logger.info({ url, ms: Date.now() - t0, len: text.length, selector: matched }, 'naukri scrape: ok');
    return text;
  } catch (e) {
    logger.warn({ url, ms: Date.now() - t0, err: e.message }, 'naukri scrape: failed');
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Best-effort cleanup if the process is going down.
async function shutdownBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
}

module.exports = { scrapeNaukri, shutdownBrowser };
