/**
 * dsh-humanize 最终回复输出入口。
 *
 * 只在最新有效 turn 的助手操作栏显示。正文交给内置 Markdown 预览，
 * 本 chunk 只查询状态，正文的读取和渲染都归预览负责。
 */
window.__ModuleLoader__.load({
  id: 'dsh-humanize',
  chunk: 'client.turn-output.js',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React
    const {
      Tooltip,
      IconSparkleRegular,
      IconLoadingOutlineRegular,
      IconCheckCircleFillRegular,
      IconCheckOutlineRegular,
      IconWarningOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const ACTIVE_PHASES = new Set(['saving', 'processing'])
    const KNOWN_PHASES = new Set(['disabled', 'saving', 'pending', 'processing', 'ready', 'unchanged', 'failed', 'missing', 'expired'])
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

    /** 操作栏只给 messageId；仅当其就是最新有效 turn 的收尾消息时挂载。 */
    function latestOutputTurnForMessage(snapshot, messageId) {
      const turn = latestOutputTurn(snapshot)
      if (turn === null) return null
      const closing = snapshot.timeline.turns.get(turn)?.data?.get('turn-tail')?.closing
      return closing?.finalNode?.messageId === messageId ? turn : null
    }

    /** 与内置 Chat 相同，通过当前会话的授权文件地址打开绝对或相对路径。 */
    function sessionFileAddress(sessionId, path) {
      const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')
      const encodedPath = normalized.split('/').map(encodeSegment).join('/')
      return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encodedPath}`
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

    /** 单入口查询状态机，查询按顺序逐个发出。 */
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
      // 作废还没返回的响应，并清掉已安排的查询。
      const cancel = () => {
        generation += 1
        if (timer !== undefined) cancelSchedule(timer)
        timer = undefined
        controller?.abort()
        controller = undefined
      }
      const currentMetadata = () => metadataForTurn(snapshot.metadata, sessionId, turn)
      // 只有在处理中且可见，并且没有在途请求时，才安排下一次查询。
      const shouldQuery = () => active && visible && controller === undefined
        && (snapshot.status === 'loading'
          || (snapshot.status === 'settled' && ACTIVE_PHASES.has(currentMetadata()?.phase)))

      const load = async (method = 'GET') => {
        const polishing = method === 'POST'
        if (polishing) {
          if (!active || !visible || controller !== undefined || currentMetadata()?.phase !== 'pending') return
        } else if (!shouldQuery()) return
        if (timer !== undefined) cancelSchedule(timer)
        timer = undefined
        const ticket = ++generation
        const request = new AbortController()
        controller = request
        if (polishing) publish({ status: 'settled', metadata: { ...currentMetadata(), phase: 'processing' } })
        try {
          const action = polishing ? `&turn=${encodeURIComponent(turn)}` : ''
          const response = await fetchImpl(`api/humanize.turn-output?sessionId=${encodeURIComponent(sessionId)}${action}`, {
            method,
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
          // 不匹配的旧 turn 就停在终态，新 turn 有自己的入口和查询。
          if (ACTIVE_PHASES.has(currentMetadata()?.phase) && shouldQuery()) {
            timer = schedule(load, pollMs)
          }
        } catch (error) {
          // 网络错误让查询停在错误态，等到下次手动触发。
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
        polish() {
          void load('POST')
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

    // 与内置消息操作按钮保持同一尺寸。assistant-actions 在 DOM 中位于 Fork
    // 之前；flex order 把本入口放到 Fork 后，并让用量和时间继续排在最后。
    const outputStyleId = 'dsh-humanize-turn-output'
    if (typeof document !== 'undefined'
      && document.querySelector(`style[data-plugin-css=${JSON.stringify(outputStyleId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-humanize'
      tag.dataset.pluginCss = outputStyleId
      tag.textContent = `
        [data-dsh-humanize-output] {
          order: 1;
          box-sizing: border-box;
          flex: none;
          width: calc(28px + var(--dsh-content-font-delta, 0px));
          height: calc(28px + var(--dsh-content-font-delta, 0px));
          display: inline-flex;
          align-items: stretch;
          justify-content: center;
          color: var(--dsw-alias-label-tertiary);
          line-height: 0;
        }
        [data-dsh-humanize-output] > button,
        [data-dsh-humanize-output-status] {
          box-sizing: border-box;
          width: 100%;
          height: 100%;
          padding: 6px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: inherit;
        }
        [data-dsh-humanize-output] > button {
          border: 0;
          border-radius: var(--dsw-radius-sm);
          background: transparent;
          cursor: pointer;
        }
        [data-dsh-humanize-output] > button:hover {
          background: var(--dsw-alias-interactive-bg-hover);
          color: var(--dsw-alias-label-secondary);
        }
        [data-clock="end"] > span:last-child { order: 2; }
        [data-dsh-humanize-output-spinner] { animation: dsh-humanize-output-spin 1s linear infinite; }
        @keyframes dsh-humanize-output-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          [data-dsh-humanize-output-spinner] { animation: none; }
        }
      `
      document.head.appendChild(tag)
    }

    function compactStatusKey(phase) {
      if (phase === 'saving') return 'output.compact.saving'
      if (phase === 'processing') return 'output.compact.processing'
      if (phase === 'ready') return 'output.compact.ready'
      if (phase === 'unchanged') return 'output.compact.unchanged'
      if (phase === 'failed') return 'output.compact.failed'
      if (phase === 'expired') return 'output.compact.expired'
      return 'output.compact.missing'
    }

    function OutputAction(props) {
      const { openResource, sessionId, turn } = props
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [store] = useState(() => createTurnOutputStore({ fetch: (...args) => window.fetch(...args) }))
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const rootRef = useRef(null)

      useEffect(() => {
        store.start(sessionId, turn)
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
      }, [store, sessionId, turn])

      const metadata = metadataForTurn(state.metadata, sessionId, turn)
      let label
      let Icon
      let spinning = false
      let onClick
      if (state.status === 'error') {
        label = t('output.retry')
        Icon = IconWarningOutlineRegular
        onClick = () => store.retry()
      } else if (metadata !== undefined) {
        if (metadata.phase === 'pending') {
          label = t('output.polish')
          Icon = IconSparkleRegular
          onClick = () => store.polish()
        } else {
          label = metadata.phase === 'ready'
            ? `${t('output.compact.ready')} · ${t('output.open')}`
            : t(compactStatusKey(metadata.phase))
          if (metadata.phase === 'ready') {
            Icon = IconCheckCircleFillRegular
            onClick = () => {
              // 点击时重新校验，异步状态已经切轮后不能沿用旧闭包打开文件。
              const current = metadataForTurn(store.getSnapshot().metadata, sessionId, turn)
              if (current?.phase === 'ready' && typeof current.filePath === 'string') {
                openResource(sessionFileAddress(sessionId, current.filePath))
              }
            }
          } else if (metadata.phase === 'unchanged') Icon = IconCheckOutlineRegular
          else if (metadata.phase === 'saving' || metadata.phase === 'processing') {
            Icon = IconLoadingOutlineRegular
            spinning = true
          } else Icon = IconWarningOutlineRegular
        }
      } else if (state.status === 'loading') {
        label = t('output.compact.loading')
        Icon = IconLoadingOutlineRegular
        spinning = true
      }
      if (Icon === undefined) {
        label = t('output.compact.loading')
        Icon = IconLoadingOutlineRegular
        spinning = true
      }
      const icon = h(Icon, { size: 17, 'data-dsh-humanize-output-spinner': spinning || undefined })
      const control = onClick === undefined
        ? h('span', {
          role: 'img',
          'aria-label': label,
          'aria-live': 'polite',
          'data-dsh-humanize-output-status': true,
        }, icon)
        : h('button', {
          type: 'button',
          'aria-label': label,
          onClick,
        }, icon)
      // 外层节点必须跨状态保持稳定，否则可见性观察器会继续盯着已被替换的节点。
      return h(Tooltip, { label, side: 'bottom' }, h('span', {
        ref: rootRef,
        'data-dsh-humanize-output': true,
      }, control))
    }

    function TurnOutputAction(props) {
      const { configForm, messageId, useChat } = props
      const selectTurn = React.useCallback(
        (snapshot) => latestOutputTurnForMessage(snapshot, messageId),
        [messageId],
      )
      const turn = useChat(selectTurn)
      const config = useSyncExternalStore(
        React.useCallback((listener) => configForm.subscribe(listener), [configForm]),
        React.useCallback(() => configForm.getSnapshot(), [configForm]),
      )
      const enabled = config.status === 'ready' && config.value?.settings?.saveTurnOutputs === true
      if (!enabled || turn === null) return null
      return h(OutputAction, { ...props, turn })
    }

    module.exports.TurnOutputAction = TurnOutputAction
    module.exports.createTurnOutputStore = createTurnOutputStore
    module.exports.latestOutputTurn = latestOutputTurn
    module.exports.latestOutputTurnForMessage = latestOutputTurnForMessage
    module.exports.sessionFileAddress = sessionFileAddress
    module.exports.metadataForTurn = metadataForTurn
    return module.exports
  },
})
