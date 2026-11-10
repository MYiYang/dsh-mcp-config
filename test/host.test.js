/**
 * Host-half behaviour tests.
 *
 * The host half only needs four things from DSH — `webServer`, `connection`,
 * the loader and the tool registry — so it can be driven end-to-end against
 * stubs: register the real route handler, then speak HTTP to it. These tests
 * pin the route contract, the input normalisation, the mount/unmount lifecycle
 * and the state-file reconcile path, none of which a manual click can cover.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import(new URL('../index.js', import.meta.url))

const API = '/dsh-mcp-config/api'

/** 一个够用的假响应对象：插件只会用 writeHead / end。 */
function makeRes() {
  const res = { status: 0, headers: null, body: '' }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (chunk) => { res.body = chunk ?? '' }
  res.json = () => { try { return JSON.parse(res.body) } catch { return undefined } }
  return res
}

/** 把 JSON body 变成一个可 async-iterate 的请求（插件按流读 body）。 */
function makeReq(method, path, body) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method,
    url: `${API}${path}`,
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
}

/**
 * 搭一套桩 DSH，把插件 apply 起来，返回能直接调路由的 harness。
 * @param {{staticEntries?: Array<object>, importFails?: boolean, toolsAvailable?: boolean, loaderAvailable?: boolean}} [options] - 桩的开关。
 * @returns {Promise<object>} harness。
 */
async function build(options = {}) {
  const { staticEntries = [], importFails = false, toolsAvailable = true, loaderAvailable = true } = options
  const registry = new Set()
  const mounted = []
  const routes = []
  const logs = []

  const tools = { schemas: () => [...registry].map((name) => ({ name, description: name, parameters: { type: 'object' } })) }

  const loader = {
    entries: () => staticEntries,
    import: async (spec) => {
      if (importFails) throw new Error(`cannot import ${spec}`)
      // 冒充官方 mcp-client：挂载即注册两个 mcp__<name>__* 工具，卸载即注销。
      return {
        inject: ['tools'],
        apply(_childCtx, config) {
          registry.add(`mcp__${config.serverName}__alpha`)
          registry.add(`mcp__${config.serverName}__beta`)
        },
      }
    },
  }

  const ctx = {
    get(name) {
      if (name === 'tools') return toolsAvailable ? tools : undefined
      if (name === 'loader') return loaderAvailable ? loader : undefined
      return undefined
    },
    get loader() { return loaderAvailable ? loader : undefined },
    logger: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
    plugin(mod, config) {
      mod.apply({}, config)
      const fiber = {
        async dispose() {
          registry.delete(`mcp__${config.serverName}__alpha`)
          registry.delete(`mcp__${config.serverName}__beta`)
          const index = mounted.indexOf(fiber)
          if (index >= 0) mounted.splice(index, 1)
        },
        await: async () => fiber,
      }
      mounted.push(fiber)
      return fiber
    },
    effect(fn) { return fn() },
    webServer: {
      register(route) {
        routes.push(route)
        return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) }
      },
    },
    connection: { requestRejection: () => undefined },
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-config-'))
  const stateFile = join(dir, 'state.json')
  await plugin.apply(ctx, { stateFile })
  assert.equal(routes.length, 1, 'apply 应该注册恰好一条路由')

  async function call(method, path, body) {
    const res = makeRes()
    await routes[0].handler(makeReq(method, path, body), res)
    return res
  }

  return { ctx, call, registry, mounted, logs, stateFile, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('健康检查与空状态', async (t) => {
  const h = await build()
  t.after(h.cleanup)

  const ping = await h.call('GET', '/ping')
  assert.equal(ping.status, 200)
  assert.equal(ping.json().value.canAdd, true)
  assert.equal(ping.json().value.name, 'dsh-mcp-config')

  const state = await h.call('GET', '/state')
  assert.equal(state.status, 200)
  assert.deepEqual(state.json().value.servers, [])
  assert.equal(state.headers['cache-control'], 'no-store')
})

test('静态清单只认官方 mcp-client 行，且不泄露 env', async (t) => {
  const h = await build({
    staticEntries: [
      { id: 'e1', disabled: false, options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'mysql', transport: 'stdio', command: 'node', args: ['a.js'], env: { MYSQL_PASSWORD: 'x' } } } },
      { id: 'e2', disabled: false, options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'remote', transport: 'streamable-http', url: 'http://x/mcp' } } },
      { id: 'e3', disabled: true, options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'off', transport: 'stdio', command: 'x' } } },
      { id: 'e4', disabled: false, options: { name: 'some-other-plugin', config: { serverName: 'nope' } } },
      { id: 'e5', disabled: false, options: null },
    ],
  })
  t.after(h.cleanup)
  h.registry.add('mcp__mysql__query')

  const value = (await h.call('GET', '/state')).json().value
  assert.equal(value.staticServers.length, 3, '只应列出三条 mcp-client 行')
  assert.equal(value.staticServers.find((s) => s.serverName === 'remote').transport, 'http')
  assert.equal(value.staticServers.find((s) => s.serverName === 'off').enabled, false)
  assert.equal(value.staticServers.find((s) => s.serverName === 'mysql').toolCount, 1)
  assert.equal(JSON.stringify(value.staticServers).includes('MYSQL_PASSWORD'), false, '静态清单不应带出环境变量')
})

