/**
 * DSH 手机端前端：无构建步骤的原生 ES 模块。
 *
 * - 会话列表来自 GET /api/sessions；
 * - 会话内容通过 EventSource 订阅 /api/sessions/:id/stream（服务端转发
 *   sessionController.follow 的 snapshot / event / assistant-stream 帧）；
 * - 继续对话走 POST /api/sessions/:id/prompt；
 * - 历史翻页走 GET /api/sessions/:id/page。
 */

const $ = (id) => document.getElementById(id)

const bootEl = $('boot')
const loginEl = $('login')
const loginForm = $('login-form')
const tokenInput = $('token-input')
const loginButton = $('login-button')
const loginError = $('login-error')
const appEl = $('app')
const topbarTitle = $('topbar-title')
const topbarSub = $('topbar-sub')
const backButton = $('back-button')
const cancelButton = $('cancel-button')
const menuButton = $('menu-button')
const menuEl = $('menu')
const menuRefresh = $('menu-refresh')
const menuNew = $('menu-new')
const menuBlank = $('menu-blank')
const menuReasoning = $('menu-reasoning')
const menuTools = $('menu-tools')
const menuLogout = $('menu-logout')
const connBanner = $('conn-banner')
const mainEl = $('main')
const listView = $('list-view')
const chatView = $('chat-view')
const sessionListEl = $('session-list')
const listEmpty = $('list-empty')
const listEmptyTitle = listEmpty.querySelector('.empty-title')
const listEmptySub = listEmpty.querySelector('.empty-sub')
const sessionCount = $('session-count')
const searchInput = $('search-input')
const refreshButton = $('refresh-button')
const messagesEl = $('messages')
const loadOlderButton = $('load-older')
const scrollBottomButton = $('scroll-bottom')
const typingEl = $('typing')
const typingText = $('typing-text')
const composerEl = $('composer')
const composerInput = $('composer-input')
const sendButton = $('send-button')
const composerHint = $('composer-hint')
const newDialog = $('new-dialog')
const newForm = $('new-form')
const newCwd = $('new-cwd')
const newCancel = $('new-cancel')
const newCreate = $('new-create')
const newError = $('new-error')
const cwdChips = $('cwd-chips')
const toastEl = $('toast')

const state = {
  authed: false,
  sessions: [],
  filter: '',
  view: 'list',
  currentId: null,
  current: null,
  records: [],
  seqs: new Set(),
  pending: [],
  live: null,
  es: null,
  esState: 'idle',
  throughSeq: null,
  oldestSeq: null,
  hasMore: false,
  loadingOlder: false,
  running: false,
  pinned: true,
  listLoading: false,
  listTimer: null,
  tickTimer: null,
  allowNewSession: true,
  defaultCwd: '',
  lastCwd: localStorage.getItem('dsh-mobile-last-cwd') || '',
  showTools: localStorage.getItem('dsh-mobile-show-tools') === '1',
  showReasoning: localStorage.getItem('dsh-mobile-show-reasoning') === '1',
  showBlank: localStorage.getItem('dsh-mobile-show-blank') === '1',
  autoFillBusy: false,
  menuOpen: false,
  routeToken: 0,
}

let toastTimer
let sendLock = false

/* ── utilities ─────────────────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
}

function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.random() * 16 | 0
    return (char === 'x' ? random : (random & 0x3 | 0x8)).toString(16)
  })
}

function shortPath(path) {
  if (typeof path !== 'string' || path === '') return ''
  const normalized = path.replace(/\\/g, '/')
  if (normalized.length <= 42) return path
  const parts = normalized.split('/').filter(Boolean)
  const tail = parts.slice(-2).join('/')
  return `…/${tail}`
}

function shortId(id) {
  return String(id || '').replace(/^session-/, '').slice(0, 8)
}

function formatRelative(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const delta = Math.max(0, Date.now() - timestamp)
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

function formatClock(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const date = new Date(timestamp)
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function toast(message, isError = false) {
  if (typeof message !== 'string' || message === '') return
  toastEl.textContent = message
  toastEl.classList.toggle('error', isError === true)
  toastEl.hidden = false
  requestAnimationFrame(() => toastEl.classList.add('show'))
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show')
    setTimeout(() => { toastEl.hidden = true }, 220)
  }, isError ? 4200 : 2600)
}

function setConnBanner(text) {
  if (typeof text === 'string' && text !== '') {
    connBanner.textContent = text
    connBanner.hidden = false
  } else {
    connBanner.hidden = true
    connBanner.textContent = ''
  }
}

function isNearBottom() {
  return chatView.scrollHeight - chatView.scrollTop - chatView.clientHeight < 120
}

function scrollToBottom(force = false) {
  if (!force && !state.pinned) return
  state.pinned = true
  requestAnimationFrame(() => {
    chatView.scrollTop = chatView.scrollHeight
    scrollBottomButton.hidden = true
  })
}

function updateScrollButton() {
  const pinned = isNearBottom()
  state.pinned = pinned
  scrollBottomButton.hidden = pinned || state.view !== 'chat'
}

/* ── API ───────────────────────────────────────────────────────────── */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (options.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json'
  }
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers,
  })
  let data
  try { data = await response.json() } catch { data = undefined }
  if (response.status === 401) {
    showLogin('登录已过期，请重新输入访问码')
    const error = new Error('未登录')
    error.code = 'unauthorized'
    throw error
  }
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || `请求失败（HTTP ${response.status}）`)
    error.code = data?.code
    error.status = response.status
    throw error
  }
  return data ?? {}
}

/* ── auth / boot ───────────────────────────────────────────────────── */

function tokenFromHash() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
  if (!hash.startsWith('token=')) return ''
  try { return decodeURIComponent(hash.slice('token='.length)) } catch { return '' }
}

function clearTokenHash() {
  if (location.hash.startsWith('#token=')) {
    history.replaceState(null, '', location.pathname + location.search)
  }
}

function showLogin(message = '') {
  state.authed = false
  closeStream()
  stopTimers()
  appEl.hidden = true
  loginEl.hidden = false
  bootEl.classList.add('hide')
  setTimeout(() => { bootEl.hidden = true }, 260)
  loginError.textContent = message
  const token = tokenFromHash()
  if (token !== '' && tokenInput.value === '') tokenInput.value = token
  setTimeout(() => tokenInput.focus(), 80)
}

