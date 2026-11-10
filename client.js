/**
 * dsh-mcp-config — client half.
 *
 * 在 DSH 设置里加一个「MCP」页（settings.section，id `mcp`）：
 * - 上半部分是 DSH 已经配置好的 MCP 服务（官方加载器 `@deepseek-ai/dsh-mcp-client`
 *   的静态条目），只读展示名称、传输方式、目标和已注册工具数；
 * - 下半部分是用户自己添加的 MCP 服务，可以加 / 改 / 删 / 启停 / 重连，
 *   改动立即生效（Host 动态挂载 / 卸载官方 mcp-client 插件），不需要重启 DSH。
 *
 * 数据全部来自 Host 的 `/dsh-mcp-config/api/*`（同源、由 connection 把关）。
 * 文案走 `ctx.locale` 的 `mcpConfig` 命名空间，跟随 DSH 的语言设置。
 * @module dsh-mcp-config/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-config',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    /** 文案命名空间。 */
    const NS = 'mcpConfig'
    /** 设置页 id。 */
    const SECTION_ID = 'mcp'
    /** Host 路由前缀。 */
    const API_PREFIX = 'dsh-mcp-config/api'
    /** 请求超时（毫秒）：状态读取很快，给 10 秒足够。 */
    const REQUEST_TIMEOUT_MS = 10_000
    /** 服务还在 connecting 时的自轮询间隔（毫秒）。 */
    const POLL_INTERVAL_MS = 1200
    /** 自轮询上限：连不上就别一直转圈，交给用户手动刷新。 */
    const POLL_MAX_TICKS = 15

    const zh = {
      sectionLabel: 'MCP',
      title: 'MCP 服务',
      subtitle: 'DSH 已配置的服务只读展示；下方可自行添加，保存后立即生效，无需重启 DSH。',
      summary: 'DSH 已配置 {static} 个 · 自定义 {custom} 个',
      refresh: '刷新',
      refreshing: '正在刷新…',
      staticTitle: 'DSH 已配置（只读）',
      staticHint: '来自 DSH 的 profile / bundle 配置，由官方加载器管理；如需修改请编辑对应的 cordis.patch.yml。',
      customTitle: '自定义服务',
      customHint: '由 dsh-mcp-config 管理，保存在 ~/.dsh/dsh-mcp-config.json，添加后立即连接并注册工具。',
      add: '＋ 添加 MCP 服务',
      addUnavailable: '动态添加不可用：当前 profile 缺少 @deepseek-ai/dsh-mcp-client。',
      name: '名称',
      nameHint: '工具名前缀 mcp__<名称>__*，需匹配 [A-Za-z0-9_-]，长度 1–32。',
      transport: '类型',
      stdio: 'stdio',
      http: 'http',
      transportHint: 'stdio = 本地进程；http = 远程服务',
      command: '可执行命令',
      commandPlaceholder: '例如 npx、python、C:\\path\\to\\server.exe',
      args: '参数（每行一个）',
      env: '环境变量（每行 key=value）',
      cwd: '工作目录',
      url: 'URL',
      urlPlaceholder: '例如 http://127.0.0.1:9316/mcp',
      headers: '请求头（每行 key=value）',
      enabled: '启用',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      edit: '编辑',
      reconnect: '重连',
      remove: '删除',
      removeConfirm: '确定删除 {name} 吗？它的工具会立即从会话里消失。',
      connected: '已连接',
      connecting: '连接中',
      error: '连接失败',
      disabled: '已停用',
      toolsUnit: '{n} 个工具',
      noTools: '0 个工具',
      staticNoTools: '未注册工具：连接失败，或该服务没有导出任何工具（详情见 DSH 日志）',
      emptyStatic: 'DSH 当前没有静态配置的 MCP 服务。',
      emptyCustom: '还没有自定义 MCP 服务，点上方「添加」开始。',
      loadFailed: '读取 MCP 服务失败',
      retry: '重试',
      optional: '可选',
      required: '必填',
      editTitle: '编辑 MCP 服务',
      addTitle: '添加 MCP 服务',
      duplicateName: '名称 {name} 已被占用',
      target: '目标',
    }

    const en = {
      sectionLabel: 'MCP',
      title: 'MCP servers',
      subtitle: 'Servers configured by DSH are read-only. Add your own below — changes apply immediately, no restart needed.',
      summary: '{static} configured by DSH · {custom} custom',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      staticTitle: 'Configured by DSH (read-only)',
      staticHint: 'From the DSH profile / bundle config, managed by the official loader. Edit the matching cordis.patch.yml to change them.',
      customTitle: 'Custom servers',
      customHint: 'Managed by dsh-mcp-config, stored in ~/.dsh/dsh-mcp-config.json. They connect and register tools as soon as you save.',
      add: '＋ Add MCP server',
      addUnavailable: 'Dynamic add is unavailable: this profile is missing @deepseek-ai/dsh-mcp-client.',
      name: 'Name',
      nameHint: 'Tool-name prefix mcp__<name>__*; must match [A-Za-z0-9_-], length 1–32.',
      transport: 'Type',
      stdio: 'stdio',
      http: 'http',
      transportHint: 'stdio = local process; http = remote',
      command: 'Command',
      commandPlaceholder: 'e.g. npx, python, C:\\path\\to\\server.exe',
      args: 'Arguments (one per line)',
      env: 'Environment (one key=value per line)',
      cwd: 'Working directory',
      url: 'URL',
      urlPlaceholder: 'e.g. http://127.0.0.1:9316/mcp',
      headers: 'Headers (one key=value per line)',
      enabled: 'Enabled',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      edit: 'Edit',
      reconnect: 'Reconnect',
      remove: 'Delete',
      removeConfirm: 'Delete {name}? Its tools disappear from sessions immediately.',
      connected: 'Connected',
      connecting: 'Connecting',
      error: 'Failed',
      disabled: 'Disabled',
      toolsUnit: '{n} tools',
      noTools: '0 tools',
      staticNoTools: 'No tools registered: the connection failed, or the server exports none (see the DSH log).',
      emptyStatic: 'No MCP servers are statically configured in DSH.',
      emptyCustom: 'No custom MCP servers yet — click "Add" to start.',
      loadFailed: 'Could not load MCP servers',
      retry: 'Retry',
      optional: 'optional',
      required: 'required',
      editTitle: 'Edit MCP server',
      addTitle: 'Add MCP server',
      duplicateName: 'The name {name} is already taken',
      target: 'Target',
    }

    const CSS = `
.dms-settings {
  --dms-bg: var(--dsw-alias-bg-base);
  --dms-card: var(--dsw-alias-bg-layer-1);
  --dms-border: var(--dsw-alias-border-l1);
  --dms-text: var(--dsw-alias-label-primary);
  --dms-text-2: var(--dsw-alias-label-secondary);
  --dms-track: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
  --dms-success: var(--dsw-alias-state-success-primary);
  --dms-error: var(--dsw-alias-state-error-primary);
  --dms-warning: var(--dsw-alias-state-warning-primary, #D97706);
  --dms-brand: var(--dsw-alias-brand-primary);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 20px 24px 28px;
  background: var(--dms-bg);
  color: var(--dms-text);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.dms-settings *, .dms-settings *::before, .dms-settings *::after { box-sizing: border-box; }

.dms-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; min-width: 0; }
.dms-heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dms-title { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -0.01em; }
.dms-sub { font-size: 12px; color: var(--dms-text-2); max-width: 70ch; }
.dms-summary { font-size: 12px; color: var(--dms-text-2); }

.dms-card {
  background: var(--dms-card);
  border: 1px solid var(--dms-border);
  border-radius: 14px;
  padding: 16px 18px;
  min-width: 0;
}
.dms-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.dms-card-titlewrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dms-card-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.005em; }
.dms-count {
  flex: none;
  min-width: 22px;
  height: 22px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--dms-track);
  color: var(--dms-text-2);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
.dms-card-hint { margin: 4px 0 0; font-size: 12px; color: var(--dms-text-2); }

.dms-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.dms-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--dms-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--dms-alias-bg-base, var(--dms-bg)) 60%, transparent);
  min-width: 0;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.dms-row:hover { background: var(--dsw-alias-bg-layer-2, var(--dms-track)); }
.dms-row[data-disabled="true"] { opacity: 0.62; }
.dms-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dms-row-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dms-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dms-target { font-size: 12px; color: var(--dms-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dms-error-text { font-size: 12px; color: var(--dms-error); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dms-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  border: 1px solid var(--dms-border);
  color: var(--dms-text-2);
  background: var(--dms-track);
  white-space: nowrap;
}
.dms-badge-dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
.dms-badge[data-status="connected"] { color: var(--dms-success); border-color: color-mix(in srgb, var(--dms-success) 34%, transparent); }
.dms-badge[data-status="connecting"] { color: var(--dms-warning); border-color: color-mix(in srgb, var(--dms-warning) 34%, transparent); }
.dms-badge[data-status="error"] { color: var(--dms-error); border-color: color-mix(in srgb, var(--dms-error) 34%, transparent); }
.dms-badge[data-kind="transport"] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.dms-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.dms-btn {
  -webkit-appearance: none;
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--dms-border);
  background: transparent;
  color: var(--dms-text);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.dms-btn:hover:not(:disabled) { background: var(--dms-track); }
.dms-btn:disabled { opacity: 0.5; cursor: default; }
.dms-btn:focus-visible { outline: 2px solid var(--dms-brand); outline-offset: 1px; }
.dms-btn[data-primary="true"] {
  background: var(--dms-brand);
  border-color: var(--dms-brand);
  color: #ffffff;
}
.dms-btn[data-primary="true"]:hover:not(:disabled) { filter: brightness(1.05); background: var(--dms-brand); }
.dms-btn[data-danger="true"] { color: var(--dms-error); border-color: color-mix(in srgb, var(--dms-error) 32%, transparent); }

.dms-switch {
  -webkit-appearance: none;
  appearance: none;
  position: relative;
  width: 34px;
  height: 20px;
  flex: none;
  border-radius: 999px;
  border: 1px solid var(--dms-border);
  background: var(--dms-track);
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease;
  padding: 0;
}
.dms-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: var(--dms-text-2);
  transition: transform 140ms ease, background-color 140ms ease;
}
.dms-switch[data-on="true"] { background: var(--dms-success); border-color: var(--dms-success); }
.dms-switch[data-on="true"]::after { transform: translateX(14px); background: #ffffff; }
.dms-switch:focus-visible { outline: 2px solid var(--dms-brand); outline-offset: 2px; }
.dms-switch:disabled { opacity: 0.5; cursor: default; }

.dms-empty { padding: 28px 12px; text-align: center; font-size: 13px; color: var(--dms-text-2); }
.dms-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dms-warning) 34%, transparent);
  background: color-mix(in srgb, var(--dms-warning) 10%, transparent);
  color: var(--dms-warning);
  font-size: 12px;
}

.dms-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
  margin-top: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--dms-border);
}
.dms-form-title { grid-column: 1 / -1; margin: 0; font-size: 14px; font-weight: 600; }
.dms-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dms-field-full { grid-column: 1 / -1; }
.dms-field label { font-size: 12px; color: var(--dms-text-2); }
.dms-field label .dms-req { color: var(--dms-error); margin-left: 2px; }
.dms-field input:not([type="checkbox"]), .dms-field textarea {
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--dms-border);
  background: var(--dms-bg);
  color: var(--dms-text);
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
  resize: vertical;
  box-sizing: border-box;
}
.dms-field input:not([type="checkbox"]):focus, .dms-field textarea:focus { outline: 2px solid var(--dms-brand); outline-offset: -1px; border-color: var(--dms-brand); }
.dms-field textarea { min-height: 56px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.dms-field-hint { font-size: 11px; color: var(--dms-text-2); }
.dms-form-actions { grid-column: 1 / -1; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 2px; }
.dms-form-error { grid-column: 1 / -1; margin: 0; font-size: 12px; color: var(--dms-error); }

/* 启用：复选框不再被 input 的 width:100% 拉满，横排对齐到输入框一行 */
.dms-field-check { grid-column: 2; justify-content: flex-end; }
.dms-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dms-text); cursor: pointer; user-select: none; }
.dms-check input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  flex: none;
  accent-color: var(--dms-brand);
  cursor: pointer;
}
.dms-check input[type="checkbox"]:focus-visible { outline: 2px solid var(--dms-brand); outline-offset: 2px; }

/* 分段条：填满所在网格列，两个按钮等分，不再被拉成通长一条 */
.dms-seg {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 10px;
  background: var(--dms-track);
  width: 100%;
  box-sizing: border-box;
}
.dms-seg-btn {
  -webkit-appearance: none;
  appearance: none;
  flex: 1 1 0;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--dms-text-2);
  border-radius: 8px;
  padding: 5px 10px;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
  cursor: pointer;
  white-space: nowrap;
}
.dms-seg-btn[data-active="true"] { background: var(--dms-card); color: var(--dms-text); box-shadow: 0 1px 2px rgba(0,0,0,0.16); }
.dms-seg-btn:focus-visible { outline: 2px solid var(--dms-brand); outline-offset: 1px; }

@media (max-width: 560px) {
  .dms-form { grid-template-columns: minmax(0, 1fr); }
  .dms-field-check { grid-column: 1; }
}
`

    /**
     * 把相对路径解析成绝对 URL（跟随页面 base）。
     * @param {string} path - 以 / 开头或不以 / 开头的路径。
     * @returns {string} 绝对 URL。
     */
    function resolveUrl(path) {
      const relative = String(path).replace(/^\/+/, '')
      try {
        const base = new URL(document.baseURI)
        base.search = ''
        base.hash = ''
        if (!base.pathname.endsWith('/')) base.pathname += '/'
        return new URL(relative, base.href).toString()
      } catch {
        return `/${relative}`
      }
    }

    /**
     * 填充 `{name}` 占位符。
     * @param {string} template - 模板。
     * @param {Record<string, string>} params - 替换值。
     * @returns {string} 结果。
     */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
      )
    }

    /**
     * 调 Host API。
     * @param {string} path - 相对路由，如 `state`、`servers/abc/enabled`。
     * @param {{method?: string, body?: unknown}} [options] - 请求选项。
     * @returns {Promise<unknown>} `value` 字段。
     */
    async function api(path, options = {}) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      let response
      try {
        response = await fetch(resolveUrl(`${API_PREFIX}/${path}`), {
          method: options.method ?? 'GET',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        })
      } catch {
        throw new Error('network')
      } finally {
        clearTimeout(timer)
      }
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok || body === undefined || body.ok !== true) {
        const message = body && body.error ? body.error.message : ''
        throw new Error(typeof message === 'string' && message !== '' ? message : 'request failed')
      }
      return body.value
    }

    /**
     * 把一个服务的目标压成一行可读文本。
     * @param {object} server - 服务视图。
     * @returns {string} 目标文本。
     */
    function targetOf(server) {
      if (server.transport === 'http') return String(server.url ?? '')
      const args = Array.isArray(server.args) ? server.args : []
      return [server.command, ...args].filter((part) => typeof part === 'string' && part !== '').join(' ')
    }

    /**
     * 把多行文本压成数组（去掉空行与首尾空格）。
     * @param {string} text - 多行文本。
     * @returns {string[]} 行数组。
     */
    function linesToArray(text) {
      return String(text ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
    }

    /**
     * 把多行 `key=value` 文本压成对象。
     * @param {string} text - 多行文本。
     * @returns {Record<string, string>} 映射。
     */
    function linesToMap(text) {
      /** @type {Record<string, string>} */
      const result = {}
      for (const line of linesToArray(text)) {
        const index = line.indexOf('=')
        if (index <= 0) continue
        const key = line.slice(0, index).trim()
        const value = line.slice(index + 1).trim()
        if (key !== '') result[key] = value
      }
      return result
    }

    /**
     * 把一个服务对象压成表单草稿。
     * @param {object} server - 服务视图。
     * @returns {object} 草稿。
     */
    function toDraft(server) {
      return {
        name: server.name ?? '',
        transport: server.transport === 'http' ? 'http' : 'stdio',
        command: server.command ?? '',
        args: Array.isArray(server.args) ? server.args.join('\n') : '',
        env: Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
        cwd: server.cwd ?? '',
        url: server.url ?? '',
        headers: Object.entries(server.headers ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
        enabled: server.enabled !== false,
      }
    }

    /**
     * 表单组件。
     * @param {object} props - 属性。
     * @returns {React.ReactNode} 表单节点。
     */
    function ServerForm({ t, title, draft, busy, error, onCancel, onSubmit }) {
      const [form, setForm] = useState(draft)
      const [localError, setLocalError] = useState(null)
      const [argsText, setArgsText] = useState(draft.args ?? '')
      const [envText, setEnvText] = useState(draft.env ?? '')
      const [headersText, setHeadersText] = useState(draft.headers ?? '')

      const update = useCallback((patch) => {
        setForm((prev) => ({ ...prev, ...patch }))
        setLocalError(null)
      }, [])

      const submit = useCallback(async (event) => {
        event.preventDefault()
        const payload = {
          name: form.name,
          transport: form.transport,
          enabled: form.enabled,
        }
        if (form.transport === 'stdio') {
          payload.command = form.command
          payload.args = linesToArray(argsText)
          payload.env = linesToMap(envText)
          payload.cwd = form.cwd
        } else {
          payload.url = form.url
          payload.headers = linesToMap(headersText)
        }
        try {
          await onSubmit(payload)
        } catch (err) {
          setLocalError(err instanceof Error ? err.message : String(err))
        }
      }, [form, argsText, envText, headersText, onSubmit])

      return h('form', { className: 'dms-form', onSubmit: submit, noValidate: true },
        h('h4', { className: 'dms-form-title' }, title),
        h('div', { className: 'dms-field' },
          h('label', null, t('name'), h('span', { className: 'dms-req' }, '*')),
          h('input', {
            type: 'text',
            value: form.name,
            placeholder: 'my-server',
            disabled: busy,
            onChange: (event) => update({ name: event.target.value }),
          }),
          h('div', { className: 'dms-field-hint' }, t('nameHint')),
        ),
        h('div', { className: 'dms-field' },
          h('label', null, t('transport')),
          h('div', { className: 'dms-seg' },
            h('button', {
              type: 'button',
              className: 'dms-seg-btn',
              'data-active': form.transport === 'stdio' ? 'true' : 'false',
              disabled: busy,
              onClick: () => update({ transport: 'stdio' }),
            }, t('stdio')),
            h('button', {
              type: 'button',
              className: 'dms-seg-btn',
              'data-active': form.transport === 'http' ? 'true' : 'false',
              disabled: busy,
              onClick: () => update({ transport: 'http' }),
            }, t('http')),
          ),
          h('div', { className: 'dms-field-hint' }, t('transportHint')),
        ),
        form.transport === 'stdio'
          ? h('div', { className: 'dms-field dms-field-full' },
              h('label', null, t('command'), h('span', { className: 'dms-req' }, '*')),
              h('input', {
                type: 'text',
                value: form.command,
                placeholder: t('commandPlaceholder'),
                disabled: busy,
                onChange: (event) => update({ command: event.target.value }),
              }),
            )
          : null,
        form.transport === 'stdio'
          ? h('div', { className: 'dms-field dms-field-full' },
              h('label', null, t('args'), ` (${t('optional')})`),
              h('textarea', {
                value: argsText,
                disabled: busy,
                placeholder: '-y @modelcontextprotocol/server-filesystem .',
                onChange: (event) => setArgsText(event.target.value),
              }),
            )
          : null,
        form.transport === 'stdio'
          ? h('div', { className: 'dms-field dms-field-full' },
              h('label', null, t('env'), ` (${t('optional')})`),
              h('textarea', {
                value: envText,
                disabled: busy,
                placeholder: 'KEY=value',
                onChange: (event) => setEnvText(event.target.value),
              }),
            )
          : null,
        form.transport === 'stdio'
          ? h('div', { className: 'dms-field' },
              h('label', null, t('cwd'), ` (${t('optional')})`),
              h('input', {
                type: 'text',
                value: form.cwd,
                placeholder: 'C:\\path\\to\\project',
                disabled: busy,
                onChange: (event) => update({ cwd: event.target.value }),
              }),
            )
          : null,
        form.transport === 'http'
          ? h('div', { className: 'dms-field dms-field-full' },
              h('label', null, t('url'), h('span', { className: 'dms-req' }, '*')),
              h('input', {
                type: 'text',
                value: form.url,
                placeholder: t('urlPlaceholder'),
                disabled: busy,
                onChange: (event) => update({ url: event.target.value }),
              }),
            )
          : null,
        form.transport === 'http'
          ? h('div', { className: 'dms-field dms-field-full' },
              h('label', null, t('headers'), ` (${t('optional')})`),
              h('textarea', {
                value: headersText,
                disabled: busy,
                placeholder: 'Authorization=Bearer xxx',
                onChange: (event) => setHeadersText(event.target.value),
              }),
            )
          : null,
        h('div', { className: 'dms-field dms-field-check' },
          h('label', { className: 'dms-check' },
            h('input', {
              type: 'checkbox',
              checked: form.enabled,
              disabled: busy,
              onChange: (event) => update({ enabled: event.target.checked }),
            }),
            h('span', null, t('enabled')),
          ),
        ),
        localError ? h('div', { className: 'dms-form-error' }, localError) : null,
        h('div', { className: 'dms-form-actions' },
          h('button', { type: 'button', className: 'dms-btn', disabled: busy, onClick: onCancel }, t('cancel')),
          h('button', { type: 'submit', className: 'dms-btn', 'data-primary': 'true', disabled: busy }, busy ? t('saving') : t('save')),
        ),
      )
    }

    /**
     * 设置页主组件。
     * @param {object} props - 属性（locale 绑定与 t）。
     * @returns {React.ReactNode} 页面节点。
     */
    function SettingsPage({ t }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const [form, setForm] = useState(null) // null | { mode: 'add' | 'edit', server? }
      const [formError, setFormError] = useState(null)
      const mounted = useRef(true)
      /** 自轮询已走的轮数（连上或放弃后归零）。 */
      const pollTicks = useRef(0)

      const load = useCallback(async (showSpinner = false) => {
        if (showSpinner) setRefreshing(true)
        try {
          const value = await api('state')
          if (!mounted.current) return
          setState(value)
          setError(null)
        } catch (err) {
          if (!mounted.current) return
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          if (mounted.current) setRefreshing(false)
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        load()
        return () => {
          mounted.current = false
        }
      }, [load])

      const submitForm = useCallback(async (payload) => {
        setBusy(true)
        pollTicks.current = 0 // 每次人工操作都重新给自轮询一轮预算
        setFormError(null)
        try {
          if (form && form.mode === 'edit' && form.server) {
            await api(`servers/${encodeURIComponent(form.server.id)}`, { method: 'PUT', body: payload })
          } else {
            await api('servers', { method: 'POST', body: payload })
          }
          setForm(null)
          await load()
        } catch (err) {
          setFormError(err instanceof Error ? err.message : String(err))
          throw err
        } finally {
          setBusy(false)
        }
      }, [form, load])

      const toggleEnabled = useCallback(async (server) => {
        setBusy(true)
        pollTicks.current = 0 // 每次人工操作都重新给自轮询一轮预算
        try {
          await api(`servers/${encodeURIComponent(server.id)}/enabled`, {
            method: 'POST',
            body: { enabled: server.enabled === false },
          })
          await load()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [load])

      const reconnect = useCallback(async (server) => {
        setBusy(true)
        pollTicks.current = 0 // 每次人工操作都重新给自轮询一轮预算
        try {
          await api(`servers/${encodeURIComponent(server.id)}/reconnect`, { method: 'POST' })
          await load()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [load])

      const remove = useCallback(async (server) => {
        if (!window.confirm(fill(t('removeConfirm'), { name: server.name }))) return
        setBusy(true)
        pollTicks.current = 0 // 每次人工操作都重新给自轮询一轮预算
        try {
          await api(`servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' })
          await load()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [load, t])

      const staticServers = useMemo(() => (state && Array.isArray(state.staticServers) ? state.staticServers : []), [state])
      const servers = useMemo(() => (state && Array.isArray(state.servers) ? state.servers : []), [state])
      const canAdd = state ? state.canAdd !== false : true
      const anyConnecting = servers.some((server) => server.status === 'connecting')

      // 官方 mcp-client 是异步连上的：保存 / 重连 / 启用之后状态先停在 connecting，
      // 这时自己隔一会儿补拉一次，别让用户以为没生效还得手点刷新。有上限，连不上就停。
      useEffect(() => {
        if (!anyConnecting) {
          pollTicks.current = 0
          return undefined
        }
        if (pollTicks.current >= POLL_MAX_TICKS) return undefined
        const timer = setTimeout(() => {
          pollTicks.current += 1
          load()
        }, POLL_INTERVAL_MS)
        return () => clearTimeout(timer)
      }, [anyConnecting, state, load])

      /**
       * 一行服务。
       * @param {object} server - 服务视图。
       * @param {boolean} readOnly - 是否只读（静态）。
       * @returns {React.ReactNode} 行节点。
       */
      const renderRow = (server, readOnly) => {
        // 静态行不参与本插件的挂载，只能按「有没有注册出工具」判状态：
        // 开启着却一个工具都没有，就是连不上或没导出工具，标成连接失败而不是永远转圈。
        const status = readOnly
          ? (server.enabled === false ? 'disabled' : (server.toolCount > 0 ? 'connected' : 'error'))
          : (server.status ?? 'connecting')
        const statusLabel = status === 'connected' ? t('connected')
          : status === 'connecting' ? t('connecting')
            : status === 'error' ? t('error')
              : t('disabled')
        const toolsLabel = server.toolCount > 0 ? fill(t('toolsUnit'), { n: server.toolCount }) : t('noTools')
        const hint = (!readOnly && server.error) || (readOnly && status === 'error' ? t('staticNoTools') : null)
        return h('div', { key: server.id, className: 'dms-row', 'data-disabled': status === 'disabled' ? 'true' : 'false' },
          h('div', { className: 'dms-row-main' },
            h('div', { className: 'dms-row-name' },
              h('span', { className: 'dms-name' }, readOnly ? server.serverName : server.name),
              h('span', { className: 'dms-badge', 'data-kind': 'transport' }, server.transport === 'http' ? 'http' : 'stdio'),
              h('span', { className: 'dms-badge', 'data-status': status },
                h('span', { className: 'dms-badge-dot' }),
                `${statusLabel} · ${toolsLabel}`),
            ),
            h('div', { className: 'dms-target' }, targetOf(server)),
            hint ? h('div', { className: 'dms-error-text' }, hint) : null,
          ),
          readOnly
            ? null
            : h('div', { className: 'dms-actions' },
                h('button', {
                  type: 'button',
                  className: 'dms-switch',
                  'data-on': server.enabled === false ? 'false' : 'true',
                  'aria-label': t('enabled'),
                  disabled: busy || server.status === 'connecting',
                  onClick: () => toggleEnabled(server),
                }),
                h('button', { type: 'button', className: 'dms-btn', disabled: busy, onClick: () => { setForm({ mode: 'edit', server }); setFormError(null) } }, t('edit')),
                h('button', { type: 'button', className: 'dms-btn', disabled: busy, onClick: () => reconnect(server) }, t('reconnect')),
                h('button', { type: 'button', className: 'dms-btn', 'data-danger': 'true', disabled: busy, onClick: () => remove(server) }, t('remove')),
              ),
        )
      }

      return h('div', { className: 'dms-settings', 'data-dsh-mcp-config': SECTION_ID, 'aria-label': t('sectionLabel') },
        h('div', { className: 'dms-head' },
          h('div', { className: 'dms-heading' },
            h('h3', { className: 'dms-title' }, t('title')),
            h('div', { className: 'dms-sub' }, t('subtitle')),
            state ? h('div', { className: 'dms-summary' }, fill(t('summary'), { static: staticServers.length, custom: servers.length })) : null,
          ),
          h('button', { type: 'button', className: 'dms-btn', disabled: refreshing, onClick: () => load(true) },
            refreshing ? t('refreshing') : t('refresh')),
        ),
        error ? h('div', { className: 'dms-notice' },
          h('span', null, `${t('loadFailed')}：${error}`),
          h('button', { type: 'button', className: 'dms-btn', onClick: () => load() }, t('retry')),
        ) : null,
        !canAdd ? h('div', { className: 'dms-notice' }, t('addUnavailable')) : null,

        h('div', { className: 'dms-card' },
          h('div', { className: 'dms-card-head' },
            h('div', { className: 'dms-card-titlewrap' },
              h('h4', { className: 'dms-card-title' }, t('staticTitle')),
              h('span', { className: 'dms-count' }, String(staticServers.length)),
            ),
          ),
          h('p', { className: 'dms-card-hint' }, t('staticHint')),
          staticServers.length === 0
            ? h('div', { className: 'dms-empty' }, t('emptyStatic'))
            : h('div', { className: 'dms-list' }, staticServers.map((server) => renderRow(server, true))),
        ),

        h('div', { className: 'dms-card' },
          h('div', { className: 'dms-card-head' },
            h('div', { className: 'dms-card-titlewrap' },
              h('h4', { className: 'dms-card-title' }, t('customTitle')),
              h('span', { className: 'dms-count' }, String(servers.length)),
            ),
            canAdd && !form
              ? h('button', {
                  type: 'button',
                  className: 'dms-btn',
                  'data-primary': 'true',
                  onClick: () => { setForm({ mode: 'add' }); setFormError(null) },
                }, t('add'))
              : null,
          ),
          h('p', { className: 'dms-card-hint' }, t('customHint')),
          form
            ? h(ServerForm, {
                key: form.mode === 'edit' && form.server ? form.server.id : 'add',
                t,
                title: form.mode === 'edit' ? t('editTitle') : t('addTitle'),
                draft: form.mode === 'edit' ? toDraft(form.server) : { name: '', transport: 'stdio', command: '', args: '', env: '', cwd: '', url: '', headers: '', enabled: true },
                busy,
                error: formError,
                onCancel: () => { setForm(null); setFormError(null) },
                onSubmit: submitForm,
              })
            : null,
          !form && servers.length === 0
            ? h('div', { className: 'dms-empty' }, t('emptyCustom'))
            : null,
          !form && servers.length > 0
            ? h('div', { className: 'dms-list' }, servers.map((server) => renderRow(server, false)))
            : null,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 一份样式表：挂载时插入，卸载时移除。
        ctx.effect(() => {
          const element = document.createElement('style')
          element.setAttribute('data-dsh-plugin', 'dsh-mcp-config')
          element.textContent = CSS
          document.head.appendChild(element)
          return () => element.remove()
        }, 'dsh-mcp-config: stylesheet')

        if (typeof ctx.locale?.register === 'function') {
          for (const [id, dict] of [['zh', zh], ['en', en]]) {
            ctx.effect(() => ctx.locale.register(NS, id, dict), `dsh-mcp-config: ${id} dictionary`)
          }
        }

        // 老版本 DSH 的 locale 服务没有 bind()：退化成自带词典（按浏览器语言挑一份），
        // 页面至少不会因为一个缺失的方法整页白掉。
        const bound = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : null
        const fallbackDict = String(globalThis.navigator?.language ?? 'zh').toLowerCase().startsWith('zh') ? zh : en
        const t = bound ?? ((key) => (Object.prototype.hasOwnProperty.call(fallbackDict, key) ? fallbackDict[key] : key))

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 16,
              locale: NS,
              label: () => t('sectionLabel'),
            },
            () => h(SettingsPage, { t }),
          ),
        )
      },
    }
  },
})
