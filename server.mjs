import crypto from 'crypto';
import dns from 'dns/promises';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

import axios from 'axios';
import dotenv from 'dotenv';
import express from 'express';

import {
  createDataStore,
  normalizeUsername,
  validatePassword,
  validateUsername,
} from './lib/data-store.mjs';
import { createSessionManager } from './lib/session-manager.mjs';

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function resolveGitDirectory() {
  const dotGitPath = path.join(__dirname, '.git');
  try {
    const stat = fs.statSync(dotGitPath);
    if (stat.isDirectory()) return dotGitPath;
    const pointer = fs.readFileSync(dotGitPath, 'utf8').trim();
    if (pointer.startsWith('gitdir:')) {
      return path.resolve(__dirname, pointer.slice('gitdir:'.length).trim());
    }
  } catch {
    return null;
  }
  return null;
}

function readGitCommit() {
  const candidates = [
    process.env.GIT_COMMIT,
    process.env.COMMIT_SHA,
    process.env.RENDER_GIT_COMMIT,
    process.env.VERCEL_GIT_COMMIT_SHA,
  ];
  const environmentCommit = candidates.find(value => /^[0-9a-f]{7,40}$/i.test(String(value || '').trim()));
  if (environmentCommit) return environmentCommit.trim().toLowerCase();

  const gitDirectory = resolveGitDirectory();
  if (!gitDirectory) return null;

  try {
    const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
    if (!head.startsWith('ref:')) return null;

    const reference = head.slice('ref:'.length).trim();
    const looseReferencePath = path.join(gitDirectory, reference);
    if (fs.existsSync(looseReferencePath)) {
      const value = fs.readFileSync(looseReferencePath, 'utf8').trim();
      if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
    }

    const packedRefsPath = path.join(gitDirectory, 'packed-refs');
    if (fs.existsSync(packedRefsPath)) {
      const packedReference = fs.readFileSync(packedRefsPath, 'utf8')
        .split(/\r?\n/)
        .find(line => line.endsWith(` ${reference}`));
      const value = packedReference?.split(' ')[0];
      if (/^[0-9a-f]{40}$/i.test(value || '')) return value.toLowerCase();
    }
  } catch {
    return null;
  }

  return null;
}

function resolveVersion() {
  const tag = [process.env.APP_VERSION, process.env.GIT_TAG, process.env.RELEASE_TAG]
    .map(value => String(value || '').trim())
    .find(value => /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value));
  if (tag) return { version: tag, source: 'tag' };

  try {
    const buildVersion = fs.readFileSync(path.join(__dirname, '.build-version'), 'utf8').trim();
    if (/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(buildVersion)) {
      return { version: buildVersion, source: 'tag' };
    }
    if (/^[0-9a-f]{7,40}(?:-dirty)?$/i.test(buildVersion)) {
      const dirty = buildVersion.endsWith('-dirty');
      const commit = buildVersion.replace(/-dirty$/, '').toLowerCase();
      return { version: `${commit.slice(0, 12)}${dirty ? '-dirty' : ''}`, source: 'commit', commit };
    }
  } catch {
    // 非 Docker 开发环境继续读取 Git 元数据。
  }

  const commit = readGitCommit();
  if (commit) return { version: commit.slice(0, 12), source: 'commit', commit };

  try {
    const packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return { version: `v${packageInfo.version}`, source: 'package' };
  } catch {
    return { version: 'unknown', source: 'unknown' };
  }
}

