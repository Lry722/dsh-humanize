/**
 * dsh-humanize 最终回复输出卡片。
 *
 * 只在最新有效 turn 上显示。正文由 slot 的 openFile 交给内置 Markdown
 * 预览，本 chunk 只查询状态，不读取正文，也不渲染另一份助手消息。
 */
window.__ModuleLoader__.load({
  id: 'dsh-humanize',
  chunk: 'client.turn-output.js',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React

    const ACTIVE_PHASES = new Set(['saving', 'processing'])
    const KNOWN_PHASES = new Set(['disabled', 'saving', 'processing', 'ready', 'failed', 'missing', 'expired'])
    const POLL_MS = 1000

    function turnHasOutput(snapshot, turn) {
      const keys = snapshot.locations.getTurn(turn)
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const node = snapshot.nodes.get(keys[index])
        if (node?.kind !== 'assistant-step') continue
        if (node.data.blocks.some((block) => block.kind === 'text' && block.text.trim() !== '')) return true
      }
      return false
    }

    /** 与宿主候选一致：最新已结束且含可见正文的 turn，跳过空白轮次。 */
    function latestOutputTurn(snapshot) {
      for (let index = snapshot.timeline.turnOrder.length - 1; index >= 0; index -= 1) {
        const turn = snapshot.timeline.turnOrder[index]
        const location = snapshot.timeline.turns.get(turn)
        if (location?.end && turnHasOutput(snapshot, turn)) return turn
      }
      return null
    }

    /** 响应和点击都校验会话、轮次与文件字段，旧响应不能打开新内容。 */
    function metadataForTurn(metadata, sessionId, turn) {
      if (metadata?.sessionId !== sessionId || metadata.turn !== turn) return undefined
      if (!KNOWN_PHASES.has(metadata.phase)) return undefined
      if (metadata.filePath !== null && typeof metadata.filePath !== 'string') return undefined
      if (metadata.updatedAt !== null && !Number.isFinite(metadata.updatedAt)) return undefined
      if ((metadata.phase === 'ready' || metadata.phase === 'failed') && typeof metadata.filePath !== 'string') return undefined
      return metadata
    }

    /**
     * 单卡片查询状态机。请求串行，隐藏会作废在途响应。只有处理中且可见时
     * 才安排下一次查询。终态和网络错误都不会自动轮询。
     */
    function createTurnOutputStore(options) {
      const fetchImpl = options.fetch
      const schedule = options.setTimeout ?? setTimeout
      const cancelSchedule = options.clearTimeout ?? clearTimeout
      const pollMs = options.pollMs ?? POLL_MS
      const listeners = new Set()
      let snapshot = { status: 'idle', metadata: null }
      let sessionId
      let turn
      let active = false
      let visible = false
      let generation = 0
      let controller
      let timer

      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) listener()
      }
      const cancel = () => {
        generation += 1
        if (timer !== undefined) cancelSchedule(timer)
        timer = undefined
        controller?.abort()
        controller = undefined
      }
      const currentMetadata = () => metadataForTurn(snapshot.metadata, sessionId, turn)
      const shouldQuery = () => active && visible && controller === undefined
        && (snapshot.status === 'loading'
          || (snapshot.status === 'settled' && ACTIVE_PHASES.has(currentMetadata()?.phase)))

      const load = async () => {
        if (!shouldQuery()) return
        if (timer !== undefined) cancelSchedule(timer)
        timer = undefined
        const ticket = ++generation
        const request = new AbortController()
        controller = request
        try {
          const response = await fetchImpl(`api/humanize.turn-output?sessionId=${encodeURIComponent(sessionId)}`, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: request.signal,
          })
          const body = await response.json()
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          if (ticket !== generation || !active || !visible) return
          if (typeof body?.phase !== 'string') throw new Error('Invalid output metadata')
          controller = undefined
          publish({ status: 'settled', metadata: body })
          // 不匹配的旧 turn 是终态，不为它继续刷新。新 turn 有自己的卡片和查询。
          if (ACTIVE_PHASES.has(currentMetadata()?.phase) && shouldQuery()) {
            timer = schedule(load, pollMs)
          }
        } catch (error) {
          if (ticket !== generation || !active || !visible || error?.name === 'AbortError') return
          controller = undefined
          publish({ status: 'error', metadata: null })
        }
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() { return snapshot },
        start(nextSessionId, nextTurn) {
          cancel()
          sessionId = nextSessionId
          turn = nextTurn
          active = true
          publish({ status: 'loading', metadata: null })
          void load()
        },
        setVisible(next) {
          if (visible === next) return
          visible = next
          if (!visible) cancel()
          else void load()
        },
        retry() {
          if (!active) return
          cancel()
          publish({ status: 'loading', metadata: null })
          void load()
        },
        stop() {
          cancel()
          active = false
          visible = false
          publish({ status: 'idle', metadata: null })
        },
      }
    }

    const rootStyle = {
      boxSizing: 'border-box',
      width: '100%',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '10px',
      background: 'var(--dsw-specific-tip)',
      padding: '10px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    }
    const headingStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
      fontWeight: 500,
      lineHeight: '20px',
    }
    const statusStyle = {
      margin: 0,
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '12px',
      lineHeight: 1.5,
      overflowWrap: 'anywhere',
    }
    const actionsStyle = { display: 'flex', gap: '8px', marginTop: '2px' }
    const buttonStyle = {
      alignSelf: 'flex-start',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '7px',
      background: 'var(--dsw-alias-bg-layer-3)',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '20px',
      padding: '4px 10px',
    }

    function statusKey(phase) {
      if (phase === 'saving') return 'output.saving'
      if (phase === 'processing') return 'output.processing'
      if (phase === 'ready') return 'output.ready'
      if (phase === 'failed') return 'output.failed'
      if (phase === 'expired') return 'output.expired'
      return 'output.missing'
    }

    function OutputCard(props) {
      const { configForm, openFile, sessionId, turn } = props
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [store] = useState(() => createTurnOutputStore({ fetch: (...args) => window.fetch(...args) }))
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const rootRef = useRef(null)

      useEffect(() => {
        store.start(sessionId, turn.turn)
        let intersecting = true
        let observer
        const syncVisibility = () => {
          store.setVisible(intersecting && (typeof document === 'undefined' || !document.hidden))
        }
        if (typeof IntersectionObserver === 'function' && rootRef.current !== null) {
          intersecting = false
          observer = new IntersectionObserver((entries) => {
            intersecting = entries.some((entry) => entry.isIntersecting)
            syncVisibility()
          })
          observer.observe(rootRef.current)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', syncVisibility)
        syncVisibility()
        return () => {
          observer?.disconnect()
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', syncVisibility)
          store.stop()
        }
      }, [store, sessionId, turn.turn])

      const metadata = metadataForTurn(state.metadata, sessionId, turn.turn)
      let content = null
      if (state.status === 'error') {
        content = h('section', { style: rootStyle, 'aria-label': t('output.title') },
          h('div', { style: headingStyle }, t('output.title')),
          h('p', { style: statusStyle }, t('output.unavailable')),
          h('div', { style: actionsStyle }, h('button', {
            type: 'button', style: buttonStyle, onClick: () => store.retry(),
          }, t('output.retry'))))
      } else if (metadata !== undefined) {
        const canOpen = (metadata.phase === 'ready' || metadata.phase === 'failed') && typeof metadata.filePath === 'string'
        content = h('section', { style: rootStyle, 'aria-label': t('output.title') },
          h('div', { style: headingStyle }, t('output.title')),
          h('p', { style: statusStyle, 'aria-live': 'polite' }, t(statusKey(metadata.phase))),
          canOpen ? h('div', { style: actionsStyle }, h('button', {
            type: 'button',
            style: buttonStyle,
            onClick: () => {
              // 点击时重新校验，异步状态已经切轮后不能沿用旧闭包打开文件。
              const current = metadataForTurn(store.getSnapshot().metadata, sessionId, turn.turn)
              if ((current?.phase === 'ready' || current?.phase === 'failed') && typeof current.filePath === 'string') {
                openFile(current.filePath)
              }
            },
          }, t(metadata.phase === 'failed' ? 'output.openSaved' : 'output.open'))) : null)
      } else if (state.status === 'loading') {
        content = h('section', { style: rootStyle, 'aria-label': t('output.title') },
          h('div', { style: headingStyle }, t('output.title')),
          h('p', { style: statusStyle }, t('output.loading')))
      }
      // 保留一个无视觉内容的观察锚点。关闭输出或不匹配时不发起后台轮询。
      return h('div', { ref: rootRef, style: { minHeight: '1px' } }, content)
    }

    function TurnOutputTail(props) {
      const { configForm, turn, useChat } = props
      const latest = useChat(latestOutputTurn)
      const config = useSyncExternalStore(
        React.useCallback((listener) => configForm.subscribe(listener), [configForm]),
        React.useCallback(() => configForm.getSnapshot(), [configForm]),
      )
      const enabled = config.status === 'ready' && config.value?.settings?.saveTurnOutputs === true
      if (!enabled || latest !== turn.turn) return null
      return h(OutputCard, props)
    }

    module.exports.TurnOutputTail = TurnOutputTail
    module.exports.createTurnOutputStore = createTurnOutputStore
    module.exports.latestOutputTurn = latestOutputTurn
    module.exports.metadataForTurn = metadataForTurn
    return module.exports
  },
})
