import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

test('旧播放器入口会加载新的物理脚本并保留版本参数', async () => {
  const script = await fs.readFile(new URL('../js/player-runtime.js', import.meta.url), 'utf8');
  const appendedScripts = [];
  const context = vm.createContext({
    URL,
    document: {
      baseURI: 'http://localhost/player.html',
      currentScript: { src: 'http://localhost/js/player-runtime.js?v=abc123' },
      createElement() { return {}; },
      head: { appendChild(element) { appendedScripts.push(element); } },
    },
    window: {},
  });

  vm.runInContext(script, context);
  assert.equal(appendedScripts.length, 1);
  assert.equal(appendedScripts[0].src, 'http://localhost/js/player-runtime-sync.js?v=abc123');
  assert.equal(appendedScripts[0].async, false);
});

test('播放器在旧共享配置缺失时仍可完成入口初始化', async () => {
  const script = await fs.readFile(new URL('../js/player-runtime-sync.js', import.meta.url), 'utf8');
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

test('切换下一集时不会把旧媒体的暂停进度保存到新集', async () => {
  const script = await fs.readFile(new URL('../js/player-runtime-sync.js', import.meta.url), 'utf8');
  const savedItems = [];
  const location = new URL('http://localhost/player.html?url=https%3A%2F%2Fexample.com%2Fepisode-1.m3u8&index=0&position=125');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        checked: false,
        classList: { add() {}, remove() {}, toggle() {} },
        innerHTML: '',
        removeAttribute() {},
        setAttribute() {},
        style: {},
        textContent: '',
      });
    }
    return elements.get(id);
  };
  const window = {
    addEventListener() {},
    history: {
      replaceState(_state, _title, nextUrl) {
        location.href = new URL(nextUrl, location.href).href;
      },
    },
    location,
  };
  const context = vm.createContext({
    API_SITES: {},
    Auth: {
      async fetch(_url, init) {
        const item = JSON.parse(init.body);
        savedItems.push(structuredClone(item));
        return { ok: true, async json() { return { item }; } };
      },
    },
    Artplayer: {},
    Hls: { DefaultConfig: { loader: class { load() {} } } },
    PlaybackState: { get() { return null; }, update() {} },
    URL,
    URLSearchParams,
    clearInterval() {},
    clearTimeout() {},
    console,
    document: {
      addEventListener() {},
      getElementById: element,
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    setInterval() { return 1; },
    setTimeout() { return 1; },
    window,
  });

  vm.runInContext(script, context);
  vm.runInContext(`
    currentVideoTitle = '测试剧集';
    currentEpisodes = [
      'https://example.com/episode-1.m3u8',
      'https://example.com/episode-2.m3u8',
    ];
    currentEpisodeIndex = 0;
    currentVideoUrl = currentEpisodes[0];
    activeMediaContext = {
      generation: 0,
      videoUrl: currentEpisodes[0],
      episodeIndex: 0,
    };
    art = {
      video: { paused: false, currentTime: 125, duration: 1200 },
      set switch(url) {
        this.video.paused = true;
        saveCurrentProgress({ type: 'pause' });
      },
    };
    playEpisode(1);
    saveCurrentProgress({ type: 'visibilitychange' });
  `, context);

  assert.equal(savedItems.length, 1);
  assert.equal(savedItems[0].directVideoUrl, 'https://example.com/episode-1.m3u8');
  assert.equal(savedItems[0].episodeIndex, 0);
  assert.equal(savedItems[0].playbackPosition, 125);
  assert.equal(vm.runInContext('currentEpisodeIndex', context), 1);
  assert.equal(vm.runInContext('currentVideoUrl', context), 'https://example.com/episode-2.m3u8');
  assert.equal(location.searchParams.has('position'), false);
});

