import fs from 'fs/promises';
import path from 'path';

const RESERVED_CODES = new Set(['__proto__', 'constructor', 'prototype']);

function configurationError(message) {
  const error = new Error(`资源站配置错误：${message}`);
  error.code = 'INVALID_SOURCE_CONFIG';
  return error;
}

function normalizeUrl(value, field, { required = true } = {}) {
  const text = String(value || '').trim();
  if (!text && !required) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error();
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw configurationError(`${field} 必须是没有账号信息的 HTTP/HTTPS URL`);
  }
}

function normalizeName(value, code) {
  const name = String(value || '').normalize('NFKC').trim();
  if (!name || name.length > 100) {
    throw configurationError(`${code}.name 长度需要在 1 到 100 个字符之间`);
  }
  if (/[<>&"'`\u0000-\u001f]/u.test(name)) {
    throw configurationError(`${code}.name 含有不允许的字符`);
  }
  return name;
}

export async function loadSourceConfig({ filePath, baseDir = process.cwd() }) {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw configurationError(`找不到文件 ${resolvedPath}`);
    if (error instanceof SyntaxError) throw configurationError(`${resolvedPath} 不是有效的 JSON`);
    throw error;
  }

  const inputSites = parsed?.sites;
  if (!inputSites || typeof inputSites !== 'object' || Array.isArray(inputSites)) {
    throw configurationError('根节点必须包含 sites 对象');
  }

  const apiSites = Object.create(null);
  for (const [code, input] of Object.entries(inputSites)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code) || RESERVED_CODES.has(code)) {
      throw configurationError(`无效的资源站代码：${code}`);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw configurationError(`${code} 必须是对象`);
    }
    if (input.enabled === false) continue;

    const site = {
      api: normalizeUrl(input.api, `${code}.api`),
      name: normalizeName(input.name, code),
    };
    const detail = normalizeUrl(input.detail, `${code}.detail`, { required: false });
    if (detail) site.detail = detail;
    if (input.adult === true) site.adult = true;
    apiSites[code] = site;
  }

  const codes = Object.keys(apiSites);
  if (codes.length === 0) throw configurationError('至少需要启用一个资源站');

  const settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
  const configuredDefaults = Array.isArray(settings.defaultSources)
    ? settings.defaultSources.map(value => String(value)).filter(code => apiSites[code])
    : [];
  const defaultSources = [...new Set(configuredDefaults)];
  if (defaultSources.length === 0) {
    defaultSources.push(...codes.filter(code => !apiSites[code].adult).slice(0, 4));
  }

  return {
    filePath: resolvedPath,
    apiSites,
    defaultSources,
    hideAdultSources: settings.hideAdultSources === true,
  };
}
