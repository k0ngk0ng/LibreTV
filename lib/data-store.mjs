import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const SCRYPT_OPTIONS = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

const PASSWORD_KEY_LENGTH = 64;

export function validateUsername(username) {
  const value = String(username || '').normalize('NFKC').trim();
  if (value.length < 3 || value.length > 32) return '用户名长度需要在 3 到 32 个字符之间';
  if (!/^[\p{L}\p{N}_.-]+$/u.test(value)) return '用户名只能包含文字、数字、点、下划线和连字符';
  return null;
}

export function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8 || value.length > 128) return '密码长度需要在 8 到 128 个字符之间';
  return null;
}

function normalizeUsername(username) {
  return String(username || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function scrypt(password, salt, keyLength = PASSWORD_KEY_LENGTH, options = SCRYPT_OPTIONS) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt);
  return [
    'scrypt',
    SCRYPT_OPTIONS.N,
    SCRYPT_OPTIONS.r,
    SCRYPT_OPTIONS.p,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password, encodedHash) {
  try {
    const [algorithm, n, r, p, encodedSalt, encodedKey] = String(encodedHash || '').split('$');
    if (algorithm !== 'scrypt' || !encodedSalt || !encodedKey) return false;

    const salt = Buffer.from(encodedSalt, 'base64url');
    const expectedKey = Buffer.from(encodedKey, 'base64url');
    const derivedKey = await scrypt(password, salt, expectedKey.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_OPTIONS.maxmem,
    });

    return expectedKey.length === derivedKey.length && crypto.timingSafeEqual(expectedKey, derivedKey);
  } catch {
    return false;
  }
}

