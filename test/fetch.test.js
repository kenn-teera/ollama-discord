import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchUrl, htmlToText, isPrivate, safeLookup } from '../src/fetch.js';

test('isPrivate refuses local, private, reserved and embedded-IPv4 addresses', () => {
  for (const ip of [
    '127.0.0.1', '127.255.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fc00::1', 'fd12::1',
    'ff02::1', '64:ff9b::7f00:1', '2002:7f00:1::1', 'not an ip',
  ]) assert.equal(isPrivate(ip), true, `${ip} should be refused`);
});

test('isPrivate allows ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.63.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivate(ip), false, `${ip} should be allowed`);
  }
});

test('safeLookup refuses a name that resolves to loopback', async () => {
  await assert.rejects(new Promise((resolve, reject) => safeLookup('localhost', {}, (err, a) => (err ? reject(err) : resolve(a)))), /private addresses/);
  await assert.rejects(new Promise((resolve, reject) => safeLookup('localhost', { all: true }, (err, a) => (err ? reject(err) : resolve(a)))), /private addresses/);
});

test('fetchUrl never connects to local or private targets', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end('secret'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const urls = [
    `http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`,
    `http://2130706433:${port}/`, `http://0x7f.1:${port}/`, `http://127.1:${port}/`, 'http://0.0.0.0/', 'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/', 'http://192.168.0.1/',
  ];
  for (const url of urls) await assert.rejects(fetchUrl({ url }), /private addresses/, url);
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)']) await assert.rejects(fetchUrl({ url }), /only http\/https|Invalid URL/, url);
  server.close();
  assert.equal(hits, 0, 'the local server must receive no request');
});

test('htmlToText keeps content inside a page-wide <form> (ASP.NET style)', () => {
  const html = '<html><body><form id="aspnetForm"><div><h1>Race calendar</h1><p>Next race: 25 October.</p></div></form></body></html>';
  assert.equal(htmlToText(html), 'Race calendar Next race: 25 October.');
});

test('htmlToText removes scripts, styles, comments and page chrome', () => {
  const html = '<head><style>p{}</style></head><body><nav>Home About</nav><header>Site</header><!-- hidden --><script>var a="x";</script><p>Real text</p><footer>Copyright</footer><aside>Ads</aside></body>';
  assert.equal(htmlToText(html), 'Real text');
});

test('htmlToText prefers <main> / <article> but does not match custom elements', () => {
  assert.equal(htmlToText('<body><nav>menu</nav><main><nav>sub</nav><p>Main text</p></main><p>outside</p></body>'), 'Main text');
  assert.equal(htmlToText('<body><article>Story</article><p>other</p></body>'), 'Story');
  assert.equal(htmlToText('<body><main-content><p>Custom element text</p></main-content><p>More</p></body>'), 'Custom element text More');
});

test('htmlToText decodes entities once, including numeric ones', () => {
  assert.equal(htmlToText('<p>Tom &amp; Jerry &lt;3 &quot;hi&quot; it&#39;s&nbsp;ok &#x27;x&#x27; &copy; &amp;lt;b&amp;gt;</p>'), 'Tom & Jerry <3 "hi" it\'s ok \'x\' (c) &lt;b&gt;');
  assert.equal(htmlToText('<p>&#0; &#99999999; &unknown;</p>'), '&unknown;');
});

test('htmlToText caps the length', () => {
  assert.equal(htmlToText('<p>' + 'a '.repeat(10000) + '</p>').length, 4000);
});
