/**
 * @zyfgood/dsh-mobile client half (browser bundle).
 *
 * 在桌面 Web GUI 左下角挂一个 📱 入口：打开后显示手机访问二维码、链接和
 * 服务状态。二维码由宿主 /dsh-mobile/qr.svg 生成，受桌面登录态保护；
 * 这里只负责展示与复制，不接触访问令牌以外的宿主 API。
 */
window.__ModuleLoader__.load({
  id: '@zyfgood/dsh-mobile',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const inject = ['slots']

    const CSS = `
.dm-root{position:fixed;left:18px;bottom:18px;z-index:2147481900;font:13px/1.5 var(--dsw-alias-font-body,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);color:var(--dsw-alias-label-primary,#111827);}
.dm-fab{width:42px;height:42px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(17,24,39,.16));background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#4b5563);display:flex;align-items:center;justify-content:center;box-shadow:0 6px 22px rgba(16,24,40,.16);cursor:pointer;transition:transform .15s ease,box-shadow .15s ease,color .15s ease;position:relative;}
.dm-fab:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(16,24,40,.22);color:var(--dsw-alias-label-primary,#111827);}
.dm-fab:active{transform:scale(.95);}
.dm-fab-dot{position:absolute;right:9px;top:9px;width:7px;height:7px;border-radius:50%;background:#94a3b8;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2,#fff);}
.dm-fab-dot.on{background:#10b981;}
.dm-panel{position:absolute;left:0;bottom:54px;width:324px;max-width:calc(100vw - 36px);background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(17,24,39,.16));border-radius:18px;box-shadow:0 24px 70px rgba(16,24,40,.26);overflow:hidden;animation:dm-in .18s ease-out;}
@keyframes dm-in{from{opacity:0;transform:translateY(6px) scale(.98);}to{opacity:1;transform:none;}}
.dm-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:13px 14px 9px;}
.dm-title{font-weight:650;font-size:14px;letter-spacing:-.01em;}
.dm-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:16px;line-height:1;}
.dm-x:hover{background:var(--dsw-alias-interactive-bg-hover,#eef2f9);color:var(--dsw-alias-label-primary,#111827);}
.dm-body{padding:0 14px 14px;}
.dm-qr{display:flex;align-items:center;justify-content:center;padding:10px;background:#fff;border-radius:13px;border:1px solid rgba(17,24,39,.1);margin:2px 0 11px;min-height:196px;}
.dm-qr img{width:196px;height:196px;display:block;}
.dm-qr-empty{width:196px;height:196px;display:flex;align-items:center;justify-content:center;text-align:center;color:#6b7280;font-size:12px;padding:12px;line-height:1.6;}
.dm-status{display:flex;align-items:center;gap:6px;margin:0 0 7px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;}
.dm-dot{width:7px;height:7px;border-radius:50%;background:#94a3b8;flex:none;}
.dm-dot.on{background:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.14);}
.dm-dot.bad{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.12);}
.dm-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-interactive-bg-hover,#f1f5f9);border-radius:8px;padding:7px 9px;word-break:break-all;line-height:1.5;max-height:54px;overflow:auto;margin:0 0 10px;user-select:all;}
.dm-actions{display:flex;gap:7px;}
.dm-btn{flex:1;height:34px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(17,24,39,.16));background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111827);font:600 12px/1 var(--dsw-alias-font-body,system-ui,sans-serif);cursor:pointer;transition:background .15s ease,border-color .15s ease;}
.dm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#eef2f9);}
.dm-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff;}
.dm-btn.primary:hover{background:#1d4ed8;border-color:#1d4ed8;}
.dm-btn:active{transform:scale(.98);}
.dm-note{margin:11px 0 0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(17,24,39,.09));color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;line-height:1.6;}
.dm-error{margin:0 0 10px;padding:8px 10px;border-radius:9px;background:rgba(239,68,68,.09);color:#b91c1c;font-size:11.5px;line-height:1.6;}
.dm-copied{color:#059669;}
@media (prefers-color-scheme: dark){
  .dm-panel{box-shadow:0 24px 70px rgba(0,0,0,.55);}
  .dm-qr{background:#fff;}
  .dm-error{background:rgba(239,68,68,.14);color:#fca5a5;}
}
`

    function ensureStyles() {
      if (document.getElementById('@zyfgood/dsh-mobile-styles') !== null) return
      const tag = document.createElement('style')
      tag.id = '@zyfgood/dsh-mobile-styles'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    async function fetchStatus() {
      const response = await fetch('/dsh-mobile/status', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (response.status === 401 || response.status === 403) {
        throw new Error('桌面登录态不可用，请刷新页面后重试')
      }
      if (!response.ok) throw new Error(`读取手机端状态失败（HTTP ${response.status}）`)
      const data = await response.json()
      if (data?.ok !== true) throw new Error(data?.error || '手机端服务暂不可用')
      return data
    }

    function copyText(value) {
      if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
      return new Promise((resolve, reject) => {
        try {
          const area = document.createElement('textarea')
          area.value = value
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          area.remove()
          ok ? resolve() : reject(new Error('copy failed'))
        } catch (error) { reject(error) }
      })
    }

    function PhoneIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 21, height: 21, 'aria-hidden': 'true' },
        h('rect', { x: 7, y: 2.5, width: 10, height: 19, rx: 2.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.9 }),
        h('path', { d: 'M10.5 5.2h3', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 18.2, r: .9, fill: 'currentColor' }),
      )
    }

    function MobilePanel() {
      const [open, setOpen] = useState(false)
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [copied, setCopied] = useState(false)
      const [tick, setTick] = useState(0)

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const next = await fetchStatus()
            if (!alive) return
            setStatus(next)
            setError('')
          } catch (err) {
            if (!alive) return
            setError(err?.message ?? String(err))
          }
        }
        void load()
        const timer = setInterval(load, 15_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      useEffect(() => {
        if (!open) return undefined
        let alive = true
        const load = async () => {
          try {
            const next = await fetchStatus()
            if (!alive) return
            setStatus(next)
            setError('')
            setTick((value) => value + 1)
          } catch (err) {
            if (!alive) return
            setError(err?.message ?? String(err))
          }
        }
        void load()
        const timer = setInterval(load, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [open])

      const toggle = useCallback(() => {
        setOpen((value) => !value)
        setCopied(false)
      }, [])

      const onCopy = useCallback(async () => {
        if (!status?.tokenUrl) return
        try {
          await copyText(status.tokenUrl)
          setCopied(true)
          setTimeout(() => setCopied(false), 2200)
        } catch (err) {
          setError(`复制失败：${err?.message ?? err}`)
        }
      }, [status])

      const onOpen = useCallback(() => {
        if (status?.tokenUrl) window.open(status.tokenUrl, '_blank', 'noopener,noreferrer')
      }, [status])

      const running = status?.running === true
      const url = status?.tokenUrl ?? ''
      const qrSrc = status?.qrPath ? `${status.qrPath}?t=${tick}&p=${status.port ?? 0}` : ''
      if (status?.panel === false) return null

      return h('div', { className: 'dm-root' },
        open && h('div', { className: 'dm-panel', role: 'dialog', 'aria-label': '手机访问' },
          h('div', { className: 'dm-head' },
            h('div', { className: 'dm-title' }, '手机访问'),
            h('button', { className: 'dm-x', type: 'button', onClick: toggle, 'aria-label': '关闭' }, '×'),
          ),
          h('div', { className: 'dm-body' },
            error !== '' && h('div', { className: 'dm-error' }, error),
            h('div', { className: 'dm-qr' },
              running && qrSrc !== ''
                ? h('img', { src: qrSrc, alt: '手机端访问二维码', width: 196, height: 196 })
                : h('div', { className: 'dm-qr-empty' }, status?.error || '手机端服务未启动，请检查插件配置或端口占用。'),
            ),
            h('div', { className: 'dm-status' },
              h('span', { className: `dm-dot ${running ? 'on' : 'bad'}` }),
              h('span', null, running
                ? `运行中 · ${status.secure ? 'HTTPS' : 'HTTP'} · 端口 ${status.port}`
                : '未运行'),
              status?.urls?.length > 1 ? h('span', { style: { opacity: .7 } }, ` · 共 ${status.urls.length} 个地址`) : null,
            ),
            url !== '' && h('div', { className: 'dm-url' }, url),
            h('div', { className: 'dm-actions' },
              h('button', { className: `dm-btn primary${copied ? ' copied' : ''}`, type: 'button', onClick: onCopy, disabled: url === '' }, copied ? '已复制 ✓' : '复制链接'),
              h('button', { className: 'dm-btn', type: 'button', onClick: onOpen, disabled: url === '' }, '打开'),
            ),
            h('p', { className: 'dm-note' }, status?.note ?? '手机与电脑需在同一局域网。首次使用若手机打不开，请在 Windows 防火墙中允许 DeepSeek Harness 的入站连接。'),
          ),
        ),
        h('button', {
          className: 'dm-fab',
          type: 'button',
          onClick: toggle,
          title: '手机访问',
          'aria-label': '手机访问',
          'aria-expanded': open,
        },
          h(PhoneIcon),
          h('span', { className: `dm-fab-dot${running ? ' on' : ''}` }),
        ),
      )
    }

    function apply(ctx) {
      try {
        ensureStyles()
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: '@zyfgood/dsh-mobile',
          order: 20,
          registrant: '@zyfgood/dsh-mobile',
          inject: () => ({}),
        }, MobilePanel)), '@zyfgood/dsh-mobile: shell.overlay')
      } catch (error) {
        console.error('[@zyfgood/dsh-mobile] mount error:', error)
      }
    }

    exports.name = '@zyfgood/dsh-mobile'
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
