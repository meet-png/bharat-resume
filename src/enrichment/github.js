// GitHub repo enrichment for project bullets. PRD §16 had no enrichment module —
// added 2026-06-21 per Meet's UX feedback on the projects step.
//
// Goal: when a student shares a GitHub URL during AWAITING_PROJECTS, fetch the
// repo's metadata + README so the LLM can infer tech stack, what the project
// does, and rough scope WITHOUT re-prompting the student for every detail.
//
// Unauthenticated GitHub API: 60 req/hr per IP. With GITHUB_TOKEN: 5000/hr.
// On any fetch failure we return null and the LLM falls back to user-provided
// text alone — never block the conversation on a network hiccup.
const { config } = require('../config');
const logger = require('../logger');

const REPO_URL_RE = /github\.com\/([A-Za-z0-9][A-Za-z0-9\-_.]*)\/([A-Za-z0-9][A-Za-z0-9\-_.]*?)(?:\.git)?(?:[\/\?\#]|$)/i;

function parseRepo(text) {
  if (!text) return null;
  const m = String(text).match(REPO_URL_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function authHeaders() {
  const h = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'bharat-resume' };
  if (config.GITHUB_TOKEN) h['Authorization'] = `Bearer ${config.GITHUB_TOKEN}`;
  return h;
}

async function fetchJsonOrNull(url, timeoutMs = 4000, headers = authHeaders()) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { headers, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function fetchTextOrNull(url, timeoutMs = 4000, headers = authHeaders()) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { headers, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchRepoFromUrl(url) {
  const parsed = parseRepo(url);
  if (!parsed) return null;
  const { owner, repo } = parsed;
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const [meta, langs, readmeRaw] = await Promise.all([
    fetchJsonOrNull(base),
    fetchJsonOrNull(`${base}/languages`),
    fetchTextOrNull(`${base}/readme`, 4000, { ...authHeaders(), 'Accept': 'application/vnd.github.raw' }),
  ]);

  if (!meta) {
    logger.warn({ owner, repo }, 'github fetch: repo metadata unavailable');
    return null;
  }

  return {
    owner,
    repo,
    name: meta.name,
    full_name: meta.full_name,
    description: meta.description,
    html_url: meta.html_url,
    languages: langs ? Object.keys(langs) : [],
    topics: meta.topics || [],
    stars: meta.stargazers_count,
    forks: meta.forks_count,
    open_issues: meta.open_issues_count,
    is_fork: meta.fork,
    license: meta.license?.spdx_id || null,
    default_branch: meta.default_branch,
    readme: readmeRaw ? readmeRaw.slice(0, 2500) : null,
  };
}

module.exports = { fetchRepoFromUrl, parseRepo, REPO_URL_RE };
