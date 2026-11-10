/**
 * dsh-mcp-config — host half.
 *
 * 给 DSH 加一个「设置 → MCP」页，做两件事：
 *
 * 1. 只读展示 DSH 已经配置好的 MCP 服务（官方加载器 `@deepseek-ai/dsh-mcp-client`
 *    的静态条目，来自 profile 的 cordis.patch.yml / bundle patch）。这些条目由
 *    DSH 自己的加载器管理，本插件不碰它们的配置，只把名称、传输方式、目标和
 *    当前已注册的工具数读出来。
 *
 * 2. 让用户在设置页手动添加 / 编辑 / 删除自己的 MCP 服务，并且**立即生效、不用重启
 *    DSH**。做法是：把 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 插件当成一个普通
 *    Cordis 插件，用 `ctx.plugin(module, config)` 动态挂到本插件的上下文下。
 *    挂载成功即完成连接与工具注册（工具名仍是 `mcp__<name>__<tool>`），卸载即断开
 *    并注销工具。配置持久化在本插件自己的状态文件里，不写用户的 cordis.patch.yml。
 *
 * 路由（都由 connection.requestRejection 把关，只有本机已登录的页面能调）：
 *   GET  /dsh-mcp-config/api/ping
 *   GET  /dsh-mcp-config/api/state
 *   POST /dsh-mcp-config/api/servers
 *   PUT  /dsh-mcp-config/api/servers/:id
 *   DEL  /dsh-mcp-config/api/servers/:id
 *   POST /dsh-mcp-config/api/servers/:id/enabled   { enabled: boolean }
 *   POST /dsh-mcp-config/api/servers/:id/reconnect
 * @module dsh-mcp-config
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'

export const inject = ['webServer', 'connection']

/** 路由前缀；方法名是它后面的第一段。 */
const API_PREFIX = '/dsh-mcp-config/api'
/** 状态文件名（放在 $DSH_HOME 下，与 mcp-manager.json 同级）。 */
const STATE_FILENAME = 'dsh-mcp-config.json'
/** 与官方 mcp-client 的 serverName 校验保持一致。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
/** 请求体上限：一份服务器配置只有几 KB，给 64 KiB 足够且防呆。 */
const MAX_BODY_BYTES = 64 * 1024
/** 每个工具调用的默认超时，与官方 mcp-client 的默认值一致。 */
const TOOL_CALL_TIMEOUT_MS = 60_000
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** 带稳定错误码的失败，客户端按码展示。 */
class SettingsError extends Error {
  /**
   * @param {string} code - 机器可读的错误码。
   * @param {string} message - 给人看的理由。
   * @param {number} status - HTTP 状态码。
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'SettingsError'
    this.code = code
    this.status = status
  }
}

/**
 * 写一份 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 待响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} value - 可序列化的 body。
 */
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * 写一份失败响应。
 * @param {import('node:http').ServerResponse} res - 待响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {string} code - 机器可读的错误码。
 * @param {string} message - 给人看的理由。
 */
function writeFailure(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/**
 * 读取并校验请求体。空 body 视为 `{}`（ping 之外都会显式传）。
 * @param {import('node:http').IncomingMessage} req - 请求流。
 * @returns {Promise<Record<string, unknown>>} 解析后的对象。
 * @throws {SettingsError} body 过大或不是 JSON 对象时。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new SettingsError('bad-request', 'request body too large', 400)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SettingsError('bad-request', 'request body is not valid JSON', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SettingsError('bad-request', 'request body must be a JSON object', 400)
  }
  return parsed
}

/**
 * 解析 DSH home：显式 config > $DSH_HOME > ~/.dsh。
 * @param {Record<string, unknown>} config - 本行配置。
 * @returns {string} 绝对路径。
 */
function resolveHome(config) {
  if (typeof config?.home === 'string' && config.home.trim() !== '') return config.home.trim()
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(os.homedir(), '.dsh')
}

/**
 * 读状态文件；不存在或损坏都退回空状态（首次运行 / 手改坏时不应炸掉插件）。
 * @param {string} file - 状态文件绝对路径。
 * @returns {{servers: Array<object>}} 状态对象。
 */
function loadState(file) {
  if (!existsSync(file)) return { servers: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { servers: [] }
    return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] }
  } catch (error) {
    return { servers: [] }
  }
}

