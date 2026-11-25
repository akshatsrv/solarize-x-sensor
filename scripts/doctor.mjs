import { lookup } from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { statfs } from 'node:fs/promises';

const env = process.env;
const server = new URL(env.SERVER_URL || 'http://127.0.0.1:8080');
if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password ||
    (env.KIOSK_MODE === 'production' && server.protocol !== 'https:')) {
  throw new Error('Check SERVER_URL. Production kiosks need an HTTPS URL.');
}
let failures = 0;
async function check(label, run) {
  try {
    const result = await run();
    console.log(`OK    ${label} · ${result}`);
    return result;
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${label} · ${error.message}`);
  }
}
console.log(`Kiosk preflight for ${env.KIOSK_ID || '(no ID)'} → ${server.origin}`);
await check('Runtime', () => {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or later.');
  return `${process.version}, ${process.platform}/${process.arch}, ${availableParallelism()} CPU threads, ${(totalmem() / 1024 ** 3).toFixed(1)} GB RAM`;
});
await check('Local storage', async () => {
  const disk = await statfs(resolve('.'));
  return `${(disk.bavail * disk.bsize / 1024 ** 3).toFixed(1)} GB available on the application volume`;
});
await check('DNS', async () => (await lookup(server.hostname.replace(/^\[|\]$/g, ''))).address);
const ready = await check('Server readiness', async () => {
  const response = await fetch(new URL('/readyz', server), { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok || (await response.json()).status !== 'ready') throw new Error(`Server is unavailable (HTTP ${response.status}).`);
  return server.origin;
});
if (ready) await check('Kiosk credential', async () => {
  if (!env.KIOSK_ID || !env.KIOSK_TOKEN) throw new Error('Set KIOSK_ID and KIOSK_TOKEN.');
  const response = await fetch(new URL('/api/kiosk/preflight', server), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
    headers: { Authorization: `Bearer ${env.KIOSK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: env.KIOSK_ID }),
  });
  if (!response.ok) throw new Error(`Server rejected the connection (HTTP ${response.status}).`);
  const data = await response.json();
  return `${data.server}, version ${data.version}, ${data.enrolled ? 'enrolled' : 'demo enrollment available'}`;
});
if (env.KIOSK_SENSOR_MODE === 'usb-pir') {
  await check('USB PIR port', () => {
    if (process.platform !== 'win32') throw new Error('The USB serial reader requires Windows.');
    const powershell = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.Ports.SerialPort]::GetPortNames()'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (result.error || result.status !== 0) throw new Error('Could not enumerate COM ports.');
    const ports = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (!ports.some(port => port.toLowerCase() === env.KIOSK_PIR_PORT?.toLowerCase())) {
      throw new Error(`Configured port is unavailable. Windows reports: ${ports.join(', ') || 'no COM ports'}.`);
    }
    return `${env.KIOSK_PIR_PORT} detected. Run the PIR probe to verify its output.`;
  });
} else console.log(`INFO  Sensor · ${env.KIOSK_SENSOR_MODE || 'simulation'} mode`);
process.exitCode = failures ? 1 : 0;
