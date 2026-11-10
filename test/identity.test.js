/**
 * Identity and packaging checks.
 *
 * A DSH plugin carries its identity in four places — `package.json` name, the
 * bundle patch's insert row, `window.__ModuleLoader__.load({ id })` in
 * client.js and (outside this repo) the profile's dependency key. Get them out
 * of step and the desktop app boots into `import failed` / duplicate factory
 * crashes, so they are pinned here rather than trusted to memory.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (name) => readFileSync(join(root, name), 'utf8')
const pkg = JSON.parse(read('package.json'))
const clientSource = read('client.js')

/** 从 client.js 里揪出 `const zh = {...}` / `const en = {...}` 两个词典。 */
function dictionaries() {
  // 仓库里既有 LF 也有 CRLF 检出，正则两种都要吃得下。
  const zhBlock = /const zh = (\{[\s\S]*?\r?\n {4}\})\r?\n/.exec(clientSource)
  const enBlock = /const en = (\{[\s\S]*?\r?\n {4}\})\r?\n/.exec(clientSource)
  assert.ok(zhBlock && enBlock, 'client.js 里应能找到 zh / en 两个词典字面量')
  const evaluate = (literal) => new Function(`return ${literal}`)()
  return { zh: evaluate(zhBlock[1]), en: evaluate(enBlock[1]) }
}

test('四处身份里的三处必须同名', () => {
  assert.match(pkg.name, /^[a-z0-9][a-z0-9-]*$/)

  const patch = read('cordis.patch.yml')
  const rowName = /-\s+insert:[\s\S]*?name:\s*'([^']+)'/.exec(patch)?.at(1)
  assert.equal(rowName, pkg.name, 'cordis.patch.yml 的 insert 行 name 必须等于包名')

  const moduleId = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(clientSource)?.at(1)
  assert.equal(moduleId, pkg.name, 'client.js 注册的模块 id 必须等于包名（浏览器按 Loader 行名找 factory）')
})

test('host 与 client 用同一个路由前缀', () => {
  const hostPrefix = /const API_PREFIX = '([^']+)'/.exec(read('index.js'))?.at(1)
  const clientPrefix = /const API_PREFIX = '([^']+)'/.exec(clientSource)?.at(1)
  assert.equal(hostPrefix, '/dsh-mcp-config/api')
  assert.equal(clientPrefix, 'dsh-mcp-config/api', 'client 侧不带前导斜杠，由 resolveUrl 拼')
  assert.equal(clientPrefix, hostPrefix.slice(1))
})

test('files 白名单里的每一条都真的存在', () => {
  for (const entry of pkg.files) {
    if (entry.includes('*')) {
      const dir = entry.split('/')[0]
      assert.ok(existsSync(join(root, dir)), `${entry} 指向的目录不存在`)
      continue
    }
    assert.ok(existsSync(join(root, entry)), `${entry} 不存在`)
  }
  assert.ok(pkg.files.includes('LICENSE'), 'MIT 声明要带上 LICENSE 文件')
})

test('manifest 声明齐全', () => {
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-locale'])
  assert.equal(pkg.license, 'MIT')
  assert.ok(pkg.repository?.url.includes(pkg.name), 'repository 应与包名同源')
  assert.ok(pkg.homepage?.includes(pkg.name))
  assert.ok(pkg.bugs?.url)
})

test('test 脚本指到的文件都存在（不许假通过）', () => {
  const files = pkg.scripts.test.split(/\s+/).filter((part) => part.endsWith('.js'))
  assert.ok(files.length > 0)
  for (const file of files) assert.ok(existsSync(join(root, file)), `${file} 不存在`)
})

test('中英词典键集一致，且没有空文案', () => {
  const { zh, en } = dictionaries()
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh / en 键必须一一对应')
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, 'string')
    assert.notEqual(value.trim(), '', `zh.${key} 是空文案`)
  }
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string')
    assert.notEqual(value.trim(), '', `en.${key} 是空文案`)
  }
})

test('占位符在两种语言里一致', () => {
  const { zh, en } = dictionaries()
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
  for (const key of Object.keys(zh)) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} 的占位符不一致`)
  }
})

test('client 里用到的每个 t() 键都在词典里', () => {
  const { zh } = dictionaries()
  const used = new Set([...clientSource.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]))
  assert.ok(used.size > 10, '应能扫到足够多的文案键')
  for (const key of used) assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `缺少文案键 ${key}`)
})

test('client 里用到的每个 dms- CSS 类都有定义', () => {
  const used = new Set([...clientSource.matchAll(/className: '([^']+)'/g)].flatMap((match) => match[1].split(/\s+/)))
  for (const token of used) {
    const cls = token.replace(/^dms-/, '')
    assert.ok(clientSource.includes(`.dms-${cls}`), `CSS 缺少 .${token}`)
  }
})

test('README 与包名、状态文件名保持一致', () => {
  const readme = read('README.md')
  assert.ok(readme.includes(`# ${pkg.name}`), 'README 标题应是包名')
  assert.ok(readme.includes(`${pkg.name}.json`), 'README 应写对状态文件名')
  assert.equal(/dsh-mcp-settings/.test(readme + clientSource + read('index.js')), false, '不应残留旧包名')
})
