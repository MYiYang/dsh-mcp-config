# dsh-mcp-config

[![npm](https://img.shields.io/npm/v/dsh-mcp-config.svg)](https://www.npmjs.com/package/dsh-mcp-config)
[![license](https://img.shields.io/npm/l/dsh-mcp-config.svg)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-mcp-config.svg)](package.json)

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 加一个 **设置 → MCP** 页：

- **只读展示 DSH 已配置的 MCP 服务**：直接读 DSH 自己的加载器条目（`@deepseek-ai/dsh-mcp-client`），显示名称、传输方式、目标和当前已注册的工具数。这些条目仍由 DSH 的 `cordis.patch.yml` / bundle patch 管理，本插件不碰它们的配置。
- **手动添加自己的 MCP 服务**：支持 stdio（本地进程）和 HTTP（远程），保存后 **立即连接并注册工具，不需要重启 DSH**。

## 原理

官方 `@deepseek-ai/dsh-mcp-client` 本质上是一个普通的 Cordis 插件（导出 `apply` / `Config` / `inject`）。本插件通过 `ctx.loader.import('@deepseek-ai/dsh-mcp-client')` 拿到它，再用 `ctx.plugin(module, config)` 为每个自定义服务动态挂载一个实例：

- 挂载 = 建立连接 + 注册 `mcp__<name>__<tool>` 工具；
- 卸载（`fiber.dispose()`）= 断开连接 + 注销工具；
- 官方插件自带重连、`tools/list_changed` 热刷新、资源与图片投影等能力，本插件不重复实现。

自定义服务持久化在 `~/.dsh/dsh-mcp-config.json`，**不写用户的 `cordis.patch.yml`**。状态文件被手工改动时会被轮询感知并重挂差异。

## 安装

从 npm 装：

```sh
dsh plugin --profile <profile> add dsh-mcp-config
```

或让 DSH 的插件管理（`plugin_manager` → `install_bundle`）按名字 `dsh-mcp-config` 安装。装完刷新 Web 页面，在 **设置 → MCP** 就能看到这一页。

改本地源码调试时，把包名换成目录链接：

```sh
dsh plugin --profile <profile> add link:/abs/path/to/dsh-mcp-config
```

> `dsh plugin` 由 `@deepseek-ai/dsh` 提供；桌面版独占 profile 时（Electron 占着），直接改 `~/.dsh/profiles/<profile>/package.json` 的依赖键 + `dsh.profile.bundles` 也一样。

## 使用

1. 打开 **设置 → MCP**。
2. 上半部分「DSH 已配置（只读）」列出 DSH 当前加载器里的 MCP 服务与工具数。
3. 下半部分「自定义服务」点 **＋ 添加 MCP 服务**：
   - **名称**：工具名前缀 `mcp__<名称>__*`，需匹配 `[A-Za-z0-9_-]`，长度 1–32，且不能与静态服务重名。
   - **stdio**：填可执行命令、参数（每行一个）、环境变量（每行 `key=value`）、工作目录（可选）。
   - **http**：填 `http(s)://…` URL 与可选请求头（每行 `key=value`）。
4. 保存后立即生效；卡片上的开关可停用 / 启用，另有重连与删除。

状态文件：`~/.dsh/dsh-mcp-config.json`。删除该文件即恢复空的自定义服务列表。

## 限制

- 仅工具（tools）经官方客户端桥接；`resources` / `prompts` 由官方 `mcpResources` 服务提供，取决于 DSH 版本。
- 连接状态用「已注册工具数」判断：动态服务连上但服务器没有导出任何工具时，状态会显示为连接失败（工具数 0）。
- 动态添加依赖当前 profile 能解析 `@deepseek-ai/dsh-mcp-client`；若缺失，页面会提示动态添加不可用，静态列表仍可用。
- 静态服务连不上（或没导出工具）时，行上会直接标「连接失败」并给出提示；详情看 DSH 日志。
- stdio 传输已在真机验证（动态挂载后 `mcp__<name>__*` 工具立即出现在会话里，删除后立即消失）；http（streamable-http）走同一条挂载路径，但未单独做真机验证。
- 保存后状态若还停在「连接中」，页面会自己补拉几轮，最多约 18 秒；仍连不上就转成「连接失败」，可点重连再试。

## 配置（可选）

在 profile 的 patch 层覆盖本行配置：

```yaml
- id: dsh-mcp-config
  name: 'dsh-mcp-config'
  config:
    home: 'C:\Users\you\.dsh'                    # 默认 $DSH_HOME 或 ~/.dsh
    stateFile: 'C:\Users\you\.dsh\dsh-mcp-config.json'  # 默认 <home>/dsh-mcp-config.json
```