test('新增 → 停用 → 启用 → 编辑 → 删除的完整生命周期', async (t) => {
  const h = await build()
  t.after(h.cleanup)

  const created = await h.call('POST', '/servers', { name: 'demo', transport: 'stdio', command: 'node', args: ['s.js'], env: { A: '1' } })
  assert.equal(created.status, 200)
  const id = created.json().value.id
  assert.equal(h.mounted.length, 1, '新增即挂载')
  assert.deepEqual([...h.registry].sort(), ['mcp__demo__alpha', 'mcp__demo__beta'])
  assert.equal(JSON.parse(readFileSync(h.stateFile, 'utf8')).servers.length, 1, '状态文件应落盘')

  const afterAdd = (await h.call('GET', '/state')).json().value.servers[0]
  assert.equal(afterAdd.status, 'connected')
  assert.equal(afterAdd.toolCount, 2)

  assert.equal((await h.call('POST', '/servers', { name: 'demo', transport: 'stdio', command: 'node' })).status, 409, '重名应 409')

  assert.equal((await h.call('POST', `/servers/${id}/enabled`, { enabled: false })).status, 200)
  assert.equal(h.mounted.length, 0, '停用即卸载')
  const disabled = (await h.call('GET', '/state')).json().value.servers[0]
  assert.equal(disabled.status, 'disabled')
  assert.equal(disabled.toolCount, 0)

  assert.equal((await h.call('POST', `/servers/${id}/enabled`, { enabled: true })).status, 200)
  assert.equal(h.mounted.length, 1, '启用即重挂')

  const updated = await h.call('PUT', `/servers/${id}`, { name: 'demo', transport: 'http', url: 'http://127.0.0.1:9/mcp' })
  assert.equal(updated.status, 200)
  assert.equal((await h.call('GET', '/state')).json().value.servers[0].transport, 'http')
  assert.equal(h.mounted.length, 1, '改完只剩一个新实例')

  assert.equal((await h.call('POST', `/servers/${id}/reconnect`)).status, 200)
  assert.equal(h.mounted.length, 1, '重连后仍是单实例')

  assert.equal((await h.call('DELETE', `/servers/${id}`)).status, 200)
  assert.equal(h.mounted.length, 0)
  assert.deepEqual(JSON.parse(readFileSync(h.stateFile, 'utf8')).servers, [])
  assert.equal((await h.call('DELETE', `/servers/${id}`)).status, 404)
})

test('新增时可以顺手停用（不挂载）', async (t) => {
  const h = await build()
  t.after(h.cleanup)

  const created = await h.call('POST', '/servers', { name: 'idle', transport: 'stdio', command: 'node', enabled: false })
  assert.equal(created.status, 200)
  assert.equal(h.mounted.length, 0, 'enabled:false 不应挂载')
  assert.equal(created.json().value.status, 'disabled')
})

