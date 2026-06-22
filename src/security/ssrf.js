// SSRF guard for server-side fetches of user-supplied URLs (JD scraping).
//
// Threat: a student sends a URL and we navigate Puppeteer to it. Without a
// guard, http://169.254.169.254/ (cloud metadata), http://localhost/admin, or
// any private-range IP becomes reachable from inside our network, and the
// scraped bytes can be echoed back into the resume we hand the attacker.
//
// Defense: require https, resolve the hostname ourselves, and refuse if ANY
// resolved address is loopback/private/link-local/reserved. We also export an
// IP-literal check the scraper uses to abort redirects/sub-requests mid-flight.
const net = require('net');
const dns = require('dns').promises;

// IPv4 / IPv6 ranges that must never be reachable from a user-driven fetch.
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + (parseInt(oct, 10) & 0xff), 0) >>> 0;
}

function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  const inRange = (cidr, bits) => (n & (~0 << (32 - bits)) >>> 0) === (ipv4ToInt(cidr) & (~0 << (32 - bits)) >>> 0);
  return (
    inRange('0.0.0.0', 8) ||       // "this" network
    inRange('10.0.0.0', 8) ||      // private
    inRange('100.64.0.0', 10) ||   // CGNAT
    inRange('127.0.0.0', 8) ||     // loopback
    inRange('169.254.0.0', 16) ||  // link-local (incl. 169.254.169.254 metadata)
    inRange('172.16.0.0', 12) ||   // private
    inRange('192.0.0.0', 24) ||    // IETF protocol assignments
    inRange('192.168.0.0', 16) ||  // private
    inRange('198.18.0.0', 15) ||   // benchmarking
    inRange('224.0.0.0', 4) ||     // multicast
    inRange('240.0.0.0', 4)        // reserved
  );
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;             // loopback / unspecified
  if (lower.startsWith('fe80') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;   // unique-local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — unwrap and check the embedded v4.
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isPrivateIPv4(ip);
  if (fam === 6) return isPrivateIPv6(ip);
  return true; // not a parseable IP → treat as unsafe
}

// Hostnames that should never be fetched, independent of DNS.
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal']);

// Validate a user-supplied URL for server-side fetching. Throws on anything
// unsafe; returns the parsed URL on success. https-only by design.
async function assertFetchableUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    throw new Error('ssrf: unparseable URL');
  }
  if (u.protocol !== 'https:') throw new Error(`ssrf: scheme ${u.protocol} not allowed (https only)`);

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new Error('ssrf: empty host');
  if (BLOCKED_HOSTNAMES.has(host)) throw new Error('ssrf: blocked hostname');
  if (host.endsWith('.internal') || host.endsWith('.local')) throw new Error('ssrf: internal hostname');

  // IP literal in the host → check directly (no DNS).
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('ssrf: private IP literal');
    return u;
  }

  // Resolve and reject if ANY address is private (defends naive DNS rebinding).
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('ssrf: DNS resolution failed');
  }
  if (!addrs.length) throw new Error('ssrf: no DNS records');
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`ssrf: host resolves to private IP ${address}`);
  }
  return u;
}

module.exports = { assertFetchableUrl, isPrivateIp, isPrivateIPv4, isPrivateIPv6 };
