import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const tables = ['devices', 'accounts', 'schedules', 'media'];
const blockSize = 256 * 1024;

function mediaKey(id) {
  return /^[a-f0-9-]{36}$/.test(id);
}

export async function openSqliteFleet(dataDir, defaults) {
  const databasePath = join(dataDir, 'fleet.sqlite');
  const uploadDir = join(dataDir, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS fleet_configuration (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
    ${tables.map(table => `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`).join('\n')}
    CREATE TABLE IF NOT EXISTS audit_events (position INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS playback_events (
      sequence INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, kiosk TEXT NOT NULL,
      time INTEGER NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, schedule TEXT
    );
    CREATE INDEX IF NOT EXISTS playback_by_kiosk ON playback_events (kiosk, sequence DESC);
    CREATE TABLE IF NOT EXISTS media_chunks (
      media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      offset INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY (media_id, offset)
    ) WITHOUT ROWID;
  `);
  const saveConfiguration = db.prepare(`
    INSERT INTO fleet_configuration (id, payload) VALUES (1, ?)
    ON CONFLICT (id) DO UPDATE SET payload = excluded.payload
  `);
  const insertEvent = db.prepare('INSERT INTO audit_events (position, payload) VALUES (?, ?)');
  const insertChunk = db.prepare('INSERT INTO media_chunks (media_id, offset, bytes) VALUES (?, ?, ?)');
  const insertProof = db.prepare('INSERT INTO playback_events (id, kiosk, time, name, state, schedule) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING');
  const recentProof = db.prepare('SELECT kiosk, time, name, state, schedule FROM playback_events ORDER BY sequence DESC LIMIT ?');
  const kioskProof = db.prepare('SELECT kiosk, time, name, state, schedule FROM playback_events WHERE kiosk = ? ORDER BY sequence DESC LIMIT ?');
  const statements = Object.fromEntries(tables.map(table => [table, {
    list: db.prepare(`SELECT id, payload FROM ${table} ORDER BY rowid`),
    save: db.prepare(`INSERT INTO ${table} (id, payload) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload`),
    remove: db.prepare(`DELETE FROM ${table} WHERE id = ?`),
  }]));
  const fresh = { enabled: false, defaults, devices: {}, accounts: {}, schedules: {}, media: {}, events: [] };

  function saveState(next, previous) {
    if (!previous || next.enabled !== previous.enabled || JSON.stringify(next.defaults) !== JSON.stringify(previous.defaults)) {
      saveConfiguration.run(JSON.stringify({ enabled: next.enabled, defaults: next.defaults }));
    }
    for (const table of tables) {
      const { save, remove } = statements[table];
      const prior = previous?.[table] ?? {};
      for (const [id, value] of Object.entries(next[table])) {
        const payload = JSON.stringify(value);
        if (!Object.hasOwn(prior, id) || payload !== JSON.stringify(prior[id])) save.run(id, payload);
      }
      for (const id of Object.keys(prior)) {
        if (!Object.hasOwn(next[table], id)) remove.run(id);
      }
    }
    if (!previous || JSON.stringify(next.events) !== JSON.stringify(previous.events)) {
      db.exec('DELETE FROM audit_events');
      next.events.forEach((event, index) => insertEvent.run(index, JSON.stringify(event)));
    }
  }

  async function writeChunks(entry, source) {
    let offset = 0;
    for await (const block of source) {
      if (offset + block.length > entry.size) throw new Error('Media size changed during import.');
      insertChunk.run(entry.id, offset, block);
      offset += block.length;
    }
    if (offset !== entry.size) throw new Error('Media was incomplete.');
  }

  async function transaction(write) {
    db.exec('BEGIN IMMEDIATE');
    try {
      await write();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const persisted = db.prepare('SELECT payload FROM fleet_configuration WHERE id = 1').get();
  let state = fresh;
  try {
    if (persisted) {
      state = { ...state, ...JSON.parse(persisted.payload) };
      for (const table of tables) {
        state[table] = Object.fromEntries(statements[table].list.all().map(row => [row.id, JSON.parse(row.payload)]));
      }
      state.events = db.prepare('SELECT payload FROM audit_events ORDER BY position').all().map(row => JSON.parse(row.payload));
    } else {
      let legacy;
      try {
        legacy = JSON.parse(await readFile(join(dataDir, 'fleet.json'), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      state = { ...state, ...legacy };
      if (typeof state.enabled !== 'boolean') throw new Error('Invalid persisted fleet state.');
      await transaction(async () => {
        saveState(state);
        for (const [id, entry] of Object.entries(state.media)) {
          if (entry.id !== id || !mediaKey(id)) throw new Error('Invalid legacy media identifier.');
          try {
            await writeChunks(entry, createReadStream(join(dataDir, 'media', id), { highWaterMark: blockSize }));
          } catch (error) {
            throw new Error(`Could not migrate media ${entry.name}: ${error.message}`);
          }
        }
      });
    }
  } catch (error) {
    db.close();
    throw error;
  }

  let saving = Promise.resolve();
  function queue(write) {
    const save = saving.then(write);
    saving = save.catch(() => {});
    return save;
  }

  function enqueue(edit, asset) {
    return queue(async () => {
      const next = structuredClone(state);
      if (edit(next) === false) return;
      await transaction(async () => {
        saveState(next, state);
        if (asset) await writeChunks(asset.entry, asset.source());
      });
      state = next;
    });
  }

  return {
    databasePath, uploadDir,
    get state() { return state; },
    flush() { return saving; },
    close() { db.close(); },
    update(edit) { return enqueue(edit); },
    appendProof(kiosk, events) {
      return queue(() => transaction(() => {
        for (const event of events) insertProof.run(event.id, kiosk, event.at, event.name, event.state, event.schedule);
        db.exec('DELETE FROM playback_events WHERE sequence <= (SELECT max(sequence) - 20000 FROM playback_events)');
      }));
    },
    playback(kiosk, limit) { return kiosk ? kioskProof.all(kiosk, limit) : recentProof.all(limit); },
    addMedia(entry, source, audit) {
      return enqueue(next => {
        next.media[entry.id] = entry;
        audit(next);
      }, { entry, source });
    },
    streamMedia(id, start, end) {
      return Readable.from((function* () {
        const reader = new DatabaseSync(databasePath, { readOnly: true });
        try {
          reader.exec('PRAGMA busy_timeout = 5000');
          // Chunk boundaries are stored explicitly, including short filesystem reads.
          const scan = reader.prepare(`
            SELECT offset, bytes FROM media_chunks
            WHERE media_id = ? AND offset <= ? AND offset + length(bytes) > ?
            ORDER BY offset
          `);
          let remaining = end - start + 1;
          for (const { offset, bytes } of scan.iterate(id, end, start)) {
            const piece = bytes.subarray(Math.max(0, start - offset), Math.min(bytes.length, end - offset + 1));
            remaining -= piece.length;
            yield piece;
          }
          if (remaining !== 0) throw new Error('Media changed during the download.');
        } finally {
          reader.close();
        }
      })(), { objectMode: false, highWaterMark: blockSize });
    },
  };
}
