# AGENTS.md

## Scope

This file applies to the entire repository. A more specific `AGENTS.md` in a subdirectory overrides these rules for files below it.

## Project shape

LibreTV is a self-hosted Node.js/Express video search and playback application. The customized account edition on `main` includes server-side authentication, per-user viewing history, runtime video-source configuration, Douban image proxying, tab-isolated playback state, and Docker/GHCR releases.

- Develop and release the project only from `main`.
- The account edition requires a writable persistent data directory and is supported only with Node.js or Docker.
- Vercel, Netlify, Cloudflare Pages, and similar stateless deployments intentionally return `503`.

## Important files

- `server.mjs`: Express entry point, authentication, CSRF, administration, viewing history, proxying, runtime HTML/config injection, and cache policy.
- `lib/data-store.mjs`: users, scrypt password hashes, and viewing-history persistence.
- `lib/session-manager.mjs`: in-memory sessions and CSRF tokens.
- `lib/source-config.mjs`: validation and loading for `API_CONFIG_FILE`.
- `config/sites.example.json`: committed schema example and minimal fallback configuration.
- `config/sites.json`: ignored deployment-specific video-source configuration. Never commit it or hard-code its sources back into frontend JavaScript.
- `js/source-storage.js`: shared browser helpers for locally configured custom sources.
- `js/app-config.js`: shared frontend constants and server-injected source configuration.
- `js/playback-state.js`: per-tab playback context in `sessionStorage`.
- `js/player-runtime.js`: playback, episodes, progress, and source switching.
- `js/runtime-version.js`: footer version rendering.
- `js/auth.js`: current session and authenticated CSRF requests.
- `service-worker.js`: cache cleanup only; it must not cache application files.
- `.github/workflows/docker-build.yml`: multi-architecture GHCR publishing.

Never commit `.env`, `config/sites.json`, `data/`, `.build-version`, cookies, CSRF tokens, real passwords, or production account/history data.

## Frontend script contracts

The frontend uses classic scripts without a bundler. Script order is an API contract.

Pages that search or play video must load shared dependencies before their consumers:

1. `js/auth.js`
2. `js/source-storage.js`
3. `js/app-config.js`
4. `js/playback-state.js`
5. `js/ui.js`, `js/api.js`, and `js/search.js` as needed
6. the page entry point, such as `js/app.js` or `js/player-runtime.js`

`player.html` does not load `app.js`. Therefore `player-runtime.js` must not depend on symbols defined only in `app.js`. Shared behavior belongs in a shared script and player startup must degrade safely if a nonessential shared helper is unavailable.

When adding or renaming a cross-script global, search the whole repository for collisions. Prefer an explicit `window.LibreTV...` namespace for new shared APIs.

## Static caching and upgrade compatibility

Production users may have old HTTP cache entries and the historical `libre-tv-cache-v1` Service Worker cache. A release is incomplete if it works only in a clean browser.

- Keep HTML responses `private, no-store`.
- Authenticated static resources without the current revision query must be `private, no-store`.
- Resources in a fixed build with an explicit commit revision may be `private, immutable`; source worktrees and tag-only builds must stay `no-store`.
- Use the commit hash as the asset cache key even when the displayed version is a `vX.Y.Z` tag.
- Use new physical filenames when replacing a historically cached critical script; query parameters alone are not sufficient for broken proxies or old Service Workers.
- `service-worker.js` must be served with `no-store`, use `skipWaiting`, claim clients, and delete old `libre-tv-*`/`libretv-*` caches.
- Register the Service Worker with `updateViaCache: 'none'`.
- Do not reintroduce offline/cache-first behavior without a complete versioned migration strategy.

`/VERSION.txt` is a temporary server compatibility route for old cached frontend code. Do not add a timestamp `VERSION.txt` file, do not use it as the new version source, and do not make current frontend code request it.

After shared frontend changes, test both a clean session and a deliberately mixed/legacy-cache scenario. There must be no `ReferenceError`, old `/VERSION.txt` 404, or stale `config.js` execution.

## Version rules

The server version priority is:

1. `APP_VERSION`, `GIT_TAG`, or `RELEASE_TAG` matching `vX.Y.Z`
2. the build-time `.build-version`
3. `GIT_COMMIT` or the repository commit
4. `package.json` as a development fallback

The visible page version comes from the server-injected `meta[name="libretv-version"]`; `/api/version` is the fallback API. Never restore timestamp versions.

Formal releases use strict `vX.Y.Z` tags and should match `package.json`. Only a release tag publishes that tag plus `latest`; ordinary branch pushes do not run the publishing workflow.

## Runtime video-source configuration

Runtime sources are loaded only from the ignored JSON file specified by `API_CONFIG_FILE`. Relative paths resolve from the application root. Docker deployments normally use an absolute container path and a read-only bind mount.

