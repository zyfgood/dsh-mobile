/**
 * @zyfgood/dsh-mobile host half.
 *
 * 在 DSH 宿主进程内再起一个只服务手机端的 HTTP(S) 服务：
 *   - 独立端口（默认 35888，绑定 0.0.0.0），不改变桌面 Web GUI 的 127.0.0.1 绑定；
 *   - 访问令牌 + HttpOnly 签名 Cookie，令牌持久化在 ~/.dsh/dsh-mobile/state.json；
 *   - REST 列出/创建会话，SSE 跟随会话事件（含模型流式输出），POST 继续对话/取消；
 *   - 桌面 Web GUI 侧注册 /dsh-mobile/status 与 /dsh-mobile/qr.svg（受桌面登录态保护），
 *     供客户端插件显示二维码和访问链接。
 *
 * 会话读写的唯一来源是宿主 ctx.sessionController：list / page / follow / prompt /
 * cancel / create。插件不直接读写 session JSONL，也不改会话内容。
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile, writeFile, mkdir, rename, chmod, stat } from 'node:fs/promises'
import { homedir, networkInterfaces, hostname } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import qrcode from './vendor/qrcode.mjs'

/** Plugin identity for cordis.yml rows. */
export const name = '@zyfgood/dsh-mobile'

/** Services required before mounting: the session Remote service. */
export const inject = ['sessionController']

const VERSION = '0.1.0'
const STATE_DIR = join(homedir(), '.dsh', 'dsh-mobile')
const STATE_PATH = join(STATE_DIR, 'state.json')
const WEB_ROOT = new URL('./web/', import.meta.url)
const MAX_BODY_BYTES = 256 * 1024
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 20

export const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('启用手机端服务'),
    host: Schema.string().default('0.0.0.0').description('监听地址：0.0.0.0 表示所有网卡，127.0.0.1 表示仅本机'),
    port: Schema.number().min(0).max(65535).default(35888).description('监听端口，0 表示由系统分配'),
    autoPort: Schema.boolean().default(true).description('端口被占用时自动尝试后续端口'),
    publicHost: Schema.string().default('').description('手机访问使用的主机名/IP（留空自动检测局域网 IPv4）'),
    accessToken: Schema.string().default('').description('固定访问令牌（至少 16 字符；留空自动生成并持久化）'),
    tlsCertFile: Schema.string().default('').description('可选的 TLS 证书 PEM 路径'),
    tlsKeyFile: Schema.string().default('').description('可选的 TLS 私钥 PEM 路径'),
    includeSubagents: Schema.boolean().default(false).description('会话列表中包含子代理会话（只读查看）'),
    maxSessions: Schema.number().min(1).max(2000).default(300).description('手机端最多展示的会话数'),
    pageSize: Schema.number().min(10).max(200).default(40).description('每次加载的历史消息数'),
    heartbeatSeconds: Schema.number().min(5).max(60).default(15).description('SSE 心跳间隔（秒）'),
    cookieMaxAgeDays: Schema.number().min(1).max(365).default(30).description('手机登录 Cookie 有效期（天）'),
    defaultCwd: Schema.string().default('').description('新建会话的默认工作目录（留空沿用最近会话）'),
    allowNewSession: Schema.boolean().default(true).description('允许手机端新建会话'),
    desktopPanel: Schema.boolean().default(true).description('在桌面 Web GUI 左下角显示手机访问入口'),
  }).description('DSH 手机端设置'),
])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

/** Best-effort logger that never lets logging break a request. */
function log(ctx, level, message, error) {
  try {
    const logger = ctx?.logger
    if (logger && typeof logger[level] === 'function') logger[level](message, error)
    else if (level === 'error') console.error(message, error ?? '')
    else if (level === 'warn') console.warn(message, error ?? '')
    else console.log(message)
  } catch { /* logging is not part of the contract */ }
}

/** Read one JSON request body with a hard cap. */
async function readJsonBody(req, cap = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > cap) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, '请求体必须是 JSON 对象')
    }
    return parsed
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'JSON 解析失败')
  }
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

function sendJson(res, status, value) {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(text)
}

function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string' || header === '') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key !== '') out[key] = value
  }
  return out
}