/**
 * 读状态文件的修改时间；文件不存在或暂时读不到都返回 0（调用方按「等下一轮」处理）。
 * @param {string} file - 状态文件绝对路径。
 * @returns {number} mtime（毫秒），读不到为 0。
 */
function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 原子写状态文件：先写临时文件再 rename，避免半截 JSON 被下次读到。
 * @param {string} file - 状态文件绝对路径。
 * @param {{servers: Array<object>}} state - 完整状态。
 */
function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/**
 * 生成一个短 id（状态文件主键，不做安全用途）。
 * @returns {string} 16 位十六进制。
 */
function randomId() {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10)
}

/**
 * 把未知输入压成字符串数组，丢弃非字符串项。
 * @param {unknown} value - 原始值。
 * @returns {string[]} 字符串数组。
 */
function toStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string')
}

/**
 * 把未知输入压成字符串映射，丢弃非字符串值。
 * @param {unknown} value - 原始值。
 * @returns {Record<string, string>} 字符串映射。
 */
function toStringMap(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item
  }
  return result
}

/**
 * 把一份原始输入规范化成动态服务器配置。
 * @param {Record<string, unknown>} input - 请求体。
 * @param {{id?: string, createdAt?: number}} [existing] - 编辑时保留的字段。
 * @returns {object} 规范化的服务器配置。
 * @throws {SettingsError} 字段不合法时。
 */
function normalizeServer(input, existing = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new SettingsError('invalid-name', '名称需匹配 [A-Za-z0-9_-]，长度 1–32', 400)
  }
  const transport = input.transport === 'http' || input.transport === 'streamable-http'
    ? 'http'
    : input.transport === 'stdio'
      ? 'stdio'
      : null
  if (transport === null) {
    throw new SettingsError('invalid-transport', '类型只能是 stdio 或 http', 400)
  }
  /** @type {object} */
  const server = {
    id: existing.id ?? randomId(),
    name,
    transport,
    enabled: input.enabled !== false,
    createdAt: existing.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    command: '',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
  }
  if (transport === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (command === '') throw new SettingsError('invalid-command', 'stdio 服务必须填写可执行命令', 400)
    server.command = command
    server.args = toStringArray(input.args)
    server.env = toStringMap(input.env)
    server.cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
  } else {
    const url = typeof input.url === 'string' ? input.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) {
      throw new SettingsError('invalid-url', 'http 服务必须填写 http(s) URL', 400)
    }
    server.url = url
    server.headers = toStringMap(input.headers)
  }
  return server
}

/**
 * 统计某个 serverName 当前已注册的工具数。
 * @param {object} tools - 工具注册表服务。
 * @param {string} serverName - MCP 服务名。
 * @returns {number} 工具数。
 */
function countTools(tools, serverName) {
  if (tools === undefined || tools === null || typeof tools.schemas !== 'function') return 0
  try {
    const prefix = `mcp__${serverName}__`
    const schemas = tools.schemas()
    let count = 0
    for (const schema of schemas) {
      if (typeof schema?.name === 'string' && schema.name.startsWith(prefix)) count += 1
    }
    return count
  } catch {
    return 0
  }
}

/**
 * 从加载器读取 DSH 静态配置的 MCP 服务条目。
 *
 * 只读 `ctx.loader.entries()` 里 name 为 `@deepseek-ai/dsh-mcp-client` 的行，
 * 取它们的 `options.config`。这些行由 DSH 的 profile patch / bundle patch 提供，
 * 本插件不修改它们，只展示。
 * @param {object} loader - 加载器服务。
 * @param {object} tools - 工具注册表服务。
 * @returns {Array<object>} 静态服务列表。
 */
