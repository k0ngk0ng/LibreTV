import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

test('播放器在旧共享配置缺失时仍可完成入口初始化', async () => {
  const script = await fs.readFile(new URL('../js/player.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    Artplayer: {},
    Hls: { DefaultConfig: { loader: class { load() {} } } },
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    document: { addEventListener() {} },
    fetch: async () => ({ ok: false }),
    localStorage: {
      getItem(key) {
        if (key === 'customAPIs') return '[{"name":"测试源","url":"https://example.com/api"}]';
        return null;
      },
    },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    setInterval,
    setTimeout,
    window: { addEventListener() {} },
  });

  assert.doesNotThrow(() => vm.runInContext(script, context));
  assert.equal(context.Artplayer.FULLSCREEN_WEB_IN_BODY, true);
  assert.equal(vm.runInContext('customAPIs.length', context), 0);
});

test('首页入口搭配旧 HTML 时仍可独立校验自定义资源站', async () => {
  const script = await fs.readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    API_SITES: {},
    DEFAULT_API_SOURCES: [],
    SEARCH_HISTORY_KEY: 'videoSearchHistory',
    URL,
    document: { addEventListener() {} },
    localStorage: {
      getItem(key) {
        if (key === 'customAPIs') {
          return JSON.stringify([
            { name: '危险源', url: 'https://user:password@example.com/api' },
            { name: '正常源', url: 'https://example.com/api/' },
          ]);
        }
        return null;
      },
      setItem() {},
    },
  });

  assert.doesNotThrow(() => vm.runInContext(script, context));
  assert.equal(vm.runInContext('customAPIs.length', context), 1);
  assert.equal(vm.runInContext('customAPIs[0].url', context), 'https://example.com/api');
});

test('共享配置缺少服务端注入时降级为空资源站而不抛异常', async () => {
  const script = await fs.readFile(new URL('../js/app-config.js', import.meta.url), 'utf8');
  const errors = [];
  const context = vm.createContext({
    console: { error: message => errors.push(message) },
    localStorage: { getItem() { return null; } },
    URL,
    window: {},
  });

  assert.doesNotThrow(() => vm.runInContext(script, context));
  assert.equal(errors.length, 1);
});

test('自定义资源站忽略带账号信息的 URL', async () => {
  const script = await fs.readFile(new URL('../js/source-storage.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    localStorage: {
      getItem() {
        return JSON.stringify([
          { name: '危险源', url: 'https://user:password@example.com/api' },
          { name: '正常源', url: 'https://example.com/api/', detail: 'https://user:password@example.com/detail' },
        ]);
      },
    },
    URL,
  });

  vm.runInContext(script, context);
  const apis = vm.runInContext('getStoredCustomApis()', context);
  assert.equal(apis.length, 1);
  assert.equal(apis[0].url, 'https://example.com/api');
  assert.equal(apis[0].detail, '');
});
