import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const destination = 'dist/local-system';
await mkdir(destination, { recursive: true });
for (const entry of ['server.js', 'kiosk.js', 'desktop.cjs', 'desktop-preload.cjs', 'package.json', 'lib', 'public']) {
  await cp(entry, join(destination, entry), { recursive: true });
}
