# OpenCLI ChatGPT Plugin

将已安装的 OpenCLI 站点适配器和插件命令，以可配置的 MCP 工具提供给 ChatGPT。服务使用 Streamable HTTP 和 OAuth 2.1，按配置限制可见命令与读写权限。

## 准备

- Node.js 24 或更新版本。
- 可执行的 `opencli`，且 `opencli list -f json` 能列出目标命令。
- 已为目标站点配置好 OpenCLI 所需的浏览器登录态。
- 一个转发到本服务的 HTTPS 地址，供 ChatGPT 连接。

## 安装与配置

```bash
npm ci
cp config.example.json config.json
opencli list -f json
node catalog-cli.mjs config.json
```

在 `config.json` 的 `adapters` 中配置要暴露的站点或插件。`tools` 必须明确列出 OpenCLI 命令名；可用 `opencli <site> --help -f json` 查看命令参数。OpenCLI 新安装的插件会出现在同一命令目录中，加入配置后即可使用。

| 字段 | 作用 |
| --- | --- |
| `enabled` | 启用站点或插件 |
| `tools` | 命令白名单 |
| `access` | `read` 或 `readwrite`；由 OpenCLI 命令元数据判定读写类型 |
| `scope` | 可选的 OAuth scope 前缀，默认使用站点名 |
| `names` | 可选的 MCP 工具名映射，默认使用 `<site>_<command>` |
| `session` | 可选的浏览器会话模式、标签页保留及窗口模式 |
| `rules` | 可选的参数名、默认值、范围、正则和 URL 约束 |

`access: read` 会过滤写命令。启用 `readwrite` 后，调用方仍须取得对应的 `<scope>:write` OAuth 权限。工具清单与参数约束在服务启动时加载，修改配置或安装插件后需重启服务。

## 启动

创建本地凭据文件，并设置对外 HTTPS 基址：

```bash
mkdir -p .local
chmod 700 .local
openssl rand -hex 32 > .local/password
openssl rand -hex 32 > .local/signing-key
chmod 600 .local/password .local/signing-key

export MCP_BASE_URL=https://mcp.example.com
export MCP_CONFIG_FILE="$PWD/config.json"
export MCP_PASSWORD_FILE="$PWD/.local/password"
export MCP_SIGNING_KEY_FILE="$PWD/.local/signing-key"
export MCP_STATE_FILE="$PWD/.local/state.json"
npm start
```

`MCP_BASE_URL` 应填写客户端访问的 HTTPS 基址，不含 `/mcp`。服务默认监听 `127.0.0.1:18060`；可用 `MCP_HOST`、`MCP_PORT` 修改。`OPENCLI_BIN` 可指定 OpenCLI 可执行文件路径，否则从 `PATH` 查找。将 HTTPS 反向代理指向监听地址后，通过 `https://mcp.example.com/mcp` 连接。

## 接入与发现

在 ChatGPT 中添加自定义 MCP 连接，名称设为 **OpenCLI**，地址填写 `https://mcp.example.com/mcp`。选择自动发现的 OAuth 方式，并在授权页面输入本地凭据文件中的连接密码。

- `GET /catalog`：列出当前启用的工具、输入 schema 和所需 OAuth scope；不需要授权。
- `POST /mcp`：授权后通过 MCP `tools/list` 获取当前令牌可调用的工具，使用 `tools/call` 调用。
- OAuth 元数据通过 `/.well-known/oauth-protected-resource` 和 `/.well-known/oauth-authorization-server` 提供。

服务只执行配置白名单中的 OpenCLI 命令；每个访问令牌每小时最多调用 60 次，同一时刻运行一条命令，单次命令超时为 60 秒。CLI 标准输出上限为 1 MiB，单次结果上限为 120,000 字符。

## 验证

```bash
npm test
curl https://mcp.example.com/catalog
curl -i https://mcp.example.com/mcp
```

未授权的 `/mcp` 请求应返回 `401` 和 `WWW-Authenticate`。连接完成后，在 ChatGPT 中检查工具列表，并调用一个已启用的读工具。