function enterApp(me) {
  state.authed = true
  state.allowNewSession = me?.allowNewSession !== false
  state.defaultCwd = typeof me?.defaultCwd === 'string' ? me.defaultCwd : ''
  menuNew.hidden = !state.allowNewSession
  renderSettingsMenu()
  loginEl.hidden = true
  appEl.hidden = false
  bootEl.classList.add('hide')
  setTimeout(() => { bootEl.hidden = true }, 260)
  requestAnimationFrame(() => autoGrow())
}

async function login(token) {
  const trimmed = String(token || '').trim()
  if (trimmed === '') {
    loginError.textContent = '请输入访问码'
    return false
  }
  loginButton.disabled = true
  loginButton.textContent = '正在验证…'
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: trimmed }),
    })
    let data
    try { data = await response.json() } catch { data = undefined }
    if (!response.ok || data?.ok !== true) {
      loginError.textContent = data?.error || '访问码不正确'
      return false
    }
    clearTokenHash()
    tokenInput.value = ''
    loginError.textContent = ''
    const meResponse = await fetch('/api/me', { credentials: 'same-origin' })
    const me = await meResponse.json()
    enterApp(me)
    await loadSessions()
    void routeFromHash()
    startTimers()
    return true
  } catch (error) {
    loginError.textContent = `登录失败：${error?.message ?? error}`
    return false
  } finally {
    loginButton.disabled = false
    loginButton.textContent = '进入'
  }
}

async function boot() {
  try {
    const response = await fetch('/api/me', { credentials: 'same-origin' })
    const me = await response.json()
    if (me?.authenticated === true) {
      clearTokenHash()
      enterApp(me)
      await loadSessions()
      void routeFromHash()
      startTimers()
      return
    }
    const token = tokenFromHash()
    if (token !== '') {
      const ok = await login(token)
      if (ok) return
      showLogin(loginError.textContent || '访问码无效')
      return
    }
    showLogin()
  } catch (error) {
    showLogin(`无法连接 DSH 手机端服务：${error?.message ?? error}`)
  }
}

function startTimers() {
  stopTimers()
  state.listTimer = setInterval(() => {
    if (!state.authed || document.hidden) return
    if (state.view === 'list') void loadSessions({ silent: true })
  }, 10_000)
  state.tickTimer = setInterval(() => {
    if (!state.authed || document.hidden) return
    if (state.view === 'list') renderList()
  }, 30_000)
}

function stopTimers() {
  if (state.listTimer !== null) { clearInterval(state.listTimer); state.listTimer = null }
  if (state.tickTimer !== null) { clearInterval(state.tickTimer); state.tickTimer = null }
}

/* ── routing ───────────────────────────────────────────────────────── */

async function routeFromHash() {
  if (!state.authed) return
  const match = /^#\/s\/(.+)$/.exec(location.hash)
  if (match === null) {
    showList()
    return
  }
  let id
  try { id = decodeURIComponent(match[1]) } catch { id = match[1] }
  await openSession(id)
}

function showList() {
  if (state.view === 'list' && state.currentId === null) {
    renderTopbar()
    renderList()
    return
  }
  closeStream()
  state.routeToken += 1
  state.view = 'list'
  state.currentId = null
  state.current = null
  state.records = []
  state.seqs.clear()
  state.pending = []
  state.live = null
  state.throughSeq = null
  state.oldestSeq = null
  state.hasMore = false
  state.running = false
  listView.hidden = false
  chatView.hidden = true
  composerEl.hidden = true
  setConnBanner('')
  renderTopbar()
  renderList()
  renderMessages()
  if (state.sessions.length === 0) void loadSessions()
}

async function openSession(id) {
  if (!state.authed || typeof id !== 'string' || id === '') return
  if (state.view === 'chat' && state.currentId === id) return
  const token = ++state.routeToken
  let row = state.sessions.find((candidate) => candidate.id === id)
  if (row === undefined) {
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}`)
      row = data.session
    } catch (error) {
      toast(error?.message ?? '会话不存在', true)
      location.replace('#/')
      return
    }
  }
  if (token !== state.routeToken) return

  closeStream()
  state.view = 'chat'
  state.currentId = id
  state.current = { ...row }
  state.records = []
  state.seqs.clear()
  state.pending = []
  state.live = null
  state.throughSeq = null
  state.oldestSeq = null
  state.hasMore = false
  state.running = row?.running === true
  state.pinned = true
  listView.hidden = true
  chatView.hidden = false
  composerEl.hidden = false
  requestAnimationFrame(() => autoGrow())
  setConnBanner('正在连接会话…')
  renderTopbar()
  messagesEl.replaceChildren()
  const loading = document.createElement('div')
  loading.className = 'empty'
  loading.innerHTML = '<div class="empty-icon">💬</div><div class="empty-title">正在加载会话…</div>'
  messagesEl.append(loading)
  renderTyping()
  startStream(id, token)
  chatView.scrollTop = 0
}

/* ── session list ──────────────────────────────────────────────────── */

async function loadSessions(options = {}) {
  if (!state.authed) return
  if (state.listLoading) return
  state.listLoading = true
  try {
    const data = await api('/api/sessions')
    state.sessions = Array.isArray(data.items) ? data.items : []
    if (state.currentId !== null) {
      const row = state.sessions.find((candidate) => candidate.id === state.currentId)
      if (row !== undefined) {
        state.current = { ...state.current, ...row }
        if (!state.running) state.running = row.running === true
        renderTopbar()
      }
    }
    renderList()
  } catch (error) {
    if (!options.silent && error?.code !== 'unauthorized') toast(error?.message ?? '刷新会话失败', true)
  } finally {
    state.listLoading = false
  }
}

function badge(text, className = '') {
  const span = document.createElement('span')
  span.className = `badge ${className}`.trim()
  if (className.includes('ok')) {
    const dot = document.createElement('span')
    dot.className = 'dot pulse'
    span.append(dot)
  }
  span.append(document.createTextNode(text))
  return span
}

function sessionTitle(row) {
  if (typeof row.title === 'string' && row.title.trim() !== '') return row.title.trim()
  if (row.blank === true) return '新会话'
  return `会话 ${shortId(row.id)}`
}

function filteredSessions() {
  const query = state.filter
  const base = state.showBlank ? state.sessions : state.sessions.filter((row) => row.blank !== true)
  if (query === '') return base
  return base.filter((row) => {
    const text = `${row.title ?? ''} ${row.cwd ?? ''} ${row.id}`.toLowerCase()
    return text.includes(query)
  })
}

function renderList() {
  if (state.view !== 'list') return
  const rows = filteredSessions()
  sessionCount.textContent = String(rows.length)
  sessionListEl.replaceChildren()
  if (rows.length === 0) {
    listEmpty.hidden = false
    if (state.listLoading && state.sessions.length === 0) {
      listEmptyTitle.textContent = '正在加载会话…'
      listEmptySub.textContent = '从 DSH 读取全部会话。'
    } else if (state.filter !== '') {
      listEmptyTitle.textContent = '没有匹配的会话'
      listEmptySub.textContent = '换个关键词试试。'
    } else {
      listEmptyTitle.textContent = '还没有会话'
      listEmptySub.textContent = '在桌面端开始一个对话，或点右上角菜单新建。空白会话可在菜单里显示。'
    }
    return
  }
  listEmpty.hidden = true
  const fragment = document.createDocumentFragment()
  for (const row of rows) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = `session-card${row.running ? ' running' : ''}`
    card.setAttribute('role', 'listitem')
    card.dataset.sessionId = row.id

    const top = document.createElement('div')
    top.className = 'session-top'
    const title = document.createElement('div')
    title.className = 'session-title'
    title.textContent = sessionTitle(row)
    const time = document.createElement('div')
    time.className = 'session-time'
    time.textContent = formatRelative(row.updatedAt)
    const meta = document.createElement('div')
    meta.className = 'session-meta'
    if (row.running) meta.append(badge('运行中', 'ok'))
    else if (row.agentAvailable) meta.append(badge('在线'))
    if (row.blank === true) meta.append(badge('新会话'))
    if (row.origin === 'subagent') meta.append(badge('子会话', 'accent'))
    if (row.formatStatus === 'migration-required') meta.append(badge('待迁移', 'warn'))
    if (typeof row.cwd === 'string' && row.cwd !== '') {
      const cwd = document.createElement('span')
      cwd.className = 'session-cwd'
      cwd.textContent = shortPath(row.cwd)
      cwd.title = row.cwd
      meta.append(cwd)
    }
    top.append(title, time)
    card.append(top, meta)

    if (Array.isArray(row.todos) && row.todos.length > 0) {
      const completed = row.todos.filter((item) => item.status === 'completed').length
      const total = row.todos.length
      const wrap = document.createElement('div')
      wrap.className = 'session-todos'
      const label = document.createElement('span')
      label.textContent = `任务 ${completed}/${total}`
      const bar = document.createElement('div')
      bar.className = 'todo-bar'
      const fill = document.createElement('i')
      fill.style.width = `${Math.round(completed / total * 100)}%`
      bar.append(fill)
      wrap.append(label, bar)
      card.append(wrap)
    }

    card.addEventListener('click', () => {
      location.hash = `#/s/${encodeURIComponent(row.id)}`
    })
    fragment.append(card)
  }
  sessionListEl.append(fragment)
}

