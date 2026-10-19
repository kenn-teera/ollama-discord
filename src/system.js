import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const run = promisify(execFile);

// macOS swap usage in MB, or null elsewhere. High swap use is the usual reason a local model suddenly gets slow.
async function swap() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await run('sysctl', ['-n', 'vm.swapusage'], { timeout: 2000 });
    const [, total, used] = stdout.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/) ?? [];
    return total ? { totalMB: Number(total), usedMB: Number(used) } : null;
  } catch {
    return null;
  }
}

// Host and bot-process numbers for the dashboard's Monitor tab.
export async function systemStats() {
  return {
    totalMemMB: Math.round(os.totalmem() / 1048576),
    swap: await swap(),
    loadAvg: os.loadavg()[0],
    cpus: os.cpus().length,
    botRssMB: Math.round(process.memoryUsage().rss / 1048576),
  };
}