Configuration is read at startup; restart the service after editing it.

Validation must continue to enforce:

- at least one enabled source;
- safe source codes and rejection of prototype-pollution names;
- HTTP/HTTPS URLs without embedded credentials;
- bounded names without HTML/control characters;
- default source codes that reference enabled sources;
- safe serialization of `<`, U+2028, and U+2029.

Docker images must exclude `config/sites.json` and keep an unmounted copy of `config/sites.example.json` as a minimal fallback. Invalid custom configuration falls back by default so a mount mistake does not take down the site. `API_CONFIG_STRICT=true` intentionally changes this to fail-fast behavior.

Browser custom sources are user preferences and may remain in `localStorage`, but they must still be protocol/name/length validated. Account data and viewing history must never be stored there.

## Authentication and data-security invariants

Do not weaken these rules:

- Passwords are stored only as salted scrypt hashes.
- `PASSWORD` and `ADMINPASSWORD` exist only for first-start compatibility; they are not shared runtime passwords.
- Session cookies remain `HttpOnly`, `SameSite=Lax`, and `Secure` under HTTPS.
- Except for login essentials, health/version compatibility endpoints, and the Service Worker, pages, scripts, proxy endpoints, and business APIs require a server session.
- State-changing authenticated APIs require same-origin validation and a CSRF token.
- Administration APIs require the administrator role.
- The last enabled administrator cannot be disabled, demoted, or deleted, including under concurrent writes.
- Password, role, and enabled-state changes revoke existing user sessions.
- User identity for history operations comes only from the server session.
- Per-tab playback context uses `sessionStorage`; do not move it to shared `localStorage`.

Treat all third-party API data as untrusted. Prefer `textContent`, `createElement`, and safe attribute assignment. Do not interpolate third-party strings into `innerHTML`.

## Proxy and SSRF invariants

Changes to `/proxy/*` and `/api/image` must preserve:

- HTTP/HTTPS only;
- no URL username/password;
- rejection of localhost, private, link-local, reserved, and internal targets;
- validation of every resolved address;
- connection to the validated address to prevent DNS rebinding;
- validation of every redirect target;
- bounded redirects, timeouts, and retries;
- no system proxy bypass of validation;
- minimal forwarded headers;
- Douban-domain restriction for `/api/image`.

Add tests whenever proxy URL handling changes.

## About and site URLs

Do not hard-code `libretv.is-an.org` or invent another deployment hostname.

- Keep `SITE_CONFIG.url` empty unless the user explicitly supplies a deployment URL.
- About may link to this GitHub repository, but must not claim a default public website.
- Remove or make runtime-driven any structured data that requires an absolute deployment URL.

## Development commands

Install and run:

```bash
npm ci
cp .env.example .env
cp config/sites.example.json config/sites.json
npm run dev
```

Node.js 20 or newer is required. Docker currently uses Node.js 22 Alpine.

## Required verification

Every change must at least run:

```bash
npm test
npm audit --audit-level=low
```

After JavaScript changes, run syntax checks for `server.mjs`, `service-worker.js`, `js/*.js`, `lib/*.mjs`, `scripts/*.mjs`, and `test/*.mjs`.

### Server/authentication changes

Start with a temporary data directory and non-production port. Verify health, version, redirects/401s, login, CSRF rejection, role enforcement, last-admin protection, history isolation, session revocation, and denial of `/data/*`.

### Frontend/player changes

Browser verification is mandatory. Check:

- login/logout and no console errors;
- no undefined cross-script globals;
- search progress and results;
- details/history opening the player;
- direct playback startup, episode switching, next episode, progress saving, and source switching;
- two tabs playing different titles/episodes without state collision;
- no stale `config.js`/`version-check.js` execution;
- old Service Worker caches are deleted;
- the footer never displays `版本: 检测失败` under normal operation.

External sources can fail independently. Distinguish an upstream failure from application, authentication, or proxy failures.

### Source-configuration changes

Verify the committed example file, an absolute custom path, Docker read-only mounting, exclusion of the local `config/sites.json` from the image, fallback behavior, strict failure behavior, invalid JSON/URL/name rejection, and updated configuration after restart.

### Docker changes

Build and run a local image. Verify non-root execution, writable persistent data, read-only source mount, health check, correct `/api/version`, and absence of `.git`, `.env`, and local `data/` from the image.

## Release discipline

Do not commit, push, tag, or publish unless the user requests it. Before release, inspect the complete diff and ensure tests and Docker verification pass. After publishing, check GitHub Actions and pull the actual GHCR image; do not treat a pushed tag alone as success.

Keep changes focused, preserve unrelated user edits, use Chinese for user-facing errors/logs, and add tests closest to the risk boundary being changed.
