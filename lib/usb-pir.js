import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { integer } from './http.js';

const script = fileURLToPath(new URL('../scripts/usb-pir.ps1', import.meta.url));

export function parsePIRReading(line, active, inactive, pulse) {
  if (typeof line !== 'string') return undefined;
  const value = line.trim().toLowerCase();
  if (value === active) return true;
  if (!pulse && value === inactive) return false;
  return undefined;
}

export function startUsbPir(env, callbacks) {
  const port = env.KIOSK_PIR_PORT;
  if (process.platform !== 'win32' || !/^COM[1-9]\d*$/i.test(port ?? '')) {
    throw new Error('USB PIR mode needs Windows and KIOSK_PIR_PORT set to its COM port.');
  }
  const baud = integer(env.KIOSK_PIR_BAUD, 9600, 300, 1000000);
  const mode = env.KIOSK_PIR_OUTPUT || 'level';
  const pulse = mode === 'pulse';
  const active = (env.KIOSK_PIR_ACTIVE ?? '1').trim().toLowerCase();
  const inactive = (env.KIOSK_PIR_INACTIVE ?? '0').trim().toLowerCase();
  if (!['level', 'pulse'].includes(mode) || !active || (!pulse && (!inactive || inactive === active))) {
    throw new Error('Set PIR output to level with distinct active and inactive values, or pulse with one active value.');
  }
  const hold = integer(env.KIOSK_PIR_HOLD_MS, 20000, 1000, 900000);
  const powershell = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let child;
  let reconnect;
  let expiration;
  let stopped = false;
  let error;
  let loggedError;

  function publish(present) {
    callbacks.reading(present);
    if (pulse && present) {
      clearTimeout(expiration);
      expiration = setTimeout(() => callbacks.reading(false), hold);
    }
  }

  function connect() {
    if (stopped) return;
    error = undefined;
    child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-File', script, '-Port', port, '-Baud', String(baud)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.connected === true) {
        callbacks.connection(true);
        loggedError = undefined;
        return;
      }
      const present = parsePIRReading(message.line, active, inactive, pulse);
      if (present !== undefined) publish(present);
    });
    child.stderr.on('data', buffer => {
      error ||= String(buffer).split(/\r?\n/).find(line => line.trim())?.slice(0, 180);
    });
    child.once('error', caught => { error = caught.message; });
    child.once('close', () => {
      lines.close();
      child = undefined;
      if (stopped) return;
      callbacks.connection(false);
      const message = error || 'Serial connection closed.';
      if (loggedError !== message) console.error(`USB PIR ${port}: ${message}`);
      loggedError = message;
      reconnect = setTimeout(connect, 5000);
    });
  }
  connect();
  return () => {
    stopped = true;
    clearTimeout(reconnect);
    clearTimeout(expiration);
    child?.kill();
  };
}
