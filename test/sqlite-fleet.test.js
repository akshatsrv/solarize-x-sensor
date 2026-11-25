import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openSqliteFleet } from '../lib/sqlite-fleet.js';

async function collect(stream) {
  const output = [];
  for await (const chunk of stream) output.push(chunk);
  return Buffer.concat(output);
}

test('migrates existing kiosk configuration and media, persists edits and streams ranges from SQLite', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sqlite-fleet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = '5619222d-93d2-4664-bdd4-fb8f627388c5';
  const bytes = Buffer.alloc(600000, 42);
  bytes[262143] = 99;
  bytes[262144] = 11;
  const legacy = {
    enabled: true, defaults: { playlist: [id] },
    devices: { lobby: { label: 'Live kiosk' } },
    accounts: { operator1: { role: 'operator', hash: 'stored-hash' } },
    media: { [id]: { id, name: 'Video.mp4', type: 'video/mp4', size: bytes.length } },
  };
  await mkdir(join(dir, 'media'));
  await writeFile(join(dir, 'fleet.json'), JSON.stringify(legacy));
  await writeFile(join(dir, 'media', id), bytes);

  const fleet = await openSqliteFleet(dir, { playlist: [] });
  assert.equal(fleet.state.devices.lobby.label, 'Live kiosk');
  assert.equal(fleet.state.accounts.operator1.role, 'operator');
  assert.deepEqual(await collect(fleet.streamMedia(id, 262140, 262147)), bytes.subarray(262140, 262148));
  await fleet.update(state => { state.enabled = false; });
  fleet.close();

  const restarted = await openSqliteFleet(dir, { playlist: [] });
  assert.equal(restarted.state.enabled, false);
  assert.equal(JSON.parse(await readFile(join(dir, 'fleet.json'), 'utf8')).enabled, true);
  await restarted.update(state => { delete state.media[id]; });
  restarted.close();
  const inspect = new DatabaseSync(join(dir, 'fleet.sqlite'), { readOnly: true });
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM media_chunks').get().count, 0);
  inspect.close();
});

test('an incomplete new asset rolls back both its metadata and payload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sqlite-fleet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = '5619222d-93d2-4664-bdd4-fb8f627388c5';
  const fleet = await openSqliteFleet(dir, { playlist: [] });
  try {
    await assert.rejects(fleet.addMedia({ id, size: 3 }, () => [Buffer.from('xx')], () => {}), /incomplete/);
    assert.equal(fleet.state.media[id], undefined);
    await fleet.addMedia({ id, size: 3 }, () => [Buffer.from('abc')], () => {});
    assert.equal((await collect(fleet.streamMedia(id, 0, 2))).toString(), 'abc');
  } finally {
    fleet.close();
  }
});
