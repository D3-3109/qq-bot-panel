# QQ Bot 面板

[![CI](https://github.com/D3-3109/qq-bot-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/D3-3109/qq-bot-panel/actions/workflows/ci.yml)
[![Docker](https://github.com/D3-3109/qq-bot-panel/actions/workflows/docker.yml/badge.svg)](https://github.com/D3-3109/qq-bot-panel/actions/workflows/docker.yml)

基于 [QQ 开放平台 API v2](https://bot.q.qq.com/wiki/develop/api-v2/) 的机器人 Web 聊天面板。部署在自己的服务器上，保存机器人账号并保持在线，你可以像用 QQ 客户端一样，以机器人身份在群聊和私聊中收发消息、查看群事件。

## 功能

- **多账号、长期在线**：WebSocket 网关长连接，带心跳、断线重连和 Resume 续传。AccessToken 到期前自动刷新，服务重启后机器人自动上线。也支持 Webhook 回调模式（Ed25519 签名校验、回调地址验证）。
- **凭证安全**：AppSecret 在服务器端用 AES-256-GCM 加密保存，接口不会把它返回给浏览器。面板登录有限流，Cookie 为 HttpOnly + SameSite，写操作做同源校验。
- **类似 QQ 客户端的界面**：账号栏、会话列表（未读数、搜索、备注）、聊天窗口、群成员面板、事件流和连接日志，并支持浏览器通知。
- **收消息**：文本、表情、图片、视频、语音（附识别文字）、文件、卡片、引用消息。
- **发消息**：文本、Markdown、图片 / 视频 / 语音 / 文件（本地上传 ≤5MB，或填网址）、引用回复、@成员（输入 `@` 弹出候选）、@全体成员、2 分钟内撤回。
- **被动回复**：自动带上 `msg_id` / `event_id` 和递增的 `msg_seq`；输入框上方实时显示被动回复窗口的剩余次数和倒计时。窗口过期后改为主动消息。
- **群事件**：机器人进群 / 退群、开关主动消息、成员进出、加群申请（可在面板里同意或拒绝）、私聊好友事件。
- **接收全部群消息**：群主开启“接收全量消息”后，群里所有发言都会显示。有人 @机器人 时，会话列表显示“[有人@我]”；浏览器通知只提醒私聊和 @ 消息。被动回复优先使用 @机器人 的那条消息。
- **图片与表情包**：收到的图片会自动下载到本地。QQ 的图片链接过期后，面板里仍然能看，点开可以查看大图。任何图片（收到的、自己发的、本地上传的）都可以“收藏为表情”，并给它设置关键词。输入框旁有表情面板可以一键发送；输入内容命中关键词时，输入框上方会出现候选表情，可以点击发送，也可以按 ↑ 选中后用 ←/→ 切换、Enter 发送。同一张图在同一个会话里重复发送时，会复用平台返回的 `file_info`，不重新上传。

## 快速开始（Docker Compose）

```bash
git clone https://github.com/D3-3109/qq-bot-panel.git
cd qq-bot-panel
cp .env.example .env        # 修改 ADMIN_PASSWORD
docker compose up -d --build
```

打开 `http://服务器IP:3000`，用户名 `admin`，密码为 `.env` 中的 `ADMIN_PASSWORD`。点击左侧 ＋，填入 AppID 和 AppSecret 即可上线。这两个值在 [QQ 开放平台](https://q.qq.com/) → 开发 → 开发设置 中获取。

数据（SQLite 数据库和加密密钥）保存在名为 `panel-data` 的数据卷里，升级镜像不会丢失：

```bash
docker compose pull && docker compose up -d    # 使用 GHCR 预构建镜像升级
docker compose up -d --build                   # 或者从源码重新构建
```

备份数据卷：

```bash
docker run --rm -v qq-bot-panel_panel-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/panel-data.tgz -C /data .
```

> 镜像会由 GitHub Actions 发布到 `ghcr.io/d3-3109/qq-bot-panel`。如果仓库是私有的，镜像也是私有的，拉取前需要先 `docker login ghcr.io`；也可以直接用 `--build` 从源码构建。

## 不用 Docker 部署

需要 Node.js ≥ 22.13。项目用到内置的 `node:sqlite`、`fetch` 和 `WebSocket`，运行时没有第三方依赖，不用 `npm install`。

```bash
ADMIN_PASSWORD='强密码' PORT=3000 node server/index.js
```

首次启动时如果没有设置 `ADMIN_PASSWORD`，控制台会打印随机生成的初始密码。

<details>
<summary>systemd 服务示例</summary>

```ini
# /etc/systemd/system/qq-bot-panel.service
[Unit]
Description=QQ Bot Panel
After=network-online.target

[Service]
WorkingDirectory=/opt/qq-bot-panel
ExecStart=/usr/bin/node server/index.js
Environment=HOST=127.0.0.1 PORT=3000 TRUST_PROXY=1
EnvironmentFile=-/opt/qq-bot-panel/.env
Restart=always
User=qqbot

[Install]
WantedBy=multi-user.target
```

</details>

## 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 无 | `admin` 的登录密码，每次启动都以此为准 |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址。放在反向代理后面时建议设为 `127.0.0.1` |
| `DATA_DIR` | `./data`（Docker 中为 `/data`） | 数据库和加密密钥的目录，请定期备份 |
| `PANEL_SECRET_KEY` | 无 | 加密 AppSecret 用的主密钥。不设置则自动生成 `DATA_DIR/secret.key` |
| `TRUST_PROXY` | 无 | 放在反向代理后面时设为 `1`，用于识别真实 IP 和 HTTPS |
| `PANEL_PORT` | `3000` | 仅 Docker Compose 使用，指定宿主机映射的端口 |
| `MEDIA_CACHE` | `1` | 设为 `0` 时不自动下载收到的图片（仍可在收藏时手动下载） |
| `MEDIA_RETENTION_DAYS` | `30` | 自动下载的图片保留天数；已收藏为表情的不会被清理 |
| `MEDIA_HOSTS` | QQ 图床域名 | 允许下载图片的域名列表（逗号分隔，按后缀匹配），防止服务器被诱导访问内网 |

## HTTPS 反向代理（nginx）

面板通过 SSE（`/api/stream`）向浏览器推送新消息，所以代理时要关闭缓冲：

```nginx
server {
    listen 443 ssl http2;
    server_name bot.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;
        client_max_body_size 10m;
    }
}
```

使用 Docker 时，把 `docker-compose.yml` 中的端口映射改为 `127.0.0.1:3000:3000`，并在 `.env` 中设置 `TRUST_PROXY=1`。

## 事件接收方式

- **WebSocket（默认，推荐）**：不需要公网 HTTPS，服务器能访问 `api.bot.qq.com` 和 `api.sgroup.qq.com` 就行。
- **Webhook**：在开放平台的回调配置中填写 `https://你的域名/webhook/<AppID>`（端口只能用 80、443、8080 或 8443），勾选需要的事件，然后在面板的账号设置里把接入方式改为 Webhook。

如果开放平台给机器人配置了 IP 白名单，记得把服务器的出口 IP 加进去。

## QQ 开放平台的限制

以下限制来自平台本身，面板无法绕过：

| 现象 | 原因与处理 |
|---|---|
| 左侧看不到机器人所在的群 | 平台没有“群列表”和“历史消息”接口。群会话会在收到该群的消息或进群事件后出现；已知 `group_openid` 时也可以手动添加。 |
| 只能收到 @机器人 的消息 | 需要群主在手机 QQ 里打开机器人资料页 →“设置权限”，开启“接收全量消息”。这是按群设置的，每个群都要开；开启后聊天窗口标题下方会显示“接收全部消息”。 |
| 发送图片失败，错误码 40034002 | 图片格式不支持，或图片尺寸太小（几个像素的图片会被平台拒绝）。PNG / JPEG / GIF（含动图）/ WebP 都可以。 |
| 发送失败，错误码 40034105 | 机器人没有群主动消息权限。可以等有人 @ 机器人后在 5 分钟内回复，或者向平台申请主动消息权限。 |
| 发送失败，错误码 40034128 / 40034024 | 被动回复超出时间或次数。群聊是 5 分钟内最多 5 次，私聊是 60 分钟内最多 4 次。 |
| @ 成员没有生效 | @成员只在 Markdown 消息里生效。面板插入 @ 时会自动切换到 Markdown。 |
| @全体成员失败 | 需要机器人是群管理员，且每个群每天只能用 1 次。 |
| 连接被拒绝，错误码 4014 | 勾选了平台未开通的事件订阅（比如群成员事件），到账号设置里取消勾选即可。 |

## 开发与测试

```bash
npm install          # 只会安装测试用的 ws
npm test             # 启动模拟 QQ 服务端和面板，运行端到端测试
npm run mock         # 单独启动模拟 QQ 服务端 http://127.0.0.1:9100
```

使用模拟服务端时，添加账号的 AppID 填 `102000001`，Secret 填 `mockSecretValue123`，并在“高级”里把 OpenAPI 地址改成 `http://127.0.0.1:9100`。之后向 `POST http://127.0.0.1:9100/_mock/dispatch` 发送 `{"t": "事件名", "d": {...}}`，就能模拟平台推送事件。

GitHub Actions 包括：

- **CI**：在 Node 22 和 24 上做语法检查，并运行端到端测试。
- **Docker**：先构建镜像并做健康检查冒烟测试，然后为 `linux/amd64` 和 `linux/arm64` 构建镜像，推送到 GHCR。`main` 分支推送 `latest` 标签，打 `v*` 标签时推送对应的版本号。

## 目录结构

```
server/
  index.js        HTTP 服务、静态文件、安全响应头、/healthz
  routes.js       面板 REST API
  auth.js         登录、会话 Cookie、限流
  bots.js         机器人账号管理与运行时（网关 / Token）
  qq/api.js       OpenAPI 客户端与 AccessToken 管理
  qq/gateway.js   WebSocket 网关（心跳、重连、Resume）
  webhook.js      Webhook 回调与签名校验
  events.js       把事件转换为会话、消息、成员
  sender.js       发送消息（被动 / 主动、上传媒体、撤回）
  store.js        数据访问
  media.js        本地媒体库：图片存储、QQ 图片下载缓存、file_info 缓存、过期清理
  stickers.js     表情收藏
public/           前端（原生 JS，无构建步骤）
scripts/          模拟 QQ 服务端与端到端测试
```

## License

MIT