/* ── top bar / typing ──────────────────────────────────────────────── */

function renderTopbar() {
  const isChat = state.view === 'chat' && state.currentId !== null
  backButton.hidden = !isChat
  cancelButton.hidden = !isChat || !state.running
  if (!isChat) {
    topbarTitle.textContent = 'DSH 手机端'
    topbarSub.textContent = `${state.sessions.length} 个会话`
    document.title = 'DSH 手机端'
    return
  }
  const title = state.current === null ? '会话' : sessionTitle(state.current)
  topbarTitle.textContent = title
  const bits = []
  if (state.running) bits.push('运行中')
  else if (state.current?.agentAvailable === true) bits.push('在线')
  else bits.push('已就绪')
  if (typeof state.current?.cwd === 'string' && state.current.cwd !== '') bits.push(shortPath(state.current.cwd))
  if (state.current?.formatStatus === 'migration-required') bits.push('需迁移')
  topbarSub.textContent = bits.join(' · ')
  document.title = `${title} · DSH`
}

function renderSettingsMenu() {
  menuBlank.classList.toggle('on', state.showBlank)
  menuTools.classList.toggle('on', state.showTools)
  menuReasoning.classList.toggle('on', state.showReasoning)
}

function renderTyping() {
  if (state.view !== 'chat') {
    typingEl.hidden = true
    return
  }
  const live = state.live
  if (live !== null && (live.text !== '' || live.reasoning !== '' || live.tool)) {
    typingEl.hidden = true
    return
  }
  if (state.running || live !== null) {
    typingEl.hidden = false
    let text = '正在处理…'
    if (live?.tool) text = `正在调用 ${live.tool}…`
    else if (live?.reasoning) text = '正在思考…'
    else if (live?.text) text = '正在输出…'
    typingText.textContent = text
  } else {
    typingEl.hidden = true
  }
}

/* ── streaming ─────────────────────────────────────────────────────── */