test('入参校验：名称 / 类型 / 命令 / URL / body', async (t) => {
  const h = await build()
  t.after(h.cleanup)

  const cases = [
    [{ name: 'bad name!', transport: 'stdio', command: 'node' }, 'invalid-name'],
    [{ name: 'x'.repeat(33), transport: 'stdio', command: 'node' }, 'invalid-name'],
    [{ name: 'ok', transport: 'ws' }, 'invalid-transport'],
    [{ name: 'ok', transport: 'stdio' }, 'invalid-command'],
    [{ name: 'ok', transport: 'stdio', command: '   ' }, 'invalid-command'],
    [{ name: 'ok', transport: 'http', url: 'ftp://x' }, 'invalid-url'],
  ]
  for (const [body, code] of cases) {
    const res = await h.call('POST', '/servers', body)
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应 400`)
    assert.equal(res.json().error.code, code)
  }

  assert.equal((await h.call('POST', '/servers', '{oops')).status, 400, '坏 JSON 应 400')
  assert.equal((await h.call('POST', '/servers', '[]')).status, 400, '数组 body 应 400')
  const huge = { name: 'ok', transport: 'stdio', command: 'node', env: { A: 'x'.repeat(70 * 1024) } }
  assert.equal((await h.call('POST', '/servers', huge)).status, 400, '超长 body 应 400')
  assert.equal((await h.call('GET', '/nope')).status, 404)
  assert.equal((await h.call('POST', '/state')).status, 404, '方法不对也是 404')
})

test('静态重名不许抢（否则 mcp-client 会拒挂）', async (t) => {
  const h = await build({
    staticEntries: [{ id: 'e1', disabled: false, options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'taken', transport: 'stdio', command: 'node' } } }],
  })
  t.after(h.cleanup)

  const res = await h.call('POST', '/servers', { name: 'taken', transport: 'stdio', command: 'node' })
  assert.equal(res.status, 409)
  assert.match(res.json().error.message, /静态配置/)
})

test('降级：拿不到 mcp-client 时只读可用、新增 503', async (t) => {
  const h = await build({ importFails: true })
  t.after(h.cleanup)

  assert.equal((await h.call('GET', '/ping')).json().value.canAdd, false)
  assert.equal((await h.call('POST', '/servers', { name: 'x', transport: 'stdio', command: 'node' })).status, 503)
  assert.equal((await h.call('GET', '/state')).status, 200, '静态清单仍要能看')
  assert.equal((await h.call('POST', '/servers/x/enabled', { enabled: true })).status, 503)
  assert.equal((await h.call('POST', '/servers/x/reconnect')).status, 503)
})

test('降级：没有 tools 服务时状态是连接失败，而不是假连接', async (t) => {
  const h = await build({ toolsAvailable: false })
  t.after(h.cleanup)

  await h.call('POST', '/servers', { name: 'demo', transport: 'stdio', command: 'node' })
  const view = (await h.call('GET', '/state')).json().value.servers[0]
  assert.equal(view.status, 'error')
  assert.equal(view.toolCount, 0)
})

test('降级：没有 loader 时静态清单为空但接口不炸', async (t) => {
  const h = await build({ loaderAvailable: false })
  t.after(h.cleanup)

  const res = await h.call('GET', '/state')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json().value.staticServers, [])
})

test('状态文件被外部改动时会被感知并重挂', async (t) => {
  const h = await build()
  t.after(h.cleanup)

  await h.call('POST', '/servers', { name: 'one', transport: 'stdio', command: 'node' })
  // 基线是在 apply 时立刻采的，这里等一轮定时器把自身写入消化掉
  await new Promise((resolve) => setTimeout(resolve, 400))

  const current = JSON.parse(readFileSync(h.stateFile, 'utf8'))
  current.servers.push({
    id: 'ext1', name: 'two', transport: 'stdio', command: 'node',
    args: [], env: {}, cwd: '', url: '', headers: {}, enabled: true, createdAt: 1, updatedAt: 1,
  })
  writeFileSync(h.stateFile, JSON.stringify(current, null, 2), 'utf8')

  await new Promise((resolve) => setTimeout(resolve, 700))
  const state = (await h.call('GET', '/state')).json().value
  assert.deepEqual(state.servers.map((s) => s.name).sort(), ['one', 'two'])
  assert.equal(h.mounted.length, 2, '外部新增的也要挂上')
})

test('越权与异常一律拒绝（fail closed）', async (t) => {
  const h = await build()
  t.after(h.cleanup)

  const original = h.ctx.connection.requestRejection
  h.ctx.connection.requestRejection = () => ({ status: 401 })
  assert.equal((await h.call('GET', '/state')).status, 403, '未认证页面应 403')
  h.ctx.connection.requestRejection = () => { throw new Error('boom') }
  assert.equal((await h.call('GET', '/state')).status, 403, '判定抛错也要拒绝')
  h.ctx.connection.requestRejection = original
  assert.equal((await h.call('GET', '/state')).status, 200)
})
