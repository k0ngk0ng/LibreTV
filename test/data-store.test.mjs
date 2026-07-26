import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDataStore } from '../lib/data-store.mjs';
import { createSessionManager } from '../lib/session-manager.mjs';

test('账户密码、用户隔离和观看记录持久化', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'libretv.json');
  const store = createDataStore({ filePath });

  await store.init({ adminUsername: 'Admin', adminPassword: 'strong-password' });
  assert.equal(await store.authenticate('admin', 'wrong-password'), null);

  const admin = await store.authenticate('ADMIN', 'strong-password');
  assert.equal(admin.username, 'Admin');
  assert.equal(admin.role, 'admin');
  const historyBaseTime = Date.now();

  const viewer = await store.createUser({
    username: 'viewer',
    password: 'viewer-password',
    role: 'user',
  });
  assert.equal((await store.authenticate('viewer', 'viewer-password')).id, viewer.id);

  const saved = await store.upsertHistory(admin.id, {
    title: '测试影片',
    directVideoUrl: 'https://example.com/episode-1.m3u8',
    sourceCode: 'test',
    vod_id: '42',
    showIdentifier: 'test_42',
    episodeIndex: 0,
    playbackPosition: 30,
    duration: 1200,
    episodes: ['https://example.com/episode-1.m3u8'],
    timestamp: historyBaseTime,
  });
  assert.equal(saved.title, '测试影片');
  assert.equal((await store.listHistory(viewer.id)).length, 0);

  const updated = await store.upsertHistory(admin.id, {
    showIdentifier: 'test_42',
    title: '测试影片',
    directVideoUrl: 'https://example.com/episode-2.m3u8',
    episodeIndex: 1,
    playbackPosition: 75,
    duration: 1200,
    timestamp: historyBaseTime + 100,
  });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.episodeIndex, 1);
  assert.deepEqual(updated.episodes, ['https://example.com/episode-1.m3u8']);

  const newest = await store.upsertHistory(admin.id, {
    showIdentifier: 'test_42',
    title: '测试影片',
    directVideoUrl: 'https://example.com/episode-17.m3u8',
    episodeIndex: 16,
    playbackPosition: 180,
    duration: 1200,
    timestamp: historyBaseTime + 300,
  });
  const stale = await store.upsertHistory(admin.id, {
    showIdentifier: 'test_42',
    title: '测试影片',
    directVideoUrl: 'https://example.com/episode-14.m3u8',
    episodeIndex: 13,
    playbackPosition: 900,
    duration: 1200,
    timestamp: historyBaseTime + 200,
  });
  assert.equal(stale.episodeIndex, 16);
  assert.equal(stale.directVideoUrl, newest.directVideoUrl);
  assert.equal((await store.listHistory(admin.id))[0].episodeIndex, 16);

  const intentionalRewatch = await store.upsertHistory(admin.id, {
    showIdentifier: 'test_42',
    title: '测试影片',
    directVideoUrl: 'https://example.com/episode-14.m3u8',
    episodeIndex: 13,
    playbackPosition: 45,
    duration: 1200,
    timestamp: historyBaseTime + 400,
  });
  assert.equal(intentionalRewatch.episodeIndex, 13);

  const reloadedStore = createDataStore({ filePath });
  await reloadedStore.init({ adminUsername: 'ignored', adminPassword: 'ignored-password' });
  assert.equal((await reloadedStore.listHistory(admin.id))[0].playbackPosition, 45);
  assert.equal((await reloadedStore.listUsers()).length, 2);
});

test('会话令牌可撤销且不接受错误令牌', () => {
  const sessions = createSessionManager({ idleTtlMs: 60_000, absoluteTtlMs: 120_000 });
  const { token, session } = sessions.create({ id: 'user-1', sessionVersion: 3 });

  assert.equal(sessions.get('invalid-token'), null);
  assert.equal(sessions.get(token).userId, 'user-1');
  assert.ok(session.csrfToken.length >= 20);

  sessions.destroyForUser('user-1');
  assert.equal(sessions.get(token), null);
});

test('数据层强制密码规则并保护最后一个管理员', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-admin-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const weakStore = createDataStore({ filePath: path.join(directory, 'weak.json') });
  await assert.rejects(
    weakStore.init({ adminUsername: 'admin', adminPassword: 'short' }),
    /密码长度需要在 8 到 128 个字符之间/,
  );

  const store = createDataStore({ filePath: path.join(directory, 'users.json') });
  await store.init({ adminUsername: 'admin', adminPassword: 'strong-password' });
  const [admin] = await store.listUsers();

  await assert.rejects(
    store.updateUser(admin.id, { role: 'user' }),
    error => error.code === 'LAST_ADMIN',
  );
  await assert.rejects(
    store.deleteUser(admin.id),
    error => error.code === 'LAST_ADMIN',
  );

  const secondAdmin = await store.createUser({
    username: 'second-admin',
    password: 'another-strong-password',
    role: 'admin',
  });
  await store.updateUser(admin.id, { role: 'user' });
  await assert.rejects(
    store.deleteUser(secondAdmin.id),
    error => error.code === 'LAST_ADMIN',
  );
});
