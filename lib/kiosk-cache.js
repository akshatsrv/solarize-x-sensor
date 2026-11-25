import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function openKioskCache(directory) {
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, 'config.json');
  let configuration;
  try {
    configuration = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Reading kiosk cache: ${error.message}`);
  }
  let saving = Promise.resolve();
  return {
    configuration,
    path(id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid media identifier');
      return join(directory, id);
    },
    save(config) {
      const save = saving.then(async () => {
        const temp = `${configPath}.tmp`;
        await writeFile(temp, JSON.stringify(config));
        await rename(temp, configPath);
      });
      saving = save.catch(() => {});
      return save;
    },
    async fetch(item, origin, headers) {
      const destination = this.path(item.id);
      const existing = await stat(destination).catch(() => null);
      if (existing?.size === item.size) return;
      const response = await fetch(new URL(`/api/media/${item.id}`, origin), {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) !== item.size) {
        await response.body?.cancel();
        throw new Error(`Could not download ${item.name} (HTTP ${response.status})`);
      }
      const temporary = `${destination}.download`;
      let size = 0;
      const limit = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > item.size) return callback(new Error('Downloaded media exceeded its expected size'));
          callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(temporary));
        if (size !== item.size) throw new Error('Downloaded media was incomplete');
        await rename(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
  };
}