function startStream(id, token) {
  closeStream()
  const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/stream`)
  state.es = es
  state.esState = 'connecting'

  es.onopen = () => {
    if (state.es !== es) return
    state.esState = 'open'
    setConnBanner('')
  }

  es.addEventListener('snapshot', (message) => {
    if (state.es !== es || token !== state.routeToken) return
    let snapshot
    try { snapshot = JSON.parse(message.data) } catch { return }
    applySnapshot(snapshot)
    state.esState = 'open'
    setConnBanner('')
  })

  es.addEventListener('record', (message) => {
    if (state.es !== es || token !== state.routeToken) return
    let event
    try { event = JSON.parse(message.data) } catch { return }
    applyRecord(event)
  })

  es.addEventListener('assistant', (message) => {
    if (state.es !== es || token !== state.routeToken) return
    let frame
    try { frame = JSON.parse(message.data) } catch { return }
    applyAssistant(frame)
  })

  es.addEventListener('error', (message) => {
    if (state.es !== es || token !== state.routeToken) return
    let data
    try { data = JSON.parse(message.data) } catch { data = undefined }
    if (data?.error) toast(data.error, true)
    if (data?.code === 'session/not-found' || data?.code === 'subagent/not-found') {
      es.close()
      state.esState = 'closed'
      setConnBanner('会话不存在或已被删除')
    }
  })

  es.onerror = () => {
    if (state.es !== es || token !== state.routeToken) return
    if (es.readyState === EventSource.CLOSED) {
      state.esState = 'closed'
      setConnBanner('连接已关闭，请刷新重试')
    } else {
      state.esState = 'connecting'
      setConnBanner('连接断开，正在重连…')
    }
  }
}

function closeStream() {
  if (state.es !== null) {
    try { state.es.close() } catch { /* ignore */ }
    state.es = null
  }
  state.esState = 'idle'
}

function addRecord(event, options = {}) {
  if (event === null || typeof event !== 'object') return false
  if (!Number.isSafeInteger(event.seq)) return false
  if (state.seqs.has(event.seq)) return false
  state.seqs.add(event.seq)
  if (options.prepend === true) state.records.unshift(event)
  else state.records.push(event)
  if (state.oldestSeq === null || event.seq < state.oldestSeq) state.oldestSeq = event.seq
  if (options.prepend !== true && (state.throughSeq === null || event.seq > state.throughSeq)) {
    state.throughSeq = event.seq
  }
  return true
}

function applySnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return
  state.records = []
  state.seqs.clear()
  state.oldestSeq = null
  state.throughSeq = Number.isSafeInteger(snapshot.cursor) ? snapshot.cursor : null
  state.hasMore = snapshot.hasMore === true
  const header = snapshot.header ?? {}
  const projections = snapshot.projections?.values ?? {}
  const records = Array.isArray(snapshot.records) ? snapshot.records : []
  for (const record of records) {
    if (record?.event) addRecord(record.event)
  }
  state.current = {
    ...(state.current ?? {}),
    id: typeof header.id === 'string' ? header.id : state.currentId,
    title: typeof projections.title === 'string' && projections.title.trim() !== ''
      ? projections.title.trim()
      : state.current?.title ?? null,
    cwd: typeof header.cwd === 'string' ? header.cwd : state.current?.cwd ?? null,
    origin: typeof header.origin === 'string' ? header.origin : state.current?.origin ?? null,
    parentSessionId: typeof header.parentSession === 'string' ? header.parentSession : state.current?.parentSessionId ?? null,
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : state.current?.agentPreset ?? null,
    blank: false,
    running: state.current?.running === true,
    agentAvailable: true,
  }
  state.pending = state.pending.filter((pending) => !hasDurableUserMessage(pending))
  state.live = snapshot.assistantStream?.activeAttempt === undefined
    ? null
    : {
      attemptId: snapshot.assistantStream.activeAttempt.attemptId,
      text: '',
      reasoning: '',
      tool: null,
      done: false,
    }
  state.running = computeRunning()
  renderTopbar()
  renderMessages()
  scrollToBottom(true)
  updateScrollButton()
  void autoFillToUser(state.currentId, state.routeToken)
}

function isRealUserMessage(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

/**
 * A long agentic turn can produce dozens of tool-only assistant messages; the
 * latest page may therefore contain no human message at all. Walk a little way
 * back (bounded) until the last real user prompt is in the window.
 */
async function autoFillToUser(id, token) {
  if (id === null || state.autoFillBusy) return
  state.autoFillBusy = true
  try {
    for (let page = 0; page < 4; page += 1) {
      if (token !== state.routeToken || state.view !== 'chat' || state.currentId !== id) return
      if (state.records.some(isRealUserMessage)) return
      if (!state.hasMore || state.oldestSeq === null || state.throughSeq === null) return
      const data = await api(`/api/sessions/${encodeURIComponent(id)}/page?throughSeq=${state.throughSeq}&beforeSeq=${state.oldestSeq}&maxMessages=60`)
      if (token !== state.routeToken || state.currentId !== id) return
      const records = Array.isArray(data.records) ? data.records : []
      let added = 0
      for (const record of records) {
        if (record?.event && addRecord(record.event, { prepend: true })) added += 1
      }
      state.hasMore = data.hasMore === true
      if (added === 0) {
        state.hasMore = false
        return
      }
      renderMessages()
      if (state.pinned) scrollToBottom(true)
    }
  } catch {
    // History is best-effort; the explicit "load older" button remains.
  } finally {
    state.autoFillBusy = false
  }
}

function hasDurableUserMessage(pending) {
  return state.records.some((event) => {
    if (event.type !== 'user/message') return false
    const source = event.data?.source
    if (pending.requestId && source?.rpcId === pending.requestId) return true
    return !pending.requestId && userText(event) === pending.text
  })
}

function computeRunning() {
  for (let index = state.records.length - 1; index >= 0; index -= 1) {
    const type = state.records[index].type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return state.current?.running === true
}

function applyRecord(event) {
  if (event === null || typeof event !== 'object') return
  const added = addRecord(event)
  if (!added) return
  if (event.type === 'turn/start') state.running = true
  if (event.type === 'turn/end') {
    state.running = false
    state.live = null
  }
  if (event.type === 'assistant/message') state.live = null
  if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim() !== '') {
    if (state.current !== null) state.current.title = event.data.title.trim()
  }
  if (event.type === 'user/message') {
    state.pending = state.pending.filter((pending) => !hasDurableUserMessage(pending))
  }
  renderTopbar()
  renderMessages()
  if (event.type === 'user/message') scrollToBottom(true)
  if (event.type === 'turn/end') {
    setTimeout(() => { if (state.authed) void loadSessions({ silent: true }) }, 600)
  }
}

function userText(event) {
  const content = event?.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/* ── live assistant stream ─────────────────────────────────────────── */

function ensureLive() {
  if (state.live === null) {
    state.live = { attemptId: '', text: '', reasoning: '', tool: null, done: false }
  }
  return state.live
}

function buildLiveBubble() {
  const live = state.live
  if (live === null) return null
  if (live.text === '' && live.reasoning === '' && !live.tool) return null
  const row = document.createElement('div')
  row.className = 'msg assistant'
  const bubble = document.createElement('div')
  bubble.className = 'bubble pending'
  let reasoningBody = null
  if (live.reasoning !== '') {
    const details = document.createElement('details')
    details.className = 'reasoning'
    const summary = document.createElement('summary')
    summary.textContent = '思考过程'
    reasoningBody = document.createElement('div')
    reasoningBody.className = 'reasoning-body'
    reasoningBody.textContent = live.reasoning
    details.append(summary, reasoningBody)
    bubble.append(details)
  }
  const textEl = document.createElement('div')
  textEl.className = 'live-text'
  textEl.style.whiteSpace = 'pre-wrap'
  textEl.textContent = live.text
  if (live.text === '' && live.tool) textEl.textContent = `正在调用 ${live.tool}…`
  bubble.append(textEl)
  row.append(bubble)
  live.el = row
  live.textEl = textEl
  live.reasoningBody = reasoningBody
  return row
}

function applyAssistant(frame) {
  if (frame === null || typeof frame !== 'object') return
  const type = frame.type
  if (type === 'start') {
    if (state.live !== null && state.live.attemptId !== frame.attemptId) {
      state.live = null
    }
    const live = ensureLive()
    live.attemptId = frame.attemptId ?? live.attemptId
    live.done = false
    live.tool = null
    renderMessages()
    return
  }
  if (state.live === null) {
    if (type !== 'chunk') return
    ensureLive()
  }
  const live = state.live
  if (type === 'end') {
    live.done = true
    renderTyping()
    return
  }
  if (type !== 'chunk') return
  const chunk = frame.chunk
  if (chunk === null || typeof chunk !== 'object') return
  switch (chunk.type) {
    case 'text-delta':
      live.text += typeof chunk.text === 'string' ? chunk.text : ''
      break
    case 'reasoning-delta':
      live.reasoning += typeof chunk.text === 'string' ? chunk.text : ''
      break
    case 'tool-call-delta':
      if (typeof chunk.name === 'string' && chunk.name !== '') live.tool = chunk.name
      break
    case 'block-end':
      if (chunk.block?.type === 'text' && live.text === '' && typeof chunk.block.text === 'string') {
        live.text = chunk.block.text
      }
      if (chunk.block?.type === 'reasoning' && live.reasoning === '' && typeof chunk.block.text === 'string') {
        live.reasoning = chunk.block.text
      }
      break
    default:
      break
  }
  updateLiveBubble()
  renderTyping()
  if (state.pinned) scrollToBottom(true)
}

function updateLiveBubble() {
  const live = state.live
  if (live === null) return
  if (live.el === undefined || !live.el.isConnected) {
    const row = buildLiveBubble()
    if (row !== null) messagesEl.append(row)
    return
  }
  if (live.textEl !== undefined) {
    live.textEl.textContent = live.text !== ''
      ? live.text
      : (live.tool ? `正在调用 ${live.tool}…` : '')
  }
  if (live.reasoningBody !== undefined && live.reasoningBody !== null) {
    live.reasoningBody.textContent = live.reasoning
  }
}

/* ── transcript rendering ──────────────────────────────────────────── */

function renderMessages() {
  if (state.view !== 'chat') return
  const pinned = state.pinned || isNearBottom()
  const toolEls = new Map()
  messagesEl.replaceChildren()

  let lastApprovalAsked = false
  for (const event of state.records) {
    if (event.type === 'approval/asked') lastApprovalAsked = true
    if (event.type === 'approval/decided') lastApprovalAsked = false
  }

  for (const event of state.records) {
    const node = renderEvent(event, toolEls, lastApprovalAsked)
    if (node !== null) messagesEl.append(node)
  }

  for (const pending of state.pending) {
    messagesEl.append(renderPending(pending))
  }

  if (state.live !== null) {
    const live = buildLiveBubble()
    if (live !== null) messagesEl.append(live)
  }

  if (!state.showTools) {
    const activity = activitySummary()
    if (activity.tools > 0) {
      const strip = document.createElement('div')
      strip.className = 'activity'
      if (state.running) {
        const dot = document.createElement('span')
        dot.className = 'activity-dot'
        strip.append(dot)
      }
      const label = document.createElement('span')
      label.textContent = `本轮 ${activity.steps} 步 · ${activity.tools} 次工具调用`
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = '查看详情'
      button.addEventListener('click', () => {
        state.showTools = true
        localStorage.setItem('dsh-mobile-show-tools', '1')
        renderSettingsMenu()
        renderMessages()
      })
      strip.append(label, button)
      messagesEl.append(strip)
    }
  }

  if (messagesEl.childElementCount === 0 && !state.loadingOlder) {
    const hasHidden = state.records.some((event) => event.type === 'tool/call' || event.type === 'assistant/message')
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.innerHTML = `<div class="empty-icon">💬</div><div class="empty-title">${hasHidden ? '这个会话以工具调用为主' : '还没有消息'}</div><div class="empty-sub">${hasHidden ? '在右上角菜单打开「工具调用」或「思考过程」查看细节。' : '在下方输入框继续这个会话。'}</div>`
    messagesEl.append(empty)
  }

  loadOlderButton.hidden = !state.hasMore || state.records.length === 0
  loadOlderButton.disabled = state.loadingOlder
  loadOlderButton.textContent = state.loadingOlder ? '加载中…' : '加载更早的消息'
  renderTyping()
  renderTopbar()
  if (pinned) scrollToBottom(true)
  updateScrollButton()
}

/** Count the hidden execution details since the latest human prompt. */
function activitySummary() {
  let start = -1
  for (let index = state.records.length - 1; index >= 0; index -= 1) {
    if (isRealUserMessage(state.records[index])) { start = index; break }
  }
  let tools = 0
  let steps = 0
  for (let index = start + 1; index < state.records.length; index += 1) {
    const type = state.records[index].type
    if (type === 'tool/call') tools += 1
    else if (type === 'assistant/message') steps += 1
  }
  return { tools, steps }
}

function renderEvent(event, toolEls, lastApprovalAsked) {
  switch (event.type) {
    case 'user/message': {
      const source = event.data?.source
      if (source?.kind !== 'user' && source?.kind !== undefined) return null
      if (event.data?.role !== undefined && event.data.role !== 'user') return null
      return renderUser(event)
    }
    case 'assistant/message':
      return renderAssistant(event, toolEls)
    case 'tool/call':
      return state.showTools ? ensureToolCard(event, toolEls) : null
    case 'tool/result':
      return state.showTools ? ensureToolResult(event, toolEls) : null
    case 'turn/end':
      return renderTurnEnd(event)
    case 'approval/asked':
      return lastApprovalAsked ? renderApproval(event) : null
    default:
      return null
  }
}

function renderUser(event) {
  const text = userText(event)
  const content = event.data?.content
  const hasImage = Array.isArray(content) && content.some((part) => part?.type === 'image')
  const hasFile = Array.isArray(content) && content.some((part) => part?.type === 'file')
  let body = text
  if (body === '') body = hasImage ? '[图片]' : hasFile ? '[附件]' : '（空消息）'
  const row = document.createElement('div')
  row.className = 'msg user'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = body
  row.append(bubble)
  const time = document.createElement('div')
  time.className = 'msg-time'
  time.textContent = formatClock(event.time)
  row.append(time)
  return row
}

function renderPending(pending) {
  const row = document.createElement('div')
  row.className = 'msg user'
  const bubble = document.createElement('div')
  bubble.className = 'bubble pending'
  bubble.textContent = pending.text
  row.append(bubble)
  const label = document.createElement('div')
  label.className = 'msg-time'
  if (pending.status === 'failed') label.textContent = `发送失败：${pending.error ?? ''}`
  else if (pending.status === 'sending') label.textContent = '发送中…'
  else label.textContent = '已发送，等待回复…'
  row.append(label)
  return row
}

function renderAssistant(event, toolEls) {
  const message = event.data?.message
  if (message === null || typeof message !== 'object') return null
  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []
  const reasoning = content
    .filter((part) => part?.type === 'reasoning' && typeof part.text === 'string' && part.text.trim() !== '')
    .map((part) => part.text)
    .join('\n\n')
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '')
    .map((part) => part.text)
    .join('\n\n')
  const toolCalls = content.filter((part) => part?.type === 'tool-call')
  const showReasoning = state.showReasoning && reasoning !== ''
  const showTools = state.showTools && toolCalls.length > 0

  // On a phone, an agentic turn can contain hundreds of reasoning/tool steps.
  // Keep the transcript readable by default: only real text is shown, and the
  // two "show details" switches in the menu opt into the rest.
  if (text === '' && !showReasoning && !showTools) return null

  const row = document.createElement('div')
  row.className = 'msg assistant'
  if (text !== '' || showReasoning) {
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    if (showReasoning) {
      const details = document.createElement('details')
      details.className = 'reasoning'
      const summary = document.createElement('summary')
      summary.textContent = '思考过程'
      const body = document.createElement('div')
      body.className = 'reasoning-body'
      body.textContent = reasoning
      details.append(summary, body)
      bubble.append(details)
    }
    if (text !== '') {
      const textEl = document.createElement('div')
      textEl.innerHTML = renderMarkdown(text)
      bubble.append(textEl)
    }
    row.append(bubble)
  }
  if (showTools) {
    for (const call of toolCalls) {
      const callId = String(call.id ?? '')
      // A retried/replayed assistant message can carry the same tool-call id.
      // Reuse the existing card instead of adding a second one that would never
      // receive the result (and would stay "running" forever).
      if (callId !== '' && toolEls.has(callId)) continue
      row.append(createToolCard(call.id, call.name, call.arguments, toolEls))
    }
  }
  if (row.childElementCount === 0) return null
  const time = document.createElement('div')
  time.className = 'msg-time'
  time.textContent = formatClock(event.time)
  row.append(time)
  return row
}

function renderTurnEnd(event) {
  const reason = event.data?.reason
  if (reason === null || typeof reason !== 'object') return null
  if (reason.kind === 'error') {
    return note(`回复失败：${reason.error?.message ?? reason.error ?? '未知错误'}`, 'error-note')
  }
  if (reason.kind === 'cancelled') {
    return note('已停止当前回复', 'approval-note')
  }
  if (reason.kind === 'blocked') {
    return note('当前步骤被阻止（会话可能已归档）', 'approval-note')
  }
  return null
}

function renderApproval(event) {
  const tool = event.data?.toolName ?? event.data?.name ?? event.data?.tool ?? '操作'
  return note(`「${tool}」正在等待批准，请在桌面端处理`, 'approval-note')
}

function note(text, className) {
  const div = document.createElement('div')
  div.className = className
  div.textContent = text
  return div
}

/* ── tool cards ────────────────────────────────────────────────────── */

function parseArgs(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function summarizeTool(name, raw) {
  const args = parseArgs(raw)
  if (args !== undefined) {
    const candidate = args.description ?? args.command ?? args.path ?? args.file_path ?? args.query ?? args.url ?? args.pattern ?? args.text
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.replace(/\s+/g, ' ').trim().slice(0, 110)
    }
  }
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 110) : ''
}

function prettyArgs(raw) {
  const args = parseArgs(raw)
  const text = args !== undefined ? JSON.stringify(args, null, 2) : String(raw ?? '')
  return text.length > 6000 ? `${text.slice(0, 6000)}\n…（已截断）` : text
}

function toolResultText(event) {
  const message = event.data?.message
  const content = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part?.type === 'image') parts.push('[图片]')
    else if (part !== null && typeof part === 'object') parts.push(JSON.stringify(part).slice(0, 500))
  }
  const text = parts.join('\n').trim()
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…（已截断）` : text
}