function createEmptyState() {
  return {
    schemaVersion: 1,
    users: [],
    histories: {},
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function lastAdminError() {
  const error = new Error('不能停用、降级或删除最后一个管理员');
  error.code = 'LAST_ADMIN';
  return error;
}

function cleanHistoryItem(input, existing = null) {
  const now = Date.now();
  const text = (value, maxLength = 500) => String(value || '').slice(0, maxLength);
  const number = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const episodes = Array.isArray(input.episodes)
    ? input.episodes
      .filter(item => typeof item === 'string' && /^https?:\/\//i.test(item))
      .slice(0, 500)
      .map(item => item.slice(0, 4096))
    : (existing?.episodes || []);

  return {
    id: existing?.id || crypto.randomUUID(),
    title: text(input.title || existing?.title, 200),
    directVideoUrl: text(input.directVideoUrl || existing?.directVideoUrl, 4096),
    url: text(input.url || existing?.url, 8192),
    episodeIndex: Math.floor(number(input.episodeIndex, existing?.episodeIndex || 0)),
    sourceName: text(input.sourceName || existing?.sourceName, 100),
    sourceCode: text(input.sourceCode || existing?.sourceCode, 100),
    vod_id: text(input.vod_id || existing?.vod_id, 200),
    showIdentifier: text(input.showIdentifier || existing?.showIdentifier, 1000),
    playbackPosition: number(input.playbackPosition, existing?.playbackPosition || 0),
    duration: number(input.duration, existing?.duration || 0),
    episodes,
    lastSyncTime: number(input.lastSyncTime, existing?.lastSyncTime || 0) || null,
    timestamp: number(input.timestamp, now),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

export function createDataStore({ filePath, maxHistoryItems = 100 }) {
  let state = createEmptyState();
  let initialized = false;
  let mutationQueue = Promise.resolve();
  let dummyPasswordHash = null;

  async function persist() {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  }

  async function mutate(callback) {
    const operation = mutationQueue.then(async () => {
      const result = await callback(state);
      await persist();
      return result;
    });
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  async function ready() {
    if (!initialized) throw new Error('数据存储尚未初始化');
    await mutationQueue;
  }

  return {
    async init({ adminUsername, adminPassword }) {
      if (initialized) return;

      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.users)) {
          throw new Error('不支持的数据文件格式');
        }
        state = {
          schemaVersion: 1,
          users: parsed.users,
          histories: parsed.histories && typeof parsed.histories === 'object' ? parsed.histories : {},
        };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = createEmptyState();
      }

      dummyPasswordHash = await hashPassword(crypto.randomBytes(32).toString('base64url'));

      if (state.users.length === 0) {
        if (!adminPassword) {
          throw new Error('首次启动必须设置 ADMIN_PASSWORD（也兼容旧的 ADMINPASSWORD 或 PASSWORD）');
        }

        const usernameError = validateUsername(adminUsername || 'admin');
        const passwordError = validatePassword(adminPassword);
        if (usernameError || passwordError) throw new Error(usernameError || passwordError);

        const now = Date.now();
        const username = String(adminUsername || 'admin').normalize('NFKC').trim();
        const user = {
          id: crypto.randomUUID(),
          username,
          usernameKey: normalizeUsername(username),
          passwordHash: await hashPassword(adminPassword),
          role: 'admin',
          enabled: true,
          sessionVersion: 1,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: null,
        };
        state.users.push(user);
        state.histories[user.id] = [];
        await persist();
      }

      initialized = true;
    },

    async authenticate(username, password) {
      await ready();
      const usernameKey = normalizeUsername(username);
      const user = state.users.find(item => item.usernameKey === usernameKey);
      const passwordMatches = await verifyPassword(password, user?.passwordHash || dummyPasswordHash);
      if (!user || !user.enabled || !passwordMatches) return null;

      await mutate(currentState => {
        const currentUser = currentState.users.find(item => item.id === user.id);
        if (currentUser) {
          currentUser.lastLoginAt = Date.now();
          currentUser.updatedAt = Date.now();
        }
      });

      return { ...publicUser(user), sessionVersion: user.sessionVersion };
    },

    async getUserForSession(userId) {
      await ready();
      const user = state.users.find(item => item.id === userId);
      if (!user || !user.enabled) return null;
      return { ...publicUser(user), sessionVersion: user.sessionVersion };
    },

    async listUsers() {
      await ready();
      return state.users.map(publicUser).sort((a, b) => a.username.localeCompare(b.username, 'zh-CN'));
    },

    async createUser({ username, password, role = 'user', enabled = true }) {
      const usernameError = validateUsername(username);
      const passwordError = validatePassword(password);
      if (usernameError || passwordError) {
        const error = new Error(usernameError || passwordError);
        error.code = 'INVALID_USER';
        throw error;
      }
      const usernameKey = normalizeUsername(username);
      const passwordHash = await hashPassword(password);
      return mutate(currentState => {
        if (currentState.users.some(item => item.usernameKey === usernameKey)) {
          const error = new Error('用户名已存在');
          error.code = 'USERNAME_EXISTS';
          throw error;
        }

        const now = Date.now();
        const user = {
          id: crypto.randomUUID(),
          username: String(username).normalize('NFKC').trim(),
          usernameKey,
          passwordHash,
          role,
          enabled: Boolean(enabled),
          sessionVersion: 1,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: null,
        };
        currentState.users.push(user);
        currentState.histories[user.id] = [];
        return publicUser(user);
      });
    },

    async updateUser(userId, updates) {
      if (updates.password) {
        const passwordError = validatePassword(updates.password);
        if (passwordError) {
          const error = new Error(passwordError);
          error.code = 'INVALID_USER';
          throw error;
        }
      }
      const nextPasswordHash = updates.password ? await hashPassword(updates.password) : null;
      return mutate(currentState => {
        const user = currentState.users.find(item => item.id === userId);
        if (!user) return null;

        const nextRole = updates.role || user.role;
        const nextEnabled = typeof updates.enabled === 'boolean' ? updates.enabled : user.enabled;
        const removesAdminAccess = user.role === 'admin' && user.enabled &&
          (nextRole !== 'admin' || !nextEnabled);
        if (removesAdminAccess && currentState.users.filter(item => item.enabled && item.role === 'admin').length <= 1) {
          throw lastAdminError();
        }

        if (updates.role) user.role = updates.role;
        if (typeof updates.enabled === 'boolean') user.enabled = updates.enabled;
        if (nextPasswordHash) user.passwordHash = nextPasswordHash;
        if (updates.role || typeof updates.enabled === 'boolean' || nextPasswordHash) {
          user.sessionVersion = (user.sessionVersion || 1) + 1;
        }
        user.updatedAt = Date.now();
        return publicUser(user);
      });
    },

    async deleteUser(userId) {
      return mutate(currentState => {
        const index = currentState.users.findIndex(item => item.id === userId);
        if (index === -1) return false;
        const user = currentState.users[index];
        if (user.role === 'admin' && user.enabled &&
            currentState.users.filter(item => item.enabled && item.role === 'admin').length <= 1) {
          throw lastAdminError();
        }
        currentState.users.splice(index, 1);
        delete currentState.histories[userId];
        return true;
      });
    },

    async countEnabledAdmins() {
      await ready();
      return state.users.filter(user => user.enabled && user.role === 'admin').length;
    },

    async listHistory(userId) {
      await ready();
      return clone((state.histories[userId] || []).sort((a, b) => b.timestamp - a.timestamp));
    },

    async findHistory(userId, { id, showIdentifier, sourceCode, vodId }) {
      await ready();
      const history = state.histories[userId] || [];
      const item = history.find(entry => {
        if (id) return entry.id === id;
        if (showIdentifier) return entry.showIdentifier === showIdentifier;
        if (sourceCode && vodId) {
          return entry.sourceCode === sourceCode && String(entry.vod_id) === String(vodId);
        }
        return false;
      });
      return item ? clone(item) : null;
    },

    async upsertHistory(userId, input) {
      return mutate(currentState => {
        const history = currentState.histories[userId] || [];
        const existingIndex = history.findIndex(item => {
          if (input.id && item.id === input.id) return true;
          if (input.showIdentifier && item.showIdentifier === input.showIdentifier) return true;
          return input.sourceCode && input.vod_id &&
            item.sourceCode === input.sourceCode && String(item.vod_id) === String(input.vod_id);
        });
        const existing = existingIndex >= 0 ? history[existingIndex] : null;
        const requestedTimestamp = Number(input.timestamp);
        const incomingTimestamp = Number.isFinite(requestedTimestamp) && requestedTimestamp >= 0
          ? requestedTimestamp
          : Date.now();

        // 同一个播放页可能同时触发定时、暂停、切集和页面隐藏保存。
        // 移动网络会让较早的请求晚到，旧快照不得覆盖已经保存的新进度。
        if (existing && incomingTimestamp < Number(existing.timestamp || 0)) {
          return clone(existing);
        }

        const nextItem = cleanHistoryItem({ ...input, timestamp: incomingTimestamp }, existing);

        if (!nextItem.title || (!nextItem.directVideoUrl && !nextItem.url)) {
          const error = new Error('观看记录缺少标题或播放地址');
          error.code = 'INVALID_HISTORY';
          throw error;
        }

        if (existingIndex >= 0) history.splice(existingIndex, 1);
        history.unshift(nextItem);
        if (history.length > maxHistoryItems) history.splice(maxHistoryItems);
        currentState.histories[userId] = history;
        return clone(nextItem);
      });
    },

    async deleteHistory(userId, historyId) {
      return mutate(currentState => {
        const history = currentState.histories[userId] || [];
        const nextHistory = history.filter(item => item.id !== historyId);
        currentState.histories[userId] = nextHistory;
        return nextHistory.length !== history.length;
      });
    },

    async clearHistory(userId) {
      return mutate(currentState => {
        currentState.histories[userId] = [];
      });
    },
  };
}

export { normalizeUsername };