const config = {
  port: positiveInteger(process.env.PORT, 8080),
  dataFile: process.env.DATA_FILE || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'libretv.json'),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || process.env.ADMINPASSWORD || process.env.PASSWORD || '',
  requestTimeout: positiveInteger(process.env.REQUEST_TIMEOUT, 15000),
  maxRetries: positiveInteger(process.env.MAX_RETRIES, 2),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  debug: booleanValue(process.env.DEBUG),
  trustProxy: booleanValue(process.env.TRUST_PROXY, true),
  cookieSecure: String(process.env.COOKIE_SECURE || 'auto').toLowerCase(),
  sessionIdleTtlMs: positiveInteger(process.env.SESSION_IDLE_HOURS, 168) * 60 * 60 * 1000,
  sessionAbsoluteTtlMs: positiveInteger(process.env.SESSION_MAX_DAYS, 30) * 24 * 60 * 60 * 1000,
  blockedHostnames: new Set((process.env.BLOCKED_HOSTS || 'localhost,localhost.localdomain,0.0.0.0,::1').split(',').map(item => item.trim().toLowerCase()).filter(Boolean)),
};

const versionInfo = resolveVersion();
const store = createDataStore({ filePath: config.dataFile });
await store.init({ adminUsername: config.adminUsername, adminPassword: config.adminPassword });

const sessions = createSessionManager({
  idleTtlMs: config.sessionIdleTtlMs,
  absoluteTtlMs: config.sessionAbsoluteTtlMs,
});

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

const log = (...args) => {
  if (config.debug) console.log('[DEBUG]', ...args);
};

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function requestIsSecure(req) {
  if (config.cookieSecure === 'true' || config.cookieSecure === 'always') return true;
  if (config.cookieSecure === 'false' || config.cookieSecure === 'never') return false;
  return req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
}

