// Usage: node --env-file=.env scripts/loadtest.js [concurrency=1,2,4,8] [requestsPerLevel=8]
import { chat, MODEL } from '../src/ollama.js';

const levels = (process.argv[2] ?? '1,2,4,8').split(',').map(Number);
const total = Number(process.argv[3] ?? 8);
const PROMPT = 'Explain in two sentences what a Discord bot is.';

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];

async function run(concurrency) {
  const lat = [];
  let errors = 0;
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < total) {
        const t = performance.now();
        try {
          await chat([{ role: 'user', content: PROMPT }]);
          lat.push((performance.now() - t) / 1000);
        } catch {
          errors++;
        }
      }
    }),
  );
  const wall = (performance.now() - start) / 1000;
  lat.sort((a, b) => a - b);
  return {
    concurrency,
    ok: lat.length,
    errors,
    'req/s': (lat.length / wall).toFixed(2),
    'p50 s': lat.length ? pct(lat, 50).toFixed(1) : '-',
    'p95 s': lat.length ? pct(lat, 95).toFixed(1) : '-',
    'max s': lat.length ? lat.at(-1).toFixed(1) : '-',
  };
}

console.log(`model=${MODEL} requests/level=${total}`);
await chat([{ role: 'user', content: 'hi' }]); // warm-up: load model
const rows = [];
for (const c of levels) rows.push(await run(c));
console.table(rows);
