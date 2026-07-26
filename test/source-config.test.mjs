import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSourceConfig } from '../lib/source-config.mjs';

test('仓库示例配置可作为最小回退配置加载', async () => {
  const filePath = fileURLToPath(new URL('../config/sites.example.json', import.meta.url));
  const config = await loadSourceConfig({ filePath });

  assert.deepEqual(Object.keys(config.apiSites), ['example']);
  assert.deepEqual(config.defaultSources, ['example']);
  assert.equal(config.apiSites.example.api, 'https://example.invalid/api.php/provide/vod');
});

test('从独立 JSON 文件加载、筛选并排序资源站', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-sources-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'sites.json');
  await fs.writeFile(filePath, JSON.stringify({
    settings: {
      defaultSources: ['second', 'missing', 'first', 'second'],
      hideAdultSources: true,
    },
    sites: {
      first: { api: 'https://first.example/api', name: '第一源' },
      second: { api: 'https://second.example/api/', name: '第二源', detail: 'https://second.example/' },
      disabled: { api: 'https://disabled.example/api', name: '已停用', enabled: false },
    },
  }));

  const config = await loadSourceConfig({ filePath });
  assert.deepEqual(Object.keys(config.apiSites), ['first', 'second']);
  assert.deepEqual(config.defaultSources, ['second', 'first']);
  assert.equal(config.apiSites.second.api, 'https://second.example/api');
  assert.equal(config.apiSites.second.detail, 'https://second.example');
  assert.equal(config.hideAdultSources, true);
});

test('拒绝危险或无效的资源站配置', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-invalid-sources-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const invalidJson = path.join(directory, 'invalid-json.json');
  await fs.writeFile(invalidJson, '{');
  await assert.rejects(loadSourceConfig({ filePath: invalidJson }), /不是有效的 JSON/);

  const invalidUrl = path.join(directory, 'invalid-url.json');
  await fs.writeFile(invalidUrl, JSON.stringify({
    sites: { bad: { api: 'file:///etc/passwd', name: '错误源' } },
  }));
  await assert.rejects(loadSourceConfig({ filePath: invalidUrl }), /HTTP\/HTTPS URL/);

  const invalidName = path.join(directory, 'invalid-name.json');
  await fs.writeFile(invalidName, JSON.stringify({
    sites: { bad: { api: 'https://example.com/api', name: '<script>' } },
  }));
  await assert.rejects(loadSourceConfig({ filePath: invalidName }), /不允许的字符/);
});
