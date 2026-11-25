import { cpus, freemem, totalmem, uptime } from 'node:os';
import { statfs } from 'node:fs/promises';

function cpuTimes() {
  return cpus().reduce(([idle, total], { times }) => [
    idle + times.idle,
    total + Object.values(times).reduce((sum, time) => sum + time, 0),
  ], [0, 0]);
}

let previous = cpuTimes();
export async function systemMetrics(directory, latencyMs) {
  const current = cpuTimes();
  const idle = current[0] - previous[0];
  const total = current[1] - previous[1];
  previous = current;
  const disk = await statfs(directory).catch(() => null);
  return {
    latencyMs,
    cpu: total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : null,
    memory: Math.round((1 - freemem() / totalmem()) * 100),
    diskFree: disk ? disk.bavail * disk.bsize : null,
    windowsUptimeSeconds: Math.floor(uptime()),
    agentUptimeSeconds: Math.floor(process.uptime()),
  };
}