function createToolCard(callId, name, args, toolEls) {
  const details = document.createElement('details')
  details.className = 'tool'
  const id = String(callId ?? '')
  if (id !== '') details.dataset.callId = id
  const summary = document.createElement('summary')
  const icon = document.createElement('span')
  icon.className = 'tool-icon'
  icon.textContent = '🔧'
  const nameEl = document.createElement('span')
  nameEl.className = 'tool-name'
  nameEl.textContent = String(name ?? 'tool')
  const sumEl = document.createElement('span')
  sumEl.className = 'tool-sum'
  sumEl.textContent = summarizeTool(name, args)
  const status = document.createElement('span')
  status.className = 'tool-status'
  status.textContent = '待结果'
  summary.append(icon, nameEl, sumEl, status)
  const body = document.createElement('div')
  body.className = 'tool-body'
  const argsPre = document.createElement('pre')
  argsPre.textContent = prettyArgs(args)
  body.append(argsPre)
  details.append(summary, body)
  details._dm = { summary, nameEl, sumEl, status, body, argsPre, resultBox: null }
  if (id !== '') toolEls.set(id, details)
  return details
}

function ensureToolCard(event, toolEls) {
  const callId = String(event.data?.callId ?? event.data?.message?.source?.callId ?? '')
  const existing = callId !== '' ? toolEls.get(callId) : undefined
  const card = existing ?? createToolCard(callId, event.data?.name, event.data?.arguments, toolEls)
  if (existing === undefined) {
    const row = document.createElement('div')
    row.className = 'msg assistant'
    row.append(card)
  }
  const info = card._dm
  if (info !== undefined) {
    info.nameEl.textContent = String(event.data?.name ?? 'tool')
    info.sumEl.textContent = summarizeTool(event.data?.name, event.data?.arguments)
    const latest = state.running && event.seq === state.throughSeq
    info.status.className = `tool-status${latest ? ' run' : ''}`
    info.status.textContent = latest ? '进行中…' : '待结果'
    if (info.argsPre.textContent === '') info.argsPre.textContent = prettyArgs(event.data?.arguments)
  }
  return existing === undefined ? card.parentElement : null
}