function safeEqual(left, right) {
  const a = createHash('sha256').update(String(left)).digest()
  const b = createHash('sha256').update(String(right)).digest()
  return timingSafeEqual(a, b)
}

function normalizeHost(value) {
  const host = String(value || '').trim()
  if (host === '' || host === 'localhost') return '127.0.0.1'
  return host
}

function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '[::]'
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost'
}

/** LAN IPv4 addresses, best candidates first. */
function lanAddresses() {
  const result = []
  let interfaces
  try { interfaces = networkInterfaces() } catch { return result }
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' && entry.family !== 4) continue
      const address = String(entry.address || '')
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) continue
      if (address.startsWith('169.254.') || address.startsWith('0.')) continue
      let score = 1
      if (address.startsWith('192.168.')) score = 5
      else if (address.startsWith('10.')) score = 4
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score = 3
      const lower = name.toLowerCase()
      if (/wi-?fi|wlan|ethernet|以太网|无线/.test(lower)) score += 1
      if (/vethernet|virtualbox|vmware|wsl|docker|hyper-v|loopback|tailscale|zerotier/.test(lower)) score -= 3
      result.push({ name, address, score })
    }
  }
  result.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
  return result
}

function formatHostForUrl(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** Load the mobile page assets once, at plugin activation. */
async function loadAssets() {
  const readAsset = async (name) => {
    const url = new URL(name, WEB_ROOT)
    return { body: await readFile(url), type: MIME[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream' }
  }
  const entries = await Promise.all([
    readAsset('index.html'),
    readAsset('app.js'),
    readAsset('style.css'),
    readAsset('manifest.webmanifest'),
    readAsset('icon.svg'),
    readAsset('icon-180.png'),
    readAsset('icon-512.png'),
  ])
  return new Map([
    ['/', entries[0]],
    ['/index.html', entries[0]],
    ['/app.js', entries[1]],
    ['/style.css', entries[2]],
    ['/manifest.webmanifest', entries[3]],
    ['/icon.svg', entries[4]],
    ['/icon-180.png', entries[5]],
    ['/icon-512.png', entries[6]],
  ])
}

/** Load or create the persistent access token and cookie signing secret. */
async function loadState(ctx, config) {
  let state = undefined
  try {
    const raw = await readFile(STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') state = parsed
  } catch { /* first run or unreadable file */ }

  if (state === undefined) state = {}
  let changed = false

  if (typeof state.cookieSecret !== 'string' || state.cookieSecret.length < 32) {
    state.cookieSecret = randomBytes(32).toString('base64url')
    changed = true
  }

  const configured = typeof config.accessToken === 'string' ? config.accessToken.trim() : ''
  if (configured !== '' && configured.length < 16) {
    throw new Error('dsh-mobile: accessToken 至少需要 16 个字符')
  }
  if (configured !== '') {
    if (state.token !== configured) {
      state.token = configured
      changed = true
    }
  } else if (typeof state.token !== 'string' || state.token.length < 16) {
    state.token = randomBytes(24).toString('base64url')
    changed = true
  }

  if (!Number.isSafeInteger(state.createdAt) || state.createdAt <= 0) {
    state.createdAt = Date.now()
    changed = true
  }

  if (changed) {
    try {
      await mkdir(STATE_DIR, { recursive: true })
      const tmp = join(STATE_DIR, `.state-${process.pid}-${Date.now()}.tmp`)
      await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
      try { await chmod(tmp, 0o600) } catch { /* Windows ACLs are managed by the user profile */ }
      await rename(tmp, STATE_PATH)
    } catch (error) {
      log(ctx, 'error', `[dsh-mobile] 无法保存状态文件 ${STATE_PATH}:`, error)
      throw error
    }
  }
  return state
}

/** One mobile HTTP server plus its session-facing API. */
class MobileServer {
  constructor(ctx, config, assets, state) {
    this.ctx = ctx
    this.config = config
    this.assets = assets
    this.state = state
    this.server = undefined
    this.actualPort = undefined
    this.secure = false
    this.startError = undefined
    this.streams = new Set()
    this.listCache = { at: 0, data: undefined, pending: undefined }
    this.qrCache = undefined
    this.loginAttempts = new Map()
    this.tokenHash = createHash('sha256').update(state.token).digest('hex')
    this.cookieFingerprint = this.tokenHash.slice(0, 16)
    this.cookieName = `dsh_mobile_${this.cookieFingerprint.slice(0, 8)}`
    this.origin = undefined
  }

  describe() {
    if (this.server === undefined) return 'not listening'
    return `${this.secure ? 'https' : 'http'}://${this.config.host}:${this.actualPort}`
  }

  /** Start listening; port conflicts optionally roll forward. */
  async start() {
    if (this.config.enabled === false) {
      this.startError = new Error('手机端服务已在配置中禁用')
      return
    }

    const tlsCertFile = String(this.config.tlsCertFile || '').trim()
    const tlsKeyFile = String(this.config.tlsKeyFile || '').trim()
    if (tlsCertFile !== '' || tlsKeyFile !== '') {
      if (tlsCertFile === '' || tlsKeyFile === '') {
        throw new Error('dsh-mobile: tlsCertFile 与 tlsKeyFile 必须同时配置')
      }
      const [cert, key] = await Promise.all([readFile(tlsCertFile), readFile(tlsKeyFile)])
      this.server = createHttpsServer({ cert, key }, (req, res) => { void this.handle(req, res) })
      this.secure = true
    } else {
      this.server = createHttpServer((req, res) => { void this.handle(req, res) })
    }

    this.server.keepAliveTimeout = 70_000
    this.server.headersTimeout = 75_000
    this.server.requestTimeout = 0
    this.server.on('clientError', (error, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* already gone */ }
      log(this.ctx, 'warn', '[dsh-mobile] client error:', error)
    })

    const host = normalizeHost(this.config.host)
    const basePort = Number(this.config.port) || 0
    const candidates = basePort === 0
      ? [0]
      : this.config.autoPort === false
        ? [basePort]
        : Array.from({ length: 11 }, (_, index) => basePort + index)

    let lastError
    for (const port of candidates) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            this.server.off('listening', onListening)
            reject(error)
          }
          const onListening = () => {
            this.server.off('error', onError)
            resolve()
          }
          this.server.once('error', onError)
          this.server.once('listening', onListening)
          this.server.listen({ host, port })
        })
        const address = this.server.address()
        this.actualPort = typeof address === 'object' && address !== null ? address.port : basePort
        this.origin = `${this.secure ? 'https' : 'http'}://${formatHostForUrl(host)}:${this.actualPort}`
        return
      } catch (error) {
        lastError = error
        if (error?.code !== 'EADDRINUSE') break
      }
    }
    this.startError = lastError
    throw lastError
  }

  /** Stop the listener and every live SSE stream. */
  async stop() {
    for (const stream of [...this.streams]) {
      try { stream.abort.abort() } catch { /* ignore */ }
      try { if (!stream.res.writableEnded) stream.res.end() } catch { /* ignore */ }
    }
    this.streams.clear()
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise((resolve) => {
      let settled = false
      const finish = () => { if (!settled) { settled = true; resolve() } }
      try {
        server.close(finish)
        server.closeAllConnections?.()
      } catch {
        finish()
      }
      setTimeout(finish, 1500).unref?.()
    })
  }

  /** All phone-reachable URLs, best first. */
  urls() {
    const port = this.actualPort
    if (!Number.isSafeInteger(port) || port <= 0) return []
    const scheme = this.secure ? 'https' : 'http'
    const host = normalizeHost(this.config.host)
    const configuredPublic = String(this.config.publicHost || '').trim()
    const entries = []
    const push = (address, label) => {
      if (address === '' || entries.some((entry) => entry.address === address)) return
      const authority = `${formatHostForUrl(address)}:${port}`
      entries.push({
        address,
        label,
        url: `${scheme}://${authority}/`,
        tokenUrl: `${scheme}://${authority}/#token=${encodeURIComponent(this.state.token)}`,
      })
    }
    if (configuredPublic !== '') {
      push(configuredPublic, configuredPublic)
    } else if (isLoopbackHost(host)) {
      push(host, '本机')
    } else {
      for (const item of lanAddresses()) push(item.address, `局域网 · ${item.name}`)
      if (entries.length === 0) push('127.0.0.1', '本机')
    }
    return entries
  }

  /** Status payload for the authenticated desktop panel. */
  status() {
    const urls = this.urls()
    const loopbackOnly = isLoopbackHost(normalizeHost(this.config.host))
    return {
      ok: this.startError === undefined,
      enabled: this.config.enabled !== false,
      running: this.server !== undefined && this.server.listening === true,
      version: VERSION,
      host: this.config.host,
      port: this.actualPort ?? null,
      secure: this.secure,
      urls,
      tokenUrl: urls[0]?.tokenUrl ?? null,
      qrPath: '/dsh-mobile/qr.svg',
      panel: this.config.desktopPanel !== false,
      allowNewSession: this.config.allowNewSession !== false,
      defaultCwd: this.config.defaultCwd || '',
      includeSubagents: this.config.includeSubagents === true,
      loopbackOnly,
      error: this.startError === undefined ? null : String(this.startError?.message ?? this.startError),
      note: loopbackOnly
        ? '当前 host 只绑定了本机回环地址，手机无法访问；请把插件配置的 host 改为 0.0.0.0。'
        : '手机与电脑需在同一局域网。首次使用若手机打不开，请在 Windows 防火墙中允许 DeepSeek Harness / Node 的入站连接。',
    }
  }

  /** Render the access QR as an SVG (generated only for authenticated callers). */
  qrSvg() {
    const tokenUrl = this.status().tokenUrl
    if (typeof tokenUrl !== 'string' || tokenUrl === '') return undefined
    if (this.qrCache?.url === tokenUrl) return this.qrCache.svg
    const qr = qrcode(0, 'M')
    qr.addData(tokenUrl)
    qr.make()
    const count = qr.getModuleCount()
    const margin = 4
    const scale = 8
    const size = (count + margin * 2) * scale
    let path = ''
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (!qr.isDark(row, column)) continue
        path += `M${(column + margin) * scale} ${(row + margin) * scale}h${scale}v${scale}h${-scale}z`
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="260" height="260" shape-rendering="crispEdges" role="img" aria-label="DSH 手机端访问二维码"><rect width="100%" height="100%" fill="#ffffff"/><path d="${path}" fill="#111827"/></svg>`
    this.qrCache = { url: tokenUrl, svg }
    return svg
  }

  /** Whether a request carries a valid signed browser cookie. */
  isAuthenticated(req) {
    const cookies = parseCookies(req.headers.cookie)
    const value = cookies[this.cookieName]
    if (typeof value !== 'string' || value === '') return false
    const index = value.lastIndexOf('.')
    if (index <= 0) return false
    const body = value.slice(0, index)
    const signature = value.slice(index + 1)
    const expected = createHmac('sha256', this.state.cookieSecret).update(body).digest()
    let given
    try { given = Buffer.from(signature, 'base64url') } catch { return false }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
    let payload
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return false }
    if (payload === null || typeof payload !== 'object') return false
    if (payload.v !== 1 || payload.fp !== this.cookieFingerprint) return false
    if (!Number.isSafeInteger(payload.exp) || payload.exp < Date.now()) return false
    return true
  }

  cookieValue() {
    const payload = {
      v: 1,
      fp: this.cookieFingerprint,
      iat: Date.now(),
      exp: Date.now() + Math.max(1, this.config.cookieMaxAgeDays) * 24 * 60 * 60 * 1000,
    }
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', this.state.cookieSecret).update(body).digest('base64url')
    return `${body}.${signature}`
  }

  cookieHeader() {
    const maxAge = Math.max(1, this.config.cookieMaxAgeDays) * 24 * 60 * 60
    return `${this.cookieName}=${this.cookieValue()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`
  }

  clearCookieHeader() {
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secure ? '; Secure' : ''}`
  }

  /** Reject cross-site browser writes even though SameSite=Strict already covers the cookie. */
  originAllowed(req) {
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site === 'cross-site') return false
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '') return true
    try {
      const parsed = new URL(origin)
      const host = req.headers.host
      return typeof host === 'string' && parsed.host === host
    } catch {
      return false
    }
  }

  rateLimited(req) {
    const key = req.socket?.remoteAddress ?? 'unknown'
    const now = Date.now()
    const current = this.loginAttempts.get(key)
    if (current === undefined || current.resetAt < now) {
      this.loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
      if (this.loginAttempts.size > 2000) {
        for (const [candidate, record] of this.loginAttempts) {
          if (record.resetAt < now) this.loginAttempts.delete(candidate)
        }
      }
      return false
    }
    current.count += 1
    return current.count > LOGIN_MAX_ATTEMPTS
  }

  /** Invalidate the short-lived session-list cache. */
  invalidateList() {
    this.listCache.at = 0
    this.listCache.data = undefined
  }

  /** Read and normalize all visible sessions. */
  async listSessions() {
    const now = Date.now()
    if (this.listCache.data !== undefined && now - this.listCache.at < 3000) return this.listCache.data
    if (this.listCache.pending !== undefined) return this.listCache.pending
    this.listCache.pending = (async () => {
      let result
      try {
        result = await this.ctx.sessionController.list({}, AbortSignal.timeout(30_000))
      } catch (error) {
        throw new HttpError(502, `读取会话列表失败：${error?.message ?? String(error)}`, 'session-list-failed')
      }
      const items = Array.isArray(result?.items) ? result.items : []
      const rows = []
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue
        if (item.origin === 'subagent' && this.config.includeSubagents !== true) continue
        rows.push(this.mapRow(item))
        if (rows.length >= this.config.maxSessions) break
      }
      this.listCache.data = rows
      this.listCache.at = Date.now()
      return rows
    })().finally(() => { this.listCache.pending = undefined })
    return this.listCache.pending
  }

  mapRow(item) {
    const values = item.projections?.values ?? {}
    const rawTitle = values.title
    const title = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle.trim() : null
    const rawTodos = values.todos
    const todos = Array.isArray(rawTodos)
      ? rawTodos
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.content === 'string')
        .slice(0, 20)
        .map((entry) => ({ content: entry.content, status: entry.status ?? 'pending' }))
      : null
    return {
      id: String(item.sessionId),
      title,
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      running: item.running === true,
      agentAvailable: item.agentAvailable === true,
      blank: item.blank === true,
      cwd: typeof item.cwd === 'string' ? item.cwd : (typeof values.workingDirectory === 'string' ? values.workingDirectory : null),
      origin: typeof item.origin === 'string' ? item.origin : null,
      parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : null,
      formatStatus: typeof item.formatStatus === 'string' ? item.formatStatus : null,
      agentPreset: typeof values.agentPreset === 'string' ? values.agentPreset : null,
      todos,
    }
  }

  async findSession(id) {
    const rows = await this.listSessions()
    return rows.find((row) => row.id === id)
  }

  /** Resolve the durable address a session row needs for follow/page. */
  async addressFor(id) {
    const row = await this.findSession(id)
    if (row?.origin === 'subagent' && typeof row.parentSessionId === 'string') {
      return { kind: 'subagent', parentSessionId: row.parentSessionId, childSessionId: id, mode: 'unknown' }
    }
    return { kind: 'session', sessionId: id }
  }

  async recentCwd() {
    try {
      const rows = await this.listSessions()
      const row = rows.find((candidate) => typeof candidate.cwd === 'string' && candidate.cwd !== '')
      return row?.cwd
    } catch { return undefined }
  }

  /** HTTP entry point. */
  async handle(req, res) {
    const started = Date.now()
    try {
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('x-frame-options', 'DENY')
      if (this.secure) res.setHeader('strict-transport-security', 'max-age=86400')

      const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : 'localhost'
      const url = new URL(req.url ?? '/', `http://${hostHeader}`)
      const pathname = decodeURIComponentSafe(url.pathname)

      if (pathname === '/api/health') {
        sendJson(res, 200, { ok: true, version: VERSION, service: 'dsh-mobile' })
        return
      }
      if (pathname === '/api/me') {
        const authenticated = this.isAuthenticated(req)
        sendJson(res, 200, {
          ok: true,
          authenticated,
          version: VERSION,
          host: hostname(),
          allowNewSession: this.config.allowNewSession !== false,
          defaultCwd: this.config.defaultCwd || '',
        })
        return
      }
      if (pathname === '/api/login' && req.method === 'POST') {
        await this.handleLogin(req, res)
        return
      }
      if (pathname === '/api/logout' && req.method === 'POST') {
        res.setHeader('set-cookie', this.clearCookieHeader())
        sendJson(res, 200, { ok: true })
        return
      }

      if (pathname.startsWith('/api/')) {
        if (!this.isAuthenticated(req)) {
          sendJson(res, 401, { ok: false, error: '未登录或登录已过期', code: 'unauthorized' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && !this.originAllowed(req)) {
          sendJson(res, 403, { ok: false, error: '跨站请求被拒绝', code: 'bad-origin' })
          return
        }
        await this.handleApi(req, res, url, pathname)
        return
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname === '/favicon.ico') {
          res.statusCode = 204
          res.end()
          return
        }
        const key = pathname === '' ? '/' : pathname
        const asset = this.assets.get(key)
        if (asset === undefined) {
          sendText(res, 404, 'Not found')
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', asset.type)
        res.setHeader('cache-control', 'no-cache')
        res.setHeader('x-content-type-options', 'nosniff')
        if (asset.type.startsWith('text/html')) {
          res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        }
        if (req.method === 'HEAD') {
          res.setHeader('content-length', String(asset.body.length))
          res.end()
          return
        }
        res.end(asset.body)
        return
      }

      sendJson(res, 405, { ok: false, error: 'method not allowed' })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (status >= 500) log(this.ctx, 'error', `[dsh-mobile] ${req.method} ${req.url} failed (${Date.now() - started}ms):`, error)
      if (res.headersSent) {
        try { res.end() } catch { /* ignore */ }
        return
      }
      const payload = {
        ok: false,
        error: error instanceof HttpError ? error.message : '服务器内部错误',
        ...(error?.code === undefined ? {} : { code: error.code }),
      }
      if (!(error instanceof HttpError)) payload.detail = String(error?.message ?? error)
      sendJson(res, status, payload)
    }
  }

  async handleLogin(req, res) {
    if (this.rateLimited(req)) {
      res.setHeader('retry-after', '900')
      sendJson(res, 429, { ok: false, error: '尝试次数过多，请稍后再试', code: 'rate-limited' })
      return
    }
    if (!this.originAllowed(req)) {
      sendJson(res, 403, { ok: false, error: '跨站请求被拒绝', code: 'bad-origin' })
      return
    }
    let body
    try { body = await readJsonBody(req, 16 * 1024) } catch (error) {
      sendJson(res, error.status ?? 400, { ok: false, error: error.message })
      return
    }
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (token === '' || !safeEqual(token, this.state.token)) {
      sendJson(res, 401, { ok: false, error: '访问码不正确', code: 'invalid-token' })
      return
    }
    const key = req.socket?.remoteAddress
    if (key !== undefined) this.loginAttempts.delete(key)
    res.setHeader('set-cookie', this.cookieHeader())
    sendJson(res, 200, { ok: true, authenticated: true })
  }

  async handleApi(req, res, url, pathname) {
    if (pathname === '/api/sessions') {
      if (req.method === 'GET') {
        const rows = await this.listSessions()
        sendJson(res, 200, { ok: true, items: rows, now: Date.now() })
        return
      }
      if (req.method === 'POST') {
        if (this.config.allowNewSession === false) {
          sendJson(res, 403, { ok: false, error: '当前配置不允许新建会话', code: 'new-session-disabled' })
          return
        }
        const body = await readJsonBody(req)
        const requested = typeof body.cwd === 'string' ? body.cwd.trim() : ''
        const cwd = requested !== ''
          ? requested
          : (this.config.defaultCwd || await this.recentCwd() || process.cwd())
        let info
        try { info = await stat(cwd) } catch { info = undefined }
        if (info === undefined || !info.isDirectory()) {
          sendJson(res, 400, { ok: false, error: `目录不存在或不是文件夹：${cwd}`, code: 'bad-cwd' })
          return
        }
        let created
        try {
          created = await this.ctx.sessionController.create({ cwd })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error), code: error?.code ?? 'create-failed' })
          return
        }
        this.invalidateList()
        sendJson(res, 200, { ok: true, sessionId: String(created.sessionId), cwd })
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    const match = /^\/api\/sessions\/([^/]+)(?:\/(stream|page|prompt|cancel))?$/.exec(pathname)
    if (match === null) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const sessionId = match[1]
    if (sessionId === '') {
      sendJson(res, 400, { ok: false, error: '缺少会话 ID' })
      return
    }
    const action = match[2]

    if (action === undefined && req.method === 'GET') {
      const row = await this.findSession(sessionId)
      if (row === undefined) {
        sendJson(res, 404, { ok: false, error: '会话不存在', code: 'session/not-found' })
        return
      }
      sendJson(res, 200, { ok: true, session: row })
      return
    }

    if (action === 'stream' && req.method === 'GET') {
      await this.handleStream(req, res, sessionId)
      return
    }

    if (action === 'page' && req.method === 'GET') {
      const through = url.searchParams.get('throughSeq')
      const throughSeq = through === null ? undefined : Number(through)
      if (!Number.isSafeInteger(throughSeq) || throughSeq < -1) {
        sendJson(res, 400, { ok: false, error: 'throughSeq 必须是 >= -1 的整数', code: 'bad-request' })
        return
      }
      const beforeRaw = url.searchParams.get('beforeSeq')
      const beforeSeq = beforeRaw === null ? undefined : Number(beforeRaw)
      if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
        sendJson(res, 400, { ok: false, error: 'beforeSeq 必须是非负整数', code: 'bad-request' })
        return
      }
      const maxRaw = Number(url.searchParams.get('maxMessages') ?? this.config.pageSize)
      const maxMessages = Number.isSafeInteger(maxRaw) ? Math.min(200, Math.max(10, maxRaw)) : this.config.pageSize
      try {
        const address = await this.addressFor(sessionId)
        const page = await this.ctx.sessionController.page({
          address,
          throughSeq,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          maxMessages,
        }, AbortSignal.timeout(30_000))
        sendJson(res, 200, { ok: true, ...page })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error), code: error?.code ?? 'page-failed' })
      }
      return
    }

    if (action === 'prompt' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '') {
        sendJson(res, 400, { ok: false, error: '消息不能为空', code: 'empty-prompt' })
        return
      }
      if (text.length > 32_768) {
        sendJson(res, 400, { ok: false, error: '消息过长（上限 32k 字符）', code: 'prompt-too-long' })
        return
      }
      const row = await this.findSession(sessionId)
      if (row?.origin === 'subagent') {
        sendJson(res, 400, { ok: false, error: '暂不支持从手机端直接向子代理会话发送消息', code: 'subagent-not-writable' })
        return
      }
      const requestId = randomUUID()
      try {
        const result = await this.ctx.sessionController.prompt({
          requestId,
          sessionId,
          mode: body.mode === 'steer' ? 'steer' : 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }, AbortSignal.timeout(30_000))
        this.invalidateList()
        sendJson(res, 200, { ok: true, accepted: result?.accepted === true, requestId })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error), code: error?.code ?? 'prompt-failed' })
      }
      return
    }

    if (action === 'cancel' && req.method === 'POST') {
      try {
        const result = this.ctx.sessionController.cancel({ sessionId })
        this.invalidateList()
        sendJson(res, 200, { ok: true, accepted: result?.accepted === true })
      } catch (error) {
        sendJson(res, 409, { ok: false, error: String(error?.message ?? error), code: error?.code ?? 'cancel-failed' })
      }
      return
    }

    sendJson(res, 405, { ok: false, error: 'method not allowed' })
  }

  /** Open one follow stream and relay it as SSE. */
  async handleStream(req, res, sessionId) {
    const address = await this.addressFor(sessionId)
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-store, no-transform')
    res.setHeader('connection', 'keep-alive')
    res.setHeader('x-accel-buffering', 'no')
    res.flushHeaders?.()
    res.write(': connected\n\n')

    const abort = new AbortController()
    const stream = { res, abort }
    this.streams.add(stream)
    let heartbeat
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      this.streams.delete(stream)
      if (!abort.signal.aborted) abort.abort()
      try { if (!res.writableEnded) res.end() } catch { /* ignore */ }
    }
    // Do not listen on req 'close' here: Node emits it when the request body is
    // complete, which for a long-lived SSE GET would abort the stream at once.
    req.on('aborted', cleanup)
    res.on('close', cleanup)
    heartbeat = setInterval(() => {
      if (res.writableEnded) { cleanup(); return }
      try { res.write(': ping\n\n') } catch { cleanup() }
    }, Math.max(5, this.config.heartbeatSeconds) * 1000)
    heartbeat.unref?.()

    try {
      const iterator = this.ctx.sessionController.follow({
        address,
        assistantStream: true,
        maxMessages: this.config.pageSize,
        turnWindow: {
          minMessages: Math.min(20, this.config.pageSize),
          minTurns: 1,
        },
      }, abort.signal)
      for await (const frame of iterator) {
        if (abort.signal.aborted) break
        if (frame === null || typeof frame !== 'object') continue
        if (frame.type === 'snapshot') {
          await this.writeSse(res, abort.signal, 'snapshot', frame)
        } else if (frame.type === 'event') {
          await this.writeSse(res, abort.signal, 'record', frame.event, frame.event?.seq)
        } else if (frame.type === 'assistant-stream') {
          await this.writeSse(res, abort.signal, 'assistant', frame.frame)
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        await this.writeSse(res, abort.signal, 'error', {
          ok: false,
          error: String(error?.message ?? error),
          ...(error?.code === undefined ? {} : { code: error.code }),
        })
      }
    } finally {
      cleanup()
    }
  }

  /** Write one SSE frame, honoring backpressure and disconnects. */
  writeSse(res, signal, event, data, id) {
    if (res.writableEnded || signal.aborted) return Promise.resolve(false)
    let payload = ''
    if (id !== undefined && id !== null) payload += `id: ${String(id)}\n`
    payload += `event: ${event}\n`
    payload += `data: ${JSON.stringify(data)}\n\n`
    if (res.write(payload)) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        res.off('drain', onDrain)
        res.off('close', onClose)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onDrain = () => finish(true)
      const onClose = () => finish(false)
      const onAbort = () => finish(false)
      res.once('drain', onDrain)
      res.once('close', onClose)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Register the authenticated desktop routes for the QR/status panel. */
  registerDesktopRoutes() {
    const webServer = this.ctx.get('webServer')
    const connection = this.ctx.get('connection')
    if (webServer === undefined || connection === undefined) {
      log(this.ctx, 'warn', '[dsh-mobile] 未检测到 webServer/connection，桌面入口不可用（手机端服务不受影响）')
      return
    }
    const fence = (req) => {
      try { return connection.requestRejection(req) === undefined } catch { return false }
    }
    this.ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/dsh-mobile',
      handler: (req, res) => {
        if (!fence(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const rest = pathname.replace(/^\/dsh-mobile/, '')
        if (rest === '' || rest === '/' || rest === '/status') {
          sendJson(res, 200, this.status())
          return
        }
        if (rest === '/qr.svg') {
          let svg
          try { svg = this.qrSvg() } catch (error) {
            log(this.ctx, 'error', '[dsh-mobile] QR generation failed:', error)
            sendJson(res, 500, { ok: false, error: '二维码生成失败' })
            return
          }
          if (svg === undefined) {
            sendJson(res, 404, { ok: false, error: '没有可用的局域网地址' })
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', 'image/svg+xml; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(svg)
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }), 'dsh-mobile: desktop routes')
  }
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

/** Plugin body. */
export async function apply(ctx, config) {
  const assets = await loadAssets()
  const state = await loadState(ctx, config)
  const server = new MobileServer(ctx, config, assets, state)

  try {
    await server.start()
    log(ctx, 'info', `[dsh-mobile] listening on ${server.describe()}`)
  } catch (error) {
    server.startError = error
    log(ctx, 'error', '[dsh-mobile] 手机端服务启动失败；桌面入口仍会显示错误信息:', error)
  }

  try {
    server.registerDesktopRoutes()
  } catch (error) {
    log(ctx, 'warn', '[dsh-mobile] 桌面入口注册失败；手机端服务不受影响:', error)
  }

  ctx.effect(() => {
    const offEvent = ctx.on('session/event', (_session, event) => {
      const type = event?.type
      if (type === 'turn/start' || type === 'turn/end' || type === 'user/message' || type === 'session/title') {
        server.invalidateList()
      }
    })
    const offCreated = ctx.on('session/created', () => { server.invalidateList() })
    return async () => {
      offEvent()
      offCreated()
      await server.stop()
    }
  }, 'dsh-mobile: server lifecycle')
}
