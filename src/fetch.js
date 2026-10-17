import { lookup } from 'node:dns/promises';
import net from 'node:net';

const MAX_TEXT = 4000;

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

function isPrivate(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^(fc|fd|fe80)/i.test(ip) || ip.startsWith('::ffff:');
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

async function safeFetch(url, redirects = 3) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http/https URLs are allowed');
  const { address } = await lookup(u.hostname);
  if (isPrivate(address)) throw new Error('private addresses are not allowed');

  const res = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ollama-discord-bot)' },
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    if (redirects <= 0) throw new Error('too many redirects');
    return safeFetch(new URL(res.headers.get('location'), u).href, redirects - 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

export async function fetchUrl({ url }) {
  let html = (await (await safeFetch(url)).text()).slice(0, 1_000_000);
  html = html.replace(/<(script|style|noscript|svg|header|nav|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  const main = html.match(/<main[\s\S]*?<\/main>/i) ?? html.match(/<article[\s\S]*?<\/article>/i);
  return (main?.[0] ?? html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}