function ensureToolResult(event, toolEls) {
  // Durable tool results carry the id on message.toolCallId (and mirror it on
  // message.source.callId); older producers may instead put it at data.callId.
  const callId = String(
    event.data?.message?.toolCallId
    ?? event.data?.message?.source?.callId
    ?? event.data?.toolCallId
    ?? event.data?.callId
    ?? '',
  )
  let card = callId !== '' ? toolEls.get(callId) : undefined
  let row = null
  if (card === undefined) {
    card = createToolCard(callId, 'tool', '', toolEls)
    row = document.createElement('div')
    row.className = 'msg assistant'
    row.append(card)
  }
  const info = card._dm
  if (info !== undefined) {
    const text = toolResultText(event)
    const isError = event.data?.message?.isError === true
    info.status.className = `tool-status ${isError ? 'bad' : 'ok'}`
    info.status.textContent = isError ? '失败' : '完成'
    if (info.resultBox === null) {
      const label = document.createElement('div')
      label.className = 'tool-result-label'
      label.textContent = '结果'
      info.resultBox = document.createElement('pre')
      info.body.append(label, info.resultBox)
    }
    info.resultBox.textContent = text === '' ? '（无输出）' : text
    if (isError) card.open = true
  }
  return row
}

/* ── history paging ────────────────────────────────────────────────── */

