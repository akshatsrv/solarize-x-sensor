import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { link, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const destination = process.argv[2];
if (!destination) throw new Error('Pass a new backup file path.');
const source = resolve(process.env.SERVER_DATA_DIR || 'data', 'fleet.sqlite');
const output = resolve(destination);
const temporary = output + '.' + randomUUID() + '.tmp';
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, temporary);
  await link(temporary, output);
  console.log(`Backup saved to ${output}`);
} finally {
  db.close();
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