function readStaticServers(loader, tools) {
  /** @type {Array<object>} */
  const result = []
  if (loader === undefined || loader === null || typeof loader.entries !== 'function') return result
  try {
    for (const entry of loader.entries()) {
      const options = entry.options
      if (options === null || typeof options !== 'object') continue
      if (options.name !== '@deepseek-ai/dsh-mcp-client') continue
      const config = options.config !== null && typeof options.config === 'object' ? options.config : {}
      const serverName = typeof config.serverName === 'string' ? config.serverName : ''
      if (serverName === '') continue
      result.push({
        id: typeof options.id === 'string' ? options.id : entry.id,
        serverName,
        transport: config.transport === 'streamable-http' ? 'http' : 'stdio',
        command: typeof config.command === 'string' ? config.command : '',
        args: Array.isArray(config.args) ? config.args.filter((item) => typeof item === 'string') : [],
        url: typeof config.url === 'string' ? config.url : '',
        enabled: !entry.disabled,
        toolCount: countTools(tools, serverName),
      })
    }
  } catch (error) {
    // 读不到静态条目只是少展示一块，不影响动态添加。
  }
  return result
}

/**
 * 把动态服务器配置翻译成官方 mcp-client 插件的配置。
 * @param {object} server - 本插件的服务器配置。
 * @returns {object} mcp-client 的 Config。 */
function toMcpClientConfig(server) {
  if (server.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName: server.name,
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
      cwd: server.cwd ?? '',
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
    }
  }
  return {
    transport: 'streamable-http',
    serverName: server.name,
    url: server.url,
    headers: { ...server.headers },
    toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: false,
  }
}

/**
 * 挂载一个动态 MCP 服务：把官方 mcp-client 插件作为子插件挂到本插件上下文。
 *
 * 挂载即连接、连上即注册工具；连不上时官方插件只记日志、进入重连循环，
 * 本函数据工具数把状态标成 connected / error。
 * @param {object} ctx - 本插件上下文。
 * @param {object} mcpClient - `ctx.loader.import` 拿到的官方插件模块。
 * @param {object} tools - 工具注册表服务。
 * @param {object} server - 服务器配置。
 * @returns {{fiber: object, server: object, status: string, error: string|null}} 运行记录。
 */
function mountServer(ctx, mcpClient, tools, server) {
  const fiber = ctx.plugin(mcpClient, toMcpClientConfig(server))
  const record = { fiber, server, status: 'connecting', error: null }
  fiber.await().then(() => {
    const toolCount = countTools(tools, server.name)
    if (toolCount > 0) {
      record.status = 'connected'
      record.error = null
    } else if (record.status !== 'error') {
      record.status = 'error'
      record.error = '连接未成功：服务器没有返回工具（详情见 DSH 日志）'
    }
  }).catch((error) => {
    record.status = 'error'
    record.error = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`dsh-mcp-config: ${server.name} 加载失败：${record.error}`)
  })
  return record
}

/**
 * 卸载一个动态服务：断开连接并注销它的工具。
 * @param {object} ctx - 本插件上下文。
 * @param {Map<string, object>} live - 运行记录表。
 * @param {string} id - 服务器 id。
 * @param {string} label - 日志用的名字。
 */