async function loadOlder() {
  if (state.currentId === null || state.loadingOlder || state.autoFillBusy) return
  if (state.throughSeq === null || state.oldestSeq === null) return
  state.loadingOlder = true
  renderMessages()
  const oldHeight = chatView.scrollHeight
  const oldTop = chatView.scrollTop
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(state.currentId)}/page?throughSeq=${state.throughSeq}&beforeSeq=${state.oldestSeq}&maxMessages=40`)
    const records = Array.isArray(data.records) ? data.records : []
    let added = 0
    for (const record of records) {
      if (record?.event && addRecord(record.event, { prepend: true })) added += 1
    }
    state.hasMore = data.hasMore === true
    if (added === 0) state.hasMore = false
    renderMessages()
    requestAnimationFrame(() => {
      chatView.scrollTop = chatView.scrollHeight - oldHeight + oldTop
    })
  } catch (error) {
    toast(error?.message ?? '加载历史失败', true)
  } finally {
    state.loadingOlder = false
    renderMessages()
  }
}

/* ── composer ──────────────────────────────────────────────────────── */

function autoGrow() {
  composerInput.style.height = 'auto'
  composerInput.style.height = `${Math.min(148, composerInput.scrollHeight)}px`
}

async function sendPrompt() {
  if (state.currentId === null || sendLock) return
  const text = composerInput.value.trim()
  if (text === '') return
  const id = state.currentId
  const pending = {
    clientId: uuid(),
    text,
    at: Date.now(),
    status: 'sending',
    requestId: '',
    error: '',
  }
  state.pending.push(pending)
  composerInput.value = ''
  autoGrow()
  composerHint.textContent = state.running ? '当前回复结束后会自动处理这条消息。' : ''
  state.pinned = true
  renderMessages()
  sendLock = true
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      ...(typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(45_000) } : {}),
    })
    pending.requestId = typeof data.requestId === 'string' ? data.requestId : ''
    pending.status = 'queued'
    state.running = true
    renderTopbar()
    renderMessages()
    setTimeout(() => { if (state.authed && state.currentId === id) void loadSessions({ silent: true }) }, 900)
  } catch (error) {
    if (error?.code === 'unauthorized') return
    pending.status = 'failed'
    pending.error = error?.message ?? String(error)
    toast(pending.error, true)
    if (composerInput.value.trim() === '') {
      composerInput.value = pending.text
      autoGrow()
    }
    renderMessages()
  } finally {
    sendLock = false
  }
}

async function cancelTurn() {
  if (state.currentId === null) return
  if (!window.confirm('停止当前回复？')) return
  try {
    await api(`/api/sessions/${encodeURIComponent(state.currentId)}/cancel`, { method: 'POST' })
    toast('已请求停止')
  } catch (error) {
    toast(error?.message ?? '停止失败', true)
  }
}

/* ── new session ───────────────────────────────────────────────────── */

function recentCwds() {
  const seen = new Set()
  const result = []
  for (const row of state.sessions) {
    if (typeof row.cwd !== 'string' || row.cwd === '' || seen.has(row.cwd)) continue
    seen.add(row.cwd)
    result.push(row.cwd)
    if (result.length >= 6) break
  }
  return result
}

function openNewDialog() {
  if (!state.allowNewSession) {
    toast('当前配置不允许新建会话')
    return
  }
  newError.textContent = ''
  newCwd.value = state.lastCwd || state.defaultCwd || recentCwds()[0] || ''
  cwdChips.replaceChildren()
  for (const cwd of recentCwds()) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'cwd-chip'
    chip.textContent = cwd
    chip.title = cwd
    chip.addEventListener('click', () => { newCwd.value = cwd })
    cwdChips.append(chip)
  }
  newDialog.showModal()
  setTimeout(() => newCwd.focus(), 60)
}

async function createSession(event) {
  event.preventDefault()
  const cwd = newCwd.value.trim()
  if (cwd === '') {
    newError.textContent = '请输入工作目录'
    return
  }
  newCreate.disabled = true
  newCreate.textContent = '创建中…'
  try {
    const data = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd }) })
    state.lastCwd = cwd
    localStorage.setItem('dsh-mobile-last-cwd', cwd)
    newDialog.close()
    await loadSessions()
    location.hash = `#/s/${encodeURIComponent(data.sessionId)}`
    toast('已创建会话')
  } catch (error) {
    newError.textContent = error?.message ?? '创建失败'
  } finally {
    newCreate.disabled = false
    newCreate.textContent = '创建'
  }
}

/* ── markdown ──────────────────────────────────────────────────────── */

function inlineMarkdown(text) {
  const code = []
  let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_match, content) => {
    code.push(`<code>${content}</code>`)
    return `\u0002${code.length - 1}\u0002`
  })
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_match, prefix, url) => {
    let href = url
    let trailing = ''
    while (/[.,;:!?]$/.test(href)) {
      trailing = href.slice(-1) + trailing
      href = href.slice(0, -1)
    }
    if (href === '') return `${prefix}${url}`
    return `${prefix}<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${trailing}`
  })
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  out = out.replace(/\u0002(\d+)\u0002/g, (_match, index) => code[Number(index)] ?? '')
  return out
}

