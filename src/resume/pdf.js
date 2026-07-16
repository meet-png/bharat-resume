// HTML → PDF via Puppeteer. PRD §9.5.
// Reuses a browser singleton (separate from jd/scrape.js's; PDF rendering and
// JD scraping have different lifetimes so we don't share). Waits for fonts to
// settle before generating.
const logger = require('../logger');

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
      '--font-render-hinting=none',
    ],
  });
  return _browser;
}

async function htmlToPdf(html, opts = {}) {
  if (!html || typeof html !== 'string') throw new Error('htmlToPdf: html string required');
  const t0 = Date.now();
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    // PRD §9.5: wait for fonts before snapshot.
    await page.evaluateHandle('document.fonts.ready');

    // Path 2 Tier B fix: Chromium's PDF export doesn't reliably honor a
    // REPLACED @page margin declared in HTML (cascade quirk under
    // preferCSSPageSize). Puppeteer's `margin` option DOES win — so when
    // the caller explicitly asks for tighter margins via opts.margin,
    // we pass it through directly. Default stays 0mm so the template's
    // own @page controls layout for regular renders.
    const marginOpt = opts.margin || { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' };
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: marginOpt,
      preferCSSPageSize: !opts.margin, // when explicit margins given, defer to us
    });
    logger.info({ ms: Date.now() - t0, bytes: pdf.length }, 'html→pdf rendered');
    return pdf;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function shutdownBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
}

module.exports = { htmlToPdf, shutdownBrowser };