test('播放器会等待旧进度保存完成再发送新集数', async () => {
  const script = await fs.readFile(new URL('../js/player-runtime-sync.js', import.meta.url), 'utf8');
  const requests = [];
  const location = new URL('http://localhost/player.html?source=test&id=42');
  let releaseFirstRequest;
  const firstRequest = new Promise(resolve => { releaseFirstRequest = resolve; });
  const context = vm.createContext({
    API_SITES: { test: { name: '测试源' } },
    Auth: {
      async fetch(_url, init) {
        const item = JSON.parse(init.body);
        requests.push(structuredClone(item));
        if (requests.length === 1) await firstRequest;
        return { ok: true, async json() { return { item }; } };
      },
    },
    Artplayer: {},
    Hls: { DefaultConfig: { loader: class { load() {} } } },
    PlaybackState: {
      get() { return { sourceCode: 'test', sourceName: '测试源', vodId: '42' }; },
      update() {},
    },
    URL,
    URLSearchParams,
    clearInterval() {},
    clearTimeout() {},
    console,
    document: { addEventListener() {}, readyState: 'loading' },
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    setInterval() { return 1; },
    setTimeout() { return 1; },
    window: { addEventListener() {}, location },
  });

  vm.runInContext(script, context);
  vm.runInContext(`
    currentVideoTitle = '测试剧集';
    currentEpisodes = [
      'https://example.com/episode-14.m3u8',
      'https://example.com/episode-17.m3u8',
    ];
    playbackLoadGeneration = 0;
    activeMediaContext = { generation: 0, videoUrl: currentEpisodes[0], episodeIndex: 13 };
    art = { video: { currentTime: 900, duration: 1200 } };
    saveCurrentProgress();

    playbackLoadGeneration = 1;
    activeMediaContext = { generation: 1, videoUrl: currentEpisodes[1], episodeIndex: 16 };
    art = { video: { currentTime: 180, duration: 1200 } };
    saveCurrentProgress();
  `, context);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].episodeIndex, 13);
  releaseFirstRequest();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(requests.length, 2);
  assert.equal(requests[1].episodeIndex, 16);
  assert.ok(requests[1].timestamp > requests[0].timestamp);
});

test('播放器保存失败后会重试最新集数', async () => {
  const script = await fs.readFile(new URL('../js/player-runtime-sync.js', import.meta.url), 'utf8');
  const requests = [];
  const retryTimers = [];
  const location = new URL('http://localhost/player.html?source=test&id=42');
  let requestCount = 0;
  const context = vm.createContext({
    API_SITES: { test: { name: '测试源' } },
    Auth: {
      async fetch(_url, init) {
        const item = JSON.parse(init.body);
        requests.push(structuredClone(item));
        requestCount += 1;
        if (requestCount === 1) throw new Error('临时网络失败');
        return { ok: true, async json() { return { item }; } };
      },
    },
    Artplayer: {},
    Hls: { DefaultConfig: { loader: class { load() {} } } },
    PlaybackState: {
      get() { return { sourceCode: 'test', sourceName: '测试源', vodId: '42' }; },
      update() {},
    },
    URL,
    URLSearchParams,
    clearInterval() {},
    clearTimeout(id) {
      const timer = retryTimers.find(item => item.id === id);
      if (timer) timer.cancelled = true;
    },
    console: { ...console, warn() {} },
    document: {
      addEventListener() {},
      readyState: 'loading',
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    setInterval() { return 1; },
    setTimeout(callback, delay) {
      const timer = { id: retryTimers.length + 1, callback, delay, cancelled: false };
      retryTimers.push(timer);
      return timer.id;
    },
    window: { addEventListener() {}, location },
  });

  vm.runInContext(script, context);
  vm.runInContext(`
    currentVideoTitle = '测试剧集';
    currentEpisodes = [
      'https://example.com/episode-14.m3u8',
      'https://example.com/episode-17.m3u8',
    ];
    playbackLoadGeneration = 0;
    activeMediaContext = {
      generation: 0,
      videoUrl: currentEpisodes[0],
      episodeIndex: 13,
    };
    art = { video: { currentTime: 900, duration: 1200 } };
    saveCurrentProgress();
  `, context);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].episodeIndex, 13);
  const retryTimer = retryTimers.find(item => item.delay === 1000 && !item.cancelled);
  assert.ok(retryTimer);

  vm.runInContext(`
    playbackLoadGeneration = 1;
    activeMediaContext = {
      generation: 1,
      videoUrl: currentEpisodes[1],
      episodeIndex: 16,
    };
    art = { video: { currentTime: 180, duration: 1200 } };
    saveCurrentProgress();
  `, context);
  retryTimer.callback();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(requests.length, 2);
  assert.equal(requests[1].episodeIndex, 16);
  assert.ok(requests[1].timestamp > requests[0].timestamp);
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