function splitTableRow(line) {
  let text = String(line).trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line) {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

function renderTable(header, rows) {
  const head = `<thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead>`
  const body = rows.length === 0
    ? ''
    : `<tbody>${rows.map((row) => `<tr>${header.map((_, index) => `<td>${inlineMarkdown(row[index] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`
  return `<div class="table-wrap"><table>${head}${body}</table></div>`
}

function renderMarkdown(source) {
  if (typeof source !== 'string' || source.trim() === '') return ''
  const codeBlocks = []
  let text = source.replace(/\r\n/g, '\n').replace(/\u0000/g, '')
  text = text.replace(/```([\w#+.-]*)\n([\s\S]*?)```/g, (_match, _language, content) => {
    codeBlocks.push(`<pre><code>${escapeHtml(content.replace(/\n$/, ''))}</code></pre>`)
    return `\n\u0000CODE${codeBlocks.length - 1}\u0000\n`
  })
  const lines = text.split('\n')
  const output = []
  let paragraph = []
  let listType = null
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`)
    paragraph = []
  }
  const closeList = () => {
    if (listType !== null) {
      output.push(`</${listType}>`)
      listType = null
    }
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex]
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim() === '') {
      flushParagraph()
      closeList()
      continue
    }
    const codeMatch = /^\u0000CODE(\d+)\u0000$/.exec(line.trim())
    if (codeMatch !== null) {
      flushParagraph()
      closeList()
      output.push(codeBlocks[Number(codeMatch[1])] ?? '')
      continue
    }
    if (line.includes('|') && lineIndex + 1 < lines.length && isTableSeparator(lines[lineIndex + 1])) {
      const header = splitTableRow(line)
      const rows = []
      lineIndex += 2
      while (lineIndex < lines.length && lines[lineIndex].trim() !== '' && lines[lineIndex].includes('|')) {
        rows.push(splitTableRow(lines[lineIndex]))
        lineIndex += 1
      }
      lineIndex -= 1
      flushParagraph()
      closeList()
      output.push(renderTable(header, rows))
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      closeList()
      const level = heading[1].length
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      flushParagraph()
      closeList()
      output.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph()
      closeList()
      output.push('<hr>')
      continue
    }
    const unordered = /^[-*+]\s+(.+)$/.exec(line)
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line)
    if (unordered !== null || ordered !== null) {
      flushParagraph()
      const type = unordered !== null ? 'ul' : 'ol'
      if (listType !== type) {
        closeList()
        output.push(`<${type}>`)
        listType = type
      }
      output.push(`<li>${inlineMarkdown((unordered ?? ordered)[1])}</li>`)
      continue
    }
    closeList()
    paragraph.push(line)
  }
  flushParagraph()
  closeList()
  return output.join('')
}

/* ── event wiring ──────────────────────────────────────────────────── */

loginForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void login(tokenInput.value)
})

backButton.addEventListener('click', () => {
  if (location.hash.startsWith('#/s/')) location.hash = '#/'
  else showList()
})

menuButton.addEventListener('click', (event) => {
  event.stopPropagation()
  state.menuOpen = !state.menuOpen
  menuEl.hidden = !state.menuOpen
})

document.addEventListener('click', (event) => {
  if (!state.menuOpen) return
  if (menuEl.contains(event.target) || event.target === menuButton) return
  state.menuOpen = false
  menuEl.hidden = true
})

menuRefresh.addEventListener('click', async () => {
  state.menuOpen = false
  menuEl.hidden = true
  await loadSessions()
  if (state.view === 'chat' && state.currentId !== null) {
    state.routeToken += 1
    const token = state.routeToken
    startStream(state.currentId, token)
  }
  toast('已刷新')
})

menuNew.addEventListener('click', () => {
  state.menuOpen = false
  menuEl.hidden = true
  openNewDialog()
})

menuBlank.addEventListener('click', () => {
  state.showBlank = !state.showBlank
  localStorage.setItem('dsh-mobile-show-blank', state.showBlank ? '1' : '0')
  renderSettingsMenu()
  state.menuOpen = false
  menuEl.hidden = true
  renderList()
})

menuTools.addEventListener('click', () => {
  state.showTools = !state.showTools
  localStorage.setItem('dsh-mobile-show-tools', state.showTools ? '1' : '0')
  renderSettingsMenu()
  state.menuOpen = false
  menuEl.hidden = true
  renderMessages()
})

menuReasoning.addEventListener('click', () => {
  state.showReasoning = !state.showReasoning
  localStorage.setItem('dsh-mobile-show-reasoning', state.showReasoning ? '1' : '0')
  renderSettingsMenu()
  state.menuOpen = false
  menuEl.hidden = true
  renderMessages()
})

menuLogout.addEventListener('click', async () => {
  state.menuOpen = false
  menuEl.hidden = true
  try { await api('/api/logout', { method: 'POST' }) } catch { /* ignore */ }
  closeStream()
  stopTimers()
  location.hash = ''
  showLogin('已退出登录')
})

refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true
  await loadSessions()
  refreshButton.disabled = false
  toast('已刷新')
})

searchInput.addEventListener('input', () => {
  state.filter = searchInput.value.trim().toLowerCase()
  renderList()
})

chatView.addEventListener('scroll', () => {
  updateScrollButton()
}, { passive: true })

scrollBottomButton.addEventListener('click', () => {
  scrollToBottom(true)
})

loadOlderButton.addEventListener('click', () => { void loadOlder() })

cancelButton.addEventListener('click', () => { void cancelTurn() })

sendButton.addEventListener('click', () => { void sendPrompt() })

composerInput.addEventListener('input', () => {
  autoGrow()
  composerHint.textContent = ''
})
composerInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches === true
  if (coarse) return
  event.preventDefault()
  void sendPrompt()
})

newForm.addEventListener('submit', (event) => { void createSession(event) })
newCancel.addEventListener('click', () => { newDialog.close() })
newDialog.addEventListener('click', (event) => {
  if (event.target === newDialog) newDialog.close()
})

window.addEventListener('hashchange', () => { void routeFromHash() })

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.authed) return
  if (state.view === 'list') void loadSessions({ silent: true })
  else if (state.view === 'chat' && state.esState === 'closed' && state.currentId !== null) {
    state.routeToken += 1
    startStream(state.currentId, state.routeToken)
  }
})

window.addEventListener('online', () => {
  if (!state.authed || state.view !== 'chat' || state.currentId === null) return
  state.routeToken += 1
  startStream(state.currentId, state.routeToken)
})

/* ── start ─────────────────────────────────────────────────────────── */

autoGrow()
void boot()