async function unmountServer(ctx, live, id, label) {
  const record = live.get(id)
  if (record === undefined) return
  live.delete(id)
  try {
    await record.fiber.dispose()
  } catch (error) {
    ctx.logger?.warn?.(`dsh-mcp-config: 卸载 ${label} 时出错：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 激活插件。
 * @param {object} ctx - 主机上下文（webServer、connection）。
 * @param {Record<string, unknown>} [config] - 本行配置。
 */
export async function apply(ctx, config = {}) {
  const home = resolveHome(config)
  const stateFile = typeof config.stateFile === 'string' && config.stateFile.trim() !== ''
    ? config.stateFile.trim()
    : join(home, STATE_FILENAME)

  /** @type {{servers: Array<object>}} */
  const state = loadState(stateFile)
  /** @type {Map<string, {fiber: object, server: object, status: string, error: string|null}>} */
  const live = new Map()

  const tools = ctx.get('tools')
  const loader = ctx.get('loader')

  // 官方 mcp-client 插件：动态挂载的「引擎」。拿不到时页面仍展示静态服务，
  // 只是添加按钮不可用，并给出明确提示。
  let mcpClient
  try {
    mcpClient = await ctx.loader.import('@deepseek-ai/dsh-mcp-client')
  } catch (error) {
    ctx.logger?.error?.(`dsh-mcp-config: 无法导入 @deepseek-ai/dsh-mcp-client，动态添加不可用：${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * 静态服务名集合，用于动态添加时的重名校验。
   * @returns {Set<string>} 集合。
   */
  function staticNames() {
    return new Set(readStaticServers(loader, tools).map((server) => server.serverName))
  }

  /**
   * 把一份服务器配置序列化成 API 返回的形状（含实时状态）。
   * @param {object} server - 服务器配置。
   * @returns {object} 可 JSON 化的视图。
   */
  function serializeServer(server) {
    const record = live.get(server.id)
    const toolCount = countTools(tools, server.name)
    let status
    if (server.enabled === false) status = 'disabled'
    else if (record !== undefined) status = record.status
    else status = 'error'
    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
      cwd: server.cwd,
      url: server.url,
      headers: { ...server.headers },
      enabled: server.enabled !== false,
      status,
      toolCount,
      error: record ? record.error : (server.enabled === false ? null : '服务未挂载'),
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    }
  }

  /**
   * 按 id 找服务器配置。
   * @param {string} id - 服务器 id。
   * @returns {object|undefined} 配置。 */
  function findServer(id) {
    return state.servers.find((server) => server?.id === id)
  }

  const operations = {
    /** 存活探测。 */
    async ping() {
      return { ok: true, name: 'dsh-mcp-config', canAdd: mcpClient !== undefined }
    },
    /** 全量状态：静态服务 + 动态服务。 */
    async state() {
      return {
        canAdd: mcpClient !== undefined,
        staticServers: readStaticServers(loader, tools),
        servers: state.servers.map((server) => serializeServer(server)),
      }
    },
    /** 新增一个动态服务。 */
    async add(payload) {
      if (mcpClient === undefined) throw new SettingsError('unavailable', '动态添加不可用：缺少 @deepseek-ai/dsh-mcp-client', 503)
      const server = normalizeServer(payload)
      if (state.servers.some((item) => item.name === server.name)) {
        throw new SettingsError('duplicate-name', `名称 ${server.name} 已存在`, 409)
      }
      if (staticNames().has(server.name)) {
        throw new SettingsError('duplicate-name', `名称 ${server.name} 已被 DSH 静态配置占用`, 409)
      }
      state.servers.push(server)
      saveState(stateFile, state)
      if (server.enabled) live.set(server.id, mountServer(ctx, mcpClient, tools, server))
      return serializeServer(server)
    },
    /** 编辑一个动态服务。 */
    async update(payload) {
      if (mcpClient === undefined) throw new SettingsError('unavailable', '动态添加不可用：缺少 @deepseek-ai/dsh-mcp-client', 503)
      const id = typeof payload.id === 'string' ? payload.id : ''
      const index = state.servers.findIndex((server) => server?.id === id)
      if (index < 0) throw new SettingsError('not-found', `找不到服务 ${id}`, 404)
      const existing = state.servers[index]
      const next = normalizeServer(payload, { id: existing.id, createdAt: existing.createdAt })
      const duplicate = state.servers.some((item) => item.id !== id && item.name === next.name)
      if (duplicate) throw new SettingsError('duplicate-name', `名称 ${next.name} 已存在`, 409)
      if (staticNames().has(next.name)) {
        throw new SettingsError('duplicate-name', `名称 ${next.name} 已被 DSH 静态配置占用`, 409)
      }
      state.servers[index] = next
      saveState(stateFile, state)
      await unmountServer(ctx, live, id, existing.name)
      if (next.enabled) live.set(next.id, mountServer(ctx, mcpClient, tools, next))
      return serializeServer(next)
    },
    /** 删除一个动态服务。 */
    async remove(payload) {
      const id = typeof payload.id === 'string' ? payload.id : ''
      const index = state.servers.findIndex((server) => server?.id === id)
      if (index < 0) throw new SettingsError('not-found', `找不到服务 ${id}`, 404)
      const existing = state.servers[index]
      await unmountServer(ctx, live, id, existing.name)
      state.servers.splice(index, 1)
      saveState(stateFile, state)
      return { ok: true }
    },
    /** 启用 / 停用一个动态服务。 */
    async setEnabled(payload) {
      if (mcpClient === undefined) throw new SettingsError('unavailable', '动态添加不可用：缺少 @deepseek-ai/dsh-mcp-client', 503)
      const id = typeof payload.id === 'string' ? payload.id : ''
      const server = findServer(id)
      if (server === undefined) throw new SettingsError('not-found', `找不到服务 ${id}`, 404)
      const enabled = payload.enabled === true
      server.enabled = enabled
      server.updatedAt = Date.now()
      saveState(stateFile, state)
      await unmountServer(ctx, live, id, server.name)
      if (enabled) live.set(server.id, mountServer(ctx, mcpClient, tools, server))
      return serializeServer(server)
    },
    /** 重连一个动态服务。 */
    async reconnect(payload) {
      if (mcpClient === undefined) throw new SettingsError('unavailable', '动态添加不可用：缺少 @deepseek-ai/dsh-mcp-client', 503)
      const id = typeof payload.id === 'string' ? payload.id : ''
      const server = findServer(id)
      if (server === undefined) throw new SettingsError('not-found', `找不到服务 ${id}`, 404)
      await unmountServer(ctx, live, id, server.name)
      if (server.enabled !== false) live.set(server.id, mountServer(ctx, mcpClient, tools, server))
      return serializeServer(server)
    },
  }

  // 启动时把状态文件里启用的服务全部挂上（重启 DSH 后恢复）。
  if (mcpClient !== undefined) {
    for (const server of state.servers) {
      if (server && server.enabled !== false) {
        live.set(server.id, mountServer(ctx, mcpClient, tools, server))
      }
    }
  }

  /** 只有本机已登录页面能调这些路由。 */
  const admits = (req) => {
    try {
      return ctx.connection.requestRejection(req) === undefined
    } catch {
      return false
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (!admits(req)) {
            writeFailure(res, 403, 'forbidden', 'forbidden')
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          if (!pathname.startsWith(`${API_PREFIX}/`)) {
            writeFailure(res, 404, 'not-found', 'unknown endpoint')
            return
          }
          const parts = pathname.slice(API_PREFIX.length + 1).split('/').filter((part) => part !== '')
          try {
            if (parts.length === 0) {
              writeFailure(res, 404, 'not-found', 'unknown endpoint')
              return
            }
            const [head, ...rest] = parts
            if (head === 'ping' && req.method === 'GET') {
              writeJson(res, 200, { ok: true, value: await operations.ping() })
              return
            }
            if (head === 'state' && req.method === 'GET') {
              writeJson(res, 200, { ok: true, value: await operations.state() })
              return
            }
            if (head === 'servers') {
              if (parts.length === 1 && req.method === 'POST') {
                const payload = await readJsonBody(req)
                writeJson(res, 200, { ok: true, value: await operations.add(payload) })
                return
              }
              if (parts.length >= 2) {
                const id = decodeURIComponent(parts[1])
                if (parts.length === 2 && req.method === 'PUT') {
                  const payload = { ...(await readJsonBody(req)), id }
                  writeJson(res, 200, { ok: true, value: await operations.update(payload) })
                  return
                }
                if (parts.length === 2 && req.method === 'DELETE') {
                  writeJson(res, 200, { ok: true, value: await operations.remove({ id }) })
                  return
                }
                if (parts.length === 3 && parts[2] === 'enabled' && req.method === 'POST') {
                  const payload = { ...(await readJsonBody(req)), id }
                  writeJson(res, 200, { ok: true, value: await operations.setEnabled(payload) })
                  return
                }
                if (parts.length === 3 && parts[2] === 'reconnect' && req.method === 'POST') {
                  writeJson(res, 200, { ok: true, value: await operations.reconnect({ id }) })
                  return
                }
              }
            }
            writeFailure(res, 404, 'not-found', 'unknown endpoint')
          } catch (error) {
            if (error instanceof SettingsError) {
              writeFailure(res, error.status, error.code, error.message)
              return
            }
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger?.error?.(`dsh-mcp-config: ${error instanceof Error ? error.stack : message}`)
            writeFailure(res, 500, 'internal', 'internal error')
          }
        },
      }),
    'dsh-mcp-config: /dsh-mcp-config/api routes',
  )

  // 状态文件被手工改动时（例如从别的窗口加了配置），250ms 轮询一次并重挂差异。
  // 这只读到本插件自己的文件，不会碰用户的 cordis.patch.yml。
  //
  // 基线在注册时立刻采一次，而不是等第一轮定时器再记：否则 apply 之后 250ms 内
  // 落下的外部改动会被当成「首次基线」吞掉，之后 mtime 不再变化就永远不会重挂。
  let lastMtime = mtimeOf(stateFile)
  ctx.effect(() => {
    const timer = setInterval(() => {
      const mtime = mtimeOf(stateFile)
      // 读不到（文件不存在 / 正在被写）就等下一轮。
      if (mtime === 0 || mtime === lastMtime) return
      lastMtime = mtime
      const next = loadState(stateFile)
      reconcile(next).catch((error) => {
        ctx.logger?.warn?.(`dsh-mcp-config: 状态文件重挂失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, 250)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-mcp-config: state file watch')

  /**
   * 把外部改动过的状态文件与当前运行时对齐：新增的挂上、删掉的卸载、改过的重挂。
   * @param {{servers: Array<object>}} next - 文件里读到的状态。
   */
  async function reconcile(next) {
    const byId = new Map(state.servers.map((server) => [server.id, server]))
    for (const server of next.servers) {
      if (!server || typeof server.id !== 'string') continue
      const current = byId.get(server.id)
      if (current === undefined) {
        // 新增
        state.servers.push(server)
        if (server.enabled !== false && mcpClient !== undefined) {
          live.set(server.id, mountServer(ctx, mcpClient, tools, server))
        }
      } else if (JSON.stringify(current) !== JSON.stringify(server)) {
        // 修改
        const index = state.servers.findIndex((item) => item.id === server.id)
        state.servers[index] = server
        await unmountServer(ctx, live, server.id, current.name)
        if (server.enabled !== false && mcpClient !== undefined) {
          live.set(server.id, mountServer(ctx, mcpClient, tools, server))
        }
      }
    }
    for (const server of [...state.servers]) {
      if (!next.servers.some((item) => item && item.id === server.id)) {
        await unmountServer(ctx, live, server.id, server.name)
        state.servers.splice(state.servers.indexOf(server), 1)
      }
    }
  }

  ctx.logger?.info?.(`dsh-mcp-config: 已加载，状态文件 ${stateFile}，动态添加 ${mcpClient !== undefined ? '可用' : '不可用'}`)
}
