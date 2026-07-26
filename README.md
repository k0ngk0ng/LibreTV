# LibreTV

LibreTV 是一个自托管的视频搜索与播放页面。本分支以线上版本 `8128f9c`（2025-06-14 22:26）为基线，加入了服务端账户、独立用户历史记录、多源搜索进度和多标签页播放隔离。

## 主要变化

- 使用用户名和密码登录，密码以 `scrypt` 加盐哈希保存在服务器。
- 登录状态使用 `HttpOnly`、`SameSite=Lax` Cookie；页面、静态资源和代理接口均由服务端校验会话。
- 管理员可在 `/admin.html` 创建、停用、删除用户，以及重置密码和调整角色。
- 每个用户的观看集数和播放进度保存在服务器数据目录，不再写入浏览器 `localStorage`。
- 豆瓣封面通过登录后的同源图片代理加载，避免防盗链导致的破图。
- 搜索多个视频源时显示完成源数量和进度条。
- 播放上下文保存在每个标签页独立的 `sessionStorage` 中，多个页面观看不同影片或集数时不会互相覆盖。
- 页脚版本来自 `vX.Y.Z` 发布标签或 Git commit hash。

## 部署要求

账户版需要可写的持久数据目录，因此仅支持 Node.js 或 Docker 部署。Vercel、Netlify、Cloudflare Pages 等无持久本地磁盘的 Serverless 部署入口会返回 `503`，防止绕过服务端认证。

### Docker Compose（推荐）

```bash
cp .env.example .env
cp config/sites.example.json config/sites.json
```

编辑 `.env` 和不会被 Git 跟踪的 `config/sites.json`，至少设置：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请改成强密码
```

然后启动：

```bash
docker compose pull
docker compose up -d
```

默认会从当前 GitHub 仓库对应的 `ghcr.io/k0ngk0ng/libretv:latest` 拉取镜像，访问地址为 `http://localhost:8899`。账户和观看记录保存在 Docker 命名卷 `libretv_data`，升级容器时不会丢失。可通过 `LIBRETV_TAG=v1.0.0` 固定到特定版本。

需要从当前源码构建时使用覆盖文件：

```bash
GIT_COMMIT=$(git rev-parse HEAD) docker compose \
  -f docker-compose.yml -f docker-compose.build.yml \
  up -d --build
```

如果反向代理提供 HTTPS，保持 `TRUST_PROXY=true` 和 `COOKIE_SECURE=auto` 即可；生产环境请务必使用 HTTPS。

### Node.js

需要 Node.js 20 或更高版本：

```bash
cp .env.example .env
cp config/sites.example.json config/sites.json
npm ci
npm start
```

默认访问地址为 `http://localhost:8080`，数据保存在 `DATA_DIR`（默认 `./data`）。

首次启动且数据文件中没有用户时，服务端会使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 创建管理员。为了兼容旧部署，首次启动也会依次读取旧变量 `ADMINPASSWORD`、`PASSWORD`；创建完成后密码以哈希形式保存，环境变量不会用于日常登录验证。

## 资源站配置

实际资源站保存在 `config/sites.json`，该文件已加入 `.gitignore`，不会提交到源码或打进 Docker 镜像。首次部署请复制 [`config/sites.example.json`](config/sites.example.json)，再填入自己有权使用的资源站。服务启动时读取 `API_CONFIG_FILE` 指定的 JSON 文件；文件缺失或有误时默认回退到不含真实站点的最小示例配置，设置 `API_CONFIG_STRICT=true` 可改为直接拒绝启动。

```json
{
  "settings": {
    "defaultSources": ["example"],
    "hideAdultSources": false
  },
  "sites": {
    "example": {
      "api": "https://example.invalid/api.php/provide/vod",
      "name": "示例资源站（请替换）",
      "adult": false,
      "enabled": true
    }
  }
}
```

- `api`、`name` 必填；`detail`、`adult`、`enabled` 可选。
- `enabled: false` 会在启动时忽略该资源站。
- `defaultSources` 指定新用户默认选中的资源站。
- 修改文件后需要重启 LibreTV，浏览器会自动加载新的运行时配置。

Docker 部署时，将宿主机文件只读挂载到容器并指定容器内路径：

```bash
docker run ... \
  -e API_CONFIG_FILE=/app/custom/sites.json \
  -v /opt/libretv/sites.json:/app/custom/sites.json:ro \
  ghcr.io/k0ngk0ng/libretv:latest
```

