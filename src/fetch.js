import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

const MAX_TEXT = 4000;
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;

export const fetchTool = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description:
      'Fetch a web page (http/https URL, e.g. one from search results) and return its text content. Use it to read a page when search snippets do not contain the answer.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full URL to fetch' } },
      required: ['url'],
    },
  },
};

// Addresses fetch_url must never connect to: loopback, private networks, link-local (incl. cloud metadata at 169.254.169.254),
// carrier-grade NAT, documentation/benchmark ranges, multicast and reserved space, and IPv6 forms that can embed an IPv4 address
// (NAT64, 6to4, Teredo). IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked by BlockList against the IPv4 rules above; do not add a
// ::ffff:0:0/96 entry, Node would then treat every IPv4 address as blocked.
const blocked = new net.BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, bits, 'ipv4');
for (const [address, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(address, bits, 'ipv6');

export function isPrivate(ip) {
  if (!net.isIP(ip)) return true; // anything we cannot classify is refused
  return blocked.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

// The connection's DNS lookup. Every address the name resolves to must be public, and the socket connects to exactly the
// addresses checked here. A separate check followed by a second lookup would let a hostile DNS server answer a public
// address for the check and 127.0.0.1 for the connection (DNS rebinding).
export function safeLookup(hostname, options, callback) {
  const opts = typeof options === 'object' && options ? options : { family: options };
  lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => isPrivate(a.address))) return callback(new Error('private addresses are not allowed'));
    if (opts.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

// One GET with no redirect handling; resolves { status, location, body } with the body capped at MAX_BYTES.
function get(u) {
  return new Promise((resolve, reject) => {
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request(
      u,
      {
        method: 'GET',
        lookup: safeLookup,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ollama-discord-bot)', 'Accept-Encoding': 'gzip, deflate, br' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      (res) => {
        const status = res.statusCode;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return resolve({ status, location });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${status}`));
        }
        const encoding = res.headers['content-encoding'];
        let stream = res;
        if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        let size = 0;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
        };
        stream.on('data', (chunk) => {
          if (finished) return;
          size += chunk.length;
          chunks.push(size > MAX_BYTES ? chunk.subarray(0, chunk.length - (size - MAX_BYTES)) : chunk);
          if (size >= MAX_BYTES) {
            finish();
            res.destroy();
          }
        });
        stream.on('end', finish);
        stream.on('error', (err) => (finished ? undefined : reject(err)));
        res.on('error', (err) => (finished ? undefined : reject(err)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function fetchText(url, redirects = 3) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http/https URLs are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // IP literals skip DNS, so safeLookup never sees them
  if (net.isIP(host) && isPrivate(host)) throw new Error('private addresses are not allowed');
  const { location, body } = await get(u);
  if (location) {
    if (redirects <= 0) throw new Error('too many redirects');
    return fetchText(new URL(location, u).href, redirects - 1);
  }
  return body;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', lsquo: "'", rsquo: "'",
  ldquo: '"', rdquo: '"', laquo: '"', raquo: '"', copy: '(c)', reg: '(R)', trade: '(TM)', bull: '*', middot: '·',
};

// Single pass, so "&amp;lt;" becomes "&lt;" (what the page shows) and not "<".
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// Readable text of an HTML page: drops scripts, styles and comments, prefers <main> or <article>, then drops page chrome.
// Tag names must be followed by a space, ">" or "/", so custom elements like <main-content> are not mistaken for them.
export function htmlToText(html) {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<(script|style|noscript|svg|template)(?=[\s>/])[\s\S]*?<\/\1\s*>/gi, ' ');
  const main = h.match(/<main(?=[\s>])[\s\S]*?<\/main\s*>/i) ?? h.match(/<article(?=[\s>])[\s\S]*?<\/article\s*>/i);
  h = main?.[0] ?? h;
  const chrome = main ? 'nav|footer|aside' : 'nav|header|footer|aside';
  h = h.replace(new RegExp(`<(${chrome})(?=[\\s>/])[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), ' ');
  return decodeEntities(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

export async function fetchUrl({ url }) {
  return htmlToText(await fetchText(url));
}