function sessionCookie(token, req, maxAge = sessions.cookieMaxAgeSeconds) {
  const attributes = [
    `libretv_session=${encodeURIComponent(token || '')}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (maxAge === 0) attributes.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (requestIsSecure(req)) attributes.push('Secure');
  return attributes.join('; ');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === req.get('host');
  } catch {
    return false;
  }
}

function publicSessionUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; connect-src 'self' http: https:; media-src 'self' blob: http: https:; worker-src 'self' blob:; frame-src 'self'");
  next();
});

app.use(express.json({ limit: '512kb' }));

app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', version: versionInfo.version });
});

app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(versionInfo);
});

const publicFiles = new Map([
  ['/login.html', path.join(__dirname, 'login.html')],
  ['/css/auth.css', path.join(__dirname, 'css', 'auth.css')],
  ['/js/login.js', path.join(__dirname, 'js', 'login.js')],
  ['/image/logo.png', path.join(__dirname, 'image', 'logo.png')],
  ['/image/logo-black.png', path.join(__dirname, 'image', 'logo-black.png')],
]);

app.get([...publicFiles.keys()], (req, res) => {
  res.setHeader('Cache-Control', req.path === '/login.html' ? 'no-store' : 'public, max-age=86400');
  res.sendFile(publicFiles.get(req.path));
});

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function loginAttemptKeys(req, username) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return [`${ip}:*`, `${ip}:${normalizeUsername(username)}`];
}

function loginBlocked(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  if (Date.now() - attempt.startedAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return attempt.failures >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key) {
  const current = loginAttempts.get(key);
  if (!current || Date.now() - current.startedAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { failures: 1, startedAt: Date.now() });
  } else {
    current.failures += 1;
  }
}

app.post('/api/auth/login', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!sameOrigin(req)) return res.status(403).json({ error: '请求来源无效' });

  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  const keys = loginAttemptKeys(req, username);

  if (keys.some(loginBlocked)) {
    return res.status(429).json({ error: '登录失败次数过多，请 15 分钟后再试' });
  }

  const user = await store.authenticate(username, password);
  if (!user) {
    keys.forEach(recordLoginFailure);
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  keys.forEach(key => loginAttempts.delete(key));
  sessions.destroy(parseCookies(req.get('cookie')).libretv_session);
  const { token, session } = sessions.create(user);
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  return res.json({ user: publicSessionUser(user), csrfToken: session.csrfToken });
});

async function authenticateRequest(req, res, next) {
  const cookies = parseCookies(req.get('cookie'));
  const token = cookies.libretv_session;
  const session = sessions.get(token);
  const user = session ? await store.getUserForSession(session.userId) : null;

  if (session && user && user.sessionVersion === session.sessionVersion) {
    req.auth = { token, session, user };
    res.setHeader('Vary', 'Cookie');
    if (req.path.startsWith('/api/') || req.path.endsWith('.html') || req.path === '/') {
      res.setHeader('Cache-Control', 'private, no-store');
    }
    return next();
  }

  if (token) {
    sessions.destroy(token);
    res.setHeader('Set-Cookie', sessionCookie('', req, 0));
  }

  const isPageRequest = req.method === 'GET' && (
    req.path === '/' ||
    req.path.endsWith('.html') ||
    req.path.startsWith('/s=')
  );
  if (isPageRequest) {
    return res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ error: '登录已失效，请重新登录' });
}

function requireCsrf(req, res, next) {
  if (!sameOrigin(req) || !safeEqual(req.get('x-csrf-token'), req.auth?.session?.csrfToken)) {
    return res.status(403).json({ error: '安全校验失败，请刷新页面后重试' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (req.auth.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  return next();
}

app.use(authenticateRequest);

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicSessionUser(req.auth.user), csrfToken: req.auth.session.csrfToken });
});

app.post('/api/auth/logout', requireCsrf, (req, res) => {
  sessions.destroy(req.auth.token);
  res.setHeader('Set-Cookie', sessionCookie('', req, 0));
  res.status(204).end();
});

app.get('/api/history', async (req, res) => {
  res.json({ items: await store.listHistory(req.auth.user.id) });
});

app.get('/api/history/lookup', async (req, res) => {
  const item = await store.findHistory(req.auth.user.id, {
    id: req.query.id,
    showIdentifier: req.query.showIdentifier,
    sourceCode: req.query.source,
    vodId: req.query.vodId,
  });
  res.json({ item });
});

app.post('/api/history', requireCsrf, async (req, res) => {
  try {
    const item = await store.upsertHistory(req.auth.user.id, req.body || {});
    res.json({ item });
  } catch (error) {
    if (error.code === 'INVALID_HISTORY') return res.status(400).json({ error: error.message });
    throw error;
  }
});

app.delete('/api/history/:id', requireCsrf, async (req, res) => {
  const deleted = await store.deleteHistory(req.auth.user.id, req.params.id);
  res.status(deleted ? 204 : 404).end();
});

app.delete('/api/history', requireCsrf, async (req, res) => {
  await store.clearHistory(req.auth.user.id);
  res.status(204).end();
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  res.json({ users: await store.listUsers() });
});

app.post('/api/admin/users', requireAdmin, requireCsrf, async (req, res) => {
  const usernameError = validateUsername(req.body?.username);
  const passwordError = validatePassword(req.body?.password);
  if (usernameError || passwordError) return res.status(400).json({ error: usernameError || passwordError });

  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  try {
    const user = await store.createUser({
      username: req.body.username,
      password: req.body.password,
      role,
      enabled: req.body.enabled !== false,
    });
    res.status(201).json({ user });
  } catch (error) {
    if (error.code === 'USERNAME_EXISTS') return res.status(409).json({ error: error.message });
    throw error;
  }
});

app.patch('/api/admin/users/:id', requireAdmin, requireCsrf, async (req, res) => {
  const users = await store.listUsers();
  const target = users.find(user => user.id === req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });

  const updates = {};
  if (req.body?.role !== undefined) {
    if (!['admin', 'user'].includes(req.body.role)) return res.status(400).json({ error: '角色无效' });
    updates.role = req.body.role;
  }
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  if (req.body?.password) {
    const passwordError = validatePassword(req.body.password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    updates.password = String(req.body.password);
  }

  const removesAdminAccess = target.role === 'admin' && target.enabled &&
    (updates.role === 'user' || updates.enabled === false);
  if (removesAdminAccess && await store.countEnabledAdmins() <= 1) {
    return res.status(400).json({ error: '不能停用或降级最后一个管理员' });
  }
  if (target.id === req.auth.user.id && (updates.role === 'user' || updates.enabled === false)) {
    return res.status(400).json({ error: '不能停用或降级当前登录的管理员' });
  }

  try {
    const user = await store.updateUser(target.id, updates);
    if (Object.keys(updates).length > 0) sessions.destroyForUser(target.id);
    res.json({ user });
  } catch (error) {
    if (error.code === 'LAST_ADMIN') return res.status(400).json({ error: error.message });
    throw error;
  }
});

app.delete('/api/admin/users/:id', requireAdmin, requireCsrf, async (req, res) => {
  const users = await store.listUsers();
  const target = users.find(user => user.id === req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.id === req.auth.user.id) return res.status(400).json({ error: '不能删除当前登录用户' });
  if (target.role === 'admin' && target.enabled && await store.countEnabledAdmins() <= 1) {
    return res.status(400).json({ error: '不能删除最后一个管理员' });
  }

  try {
    await store.deleteUser(target.id);
    sessions.destroyForUser(target.id);
    res.status(204).end();
  } catch (error) {
    if (error.code === 'LAST_ADMIN') return res.status(400).json({ error: error.message });
    throw error;
  }
});

function isPrivateIp(address) {
  let value = String(address || '').toLowerCase();
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);

  if (net.isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }

  if (net.isIP(value) === 6) {
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
  }

  return true;
}

async function assertSafeRemoteUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw Object.assign(new Error('无效的 URL'), { statusCode: 400 });
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error('不允许的 URL'), { statusCode: 400 });
  }

  const hostname = parsed.hostname.toLowerCase();
  if (config.blockedHostnames.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw Object.assign(new Error('目标地址不允许访问'), { statusCode: 403 });
  }

  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(item => isPrivateIp(item.address))) {
    throw Object.assign(new Error('目标地址不允许访问'), { statusCode: 403 });
  }

  return { parsed, addresses };
}

async function requestRemote(urlString, { headers = {}, responseType = 'stream', redirects = 0 } = {}) {
  const { parsed, addresses } = await assertSafeRemoteUrl(urlString);
  const lookup = (hostname, options, callback) => {
    const normalizedOptions = typeof options === 'number' ? { family: options } : (options || {});
    const requestedFamily = Number(normalizedOptions.family || 0);
    const candidates = addresses
      .map(item => ({ address: item.address, family: net.isIP(item.address) }))
      .filter(item => !requestedFamily || item.family === requestedFamily);
    if (candidates.length === 0) {
      callback(new Error('没有可用的安全目标地址'));
      return;
    }
    if (normalizedOptions.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  };
  const agentOptions = { keepAlive: false, lookup };
  const response = await axios({
    method: 'get',
    url: parsed.toString(),
    responseType,
    timeout: config.requestTimeout,
    maxRedirects: 0,
    proxy: false,
    httpAgent: new http.Agent(agentOptions),
    httpsAgent: new https.Agent(agentOptions),
    validateStatus: () => true,
    headers: {
      'User-Agent': config.userAgent,
      Accept: '*/*',
      Referer: parsed.hostname.endsWith('doubanio.com') ? 'https://movie.douban.com/' : parsed.origin,
      ...headers,
    },
  });

  if (response.status >= 300 && response.status < 400 && response.headers.location) {
    response.data?.destroy?.();
    if (redirects >= 5) throw Object.assign(new Error('远程地址重定向次数过多'), { statusCode: 502 });
    const redirectUrl = new URL(response.headers.location, parsed).toString();
    return requestRemote(redirectUrl, { headers, responseType, redirects: redirects + 1 });
  }

  if (response.status < 200 || response.status >= 300) {
    response.data?.destroy?.();
    throw Object.assign(new Error(`远程请求失败 (${response.status})`), { statusCode: response.status >= 400 && response.status < 500 ? response.status : 502 });
  }

  return response;
}

function forwardResponseHeaders(response, res, cacheControl = null) {
  const allowedHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
  for (const header of allowedHeaders) {
    if (response.headers[header]) res.setHeader(header, response.headers[header]);
  }
  res.setHeader('Cache-Control', cacheControl || 'private, no-store');
  res.setHeader('Vary', 'Cookie');
}

app.get('/api/image', async (req, res) => {
  const { parsed } = await assertSafeRemoteUrl(String(req.query.url || ''));
  const hostname = parsed.hostname.toLowerCase();
  const isDoubanImage = hostname === 'doubanio.com' || hostname.endsWith('.doubanio.com') || hostname === 'douban.com' || hostname.endsWith('.douban.com');
  if (!isDoubanImage) return res.status(400).json({ error: '只允许代理豆瓣图片' });

  const response = await requestRemote(parsed.toString(), {
    headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
  });
  forwardResponseHeaders(response, res, 'private, max-age=86400');
  response.data.pipe(res);
});

app.get('/proxy/:encodedUrl', async (req, res) => {
  let targetUrl = req.params.encodedUrl;
  if (!/^https?:\/\//i.test(targetUrl)) {
    try {
      targetUrl = decodeURIComponent(targetUrl);
    } catch {
      return res.status(400).json({ error: '无效的 URL 编码' });
    }
  }

  let lastError;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      const headers = {};
      if (req.get('range')) headers.Range = req.get('range');
      if (req.get('accept')) headers.Accept = req.get('accept');
      const response = await requestRemote(targetUrl, { headers });
      forwardResponseHeaders(response, res);
      res.status(response.status);
      response.data.pipe(res);
      return;
    } catch (error) {
      lastError = error;
      if (error.statusCode && error.statusCode < 500) break;
      log(`代理请求重试 ${attempt + 1}/${config.maxRetries + 1}:`, targetUrl, error.message);
    }
  }

  const status = lastError?.statusCode || 502;
  return res.status(status).json({ error: lastError?.message || '代理请求失败' });
});

app.use('/data', (req, res) => res.status(404).end());

const pageFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/player.html', 'player.html'],
  ['/watch.html', 'watch.html'],
  ['/about.html', 'about.html'],
  ['/privacy.html', 'privacy.html'],
  ['/admin.html', 'admin.html'],
]);

app.get([...pageFiles.keys()], (req, res) => {
  if (req.path === '/admin.html' && req.auth.user.role !== 'admin') return res.status(403).send('需要管理员权限');
  return res.sendFile(path.join(__dirname, pageFiles.get(req.path)));
});

app.get('/s=:keyword', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

for (const directory of ['css', 'js', 'libs', 'image']) {
  app.use(`/${directory}`, express.static(path.join(__dirname, directory), {
    maxAge: config.cacheMaxAge,
    fallthrough: false,
    dotfiles: 'deny',
  }));
}

for (const file of ['manifest.json', 'robots.txt', 'service-worker.js']) {
  app.get(`/${file}`, (req, res) => res.sendFile(path.join(__dirname, file)));
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('服务器错误:', error.message);
  const status = error.statusCode || 500;
  if (req.path.startsWith('/api/') || req.path.startsWith('/proxy/')) {
    return res.status(status).json({ error: status >= 500 ? '服务器内部错误' : error.message });
  }
  return res.status(status).send(status >= 500 ? '服务器内部错误' : error.message);
});

app.use((req, res) => res.status(404).send('页面未找到'));

app.listen(config.port, () => {
  console.log(`LibreTV ${versionInfo.version} 运行在 http://localhost:${config.port}`);
  console.log(`账户数据保存在 ${config.dataFile}`);
  if (config.debug) console.log('调试模式已启用');
});