资源站文件不包含密码时可设置为 `chmod 644 /opt/libretv/sites.json`，确保容器内的非 root 用户可以读取。

## 从旧密码版迁移

1. 备份当前部署和反向代理配置。
2. 为数据目录或 Docker 卷配置持久化。
3. 将旧密码填入 `ADMIN_PASSWORD`，并设置管理员用户名，例如 `admin`。
4. 启动新版本并使用该账户登录。
5. 在 `/admin.html` 创建其他用户；每个用户之后会拥有独立的服务器端观看记录。

旧版浏览器里的观看记录不会自动合并到新账户，以免把同一浏览器上不同使用者的数据错误归属给首个登录账户。

## 版本标识

服务端按以下顺序选择显示版本：

1. `APP_VERSION`、`GIT_TAG` 或 `RELEASE_TAG` 中符合 `vX.Y.Z` 的值；
2. Docker 构建时固化的 `.build-version`；
3. `GIT_COMMIT`、常见 CI commit 变量或仓库当前 commit hash；
4. `package.json` 版本作为开发环境兜底。

只有显式提供 commit 的固化构建会把带当前 revision 的静态资源设为长期不可变缓存；源码工作区始终使用 `no-store`，避免未提交修改沿用同一个 commit 缓存键。

发布正式版本时建议：

```bash
git tag v1.0.0
git push origin v1.0.0
```

只有推送 `vX.Y.Z` 标签才会触发 GitHub Actions，并发布同名标签及更新 `latest`。如果直接构建尚未提交的工作区，镜像只能读取当前 `HEAD`；正式部署前请先提交改动，或显式传入 `APP_VERSION`/`GIT_COMMIT`。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | `admin` | 首次启动创建的管理员用户名 |
| `ADMIN_PASSWORD` | 无 | 首次启动必填，至少 8 个字符 |
| `DATA_DIR` | `./data` | 用户和观看记录目录 |
| `API_CONFIG_FILE` | `./config/sites.json` | 启动时读取的资源站 JSON 文件 |
| `API_CONFIG_HOST_FILE` | `./config/sites.json` | Docker Compose 只读挂载的宿主机资源站文件 |
| `DEFAULT_API_CONFIG_FILE` | `./config/sites.example.json` | 主配置无效时使用的最小回退配置 |
| `API_CONFIG_STRICT` | `false` | 为 `true` 时资源站文件错误会阻止服务启动 |
| `SESSION_IDLE_HOURS` | `168` | 会话最长空闲时间 |
| `SESSION_MAX_DAYS` | `30` | 会话绝对有效期 |
| `TRUST_PROXY` | `true` | 是否信任第一层反向代理 |
| `COOKIE_SECURE` | `auto` | `auto`、`true` 或 `false` |
| `REQUEST_TIMEOUT` | `15000` | 上游代理请求超时（毫秒） |
| `MAX_RETRIES` | `2` | 上游代理重试次数 |
| `APP_VERSION` | 空 | `vX.Y.Z` 发布版本 |
| `GIT_COMMIT` | 空 | 无 tag 时显示的 commit hash |

## 安全说明

- 不要公开分享实例地址或管理员账户。
- 数据文件含有账户哈希和观看记录，请限制文件权限并定期备份。
- 修改用户密码、角色或状态会使该用户现有会话立即失效。
- 登录接口有失败次数限制；管理与历史写入接口同时校验同源请求和 CSRF token。
- 代理会拒绝本机、内网、链路本地地址，并逐次检查重定向目标。
- 不要使用简单静态服务器运行本项目；静态托管无法提供账户校验和安全代理。

## 开发与测试

```bash
npm ci
npm test
npm run dev
```

## API 兼容性

LibreTV 支持标准苹果 CMS V10 API：

- 搜索：`https://example.com/api.php/provide/vod/?ac=videolist&wd=关键词`
- 详情：`https://example.com/api.php/provide/vod/?ac=detail&ids=视频ID`

## 键盘快捷键

- 空格：播放/暂停
- 左右方向键：快退/快进
- 上下方向键：调节音量
- `M`：静音
- `F`：全屏
- `Esc`：退出全屏

## 免责声明

LibreTV 仅作为视频搜索工具，不存储、上传或分发视频内容。所有视频均来自第三方 API。使用者应遵守当地法律法规，并自行承担使用后果。
