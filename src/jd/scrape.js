// Naukri JD scraper via Puppeteer. PRD §8.1.
// TODO Day 3: launch headless Chrome with realistic UA/viewport,
// wait for JD container selector (verify live at build time — PRD §20 open item),
// extract textContent, strip HTML, return.
// Cache by sha256(url) in Redis 24h (key: jd:{hash}).

async function scrapeNaukri(_url) {
  throw new Error('scrapeNaukri not implemented (Day 3)');
}

module.exports = { scrapeNaukri };
