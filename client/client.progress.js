/**
 * dsh-humanize 浏览器端进度条，显示在输入框上方。数据来自宿主注册
 * 的后台任务。
 */
window.__ModuleLoader__.load({
  id: 'dsh-humanize',
  chunk: 'client.progress.js',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useSyncExternalStore } = React

    /** 共用的空数组，让 getSnapshot 在无任务时返回同一个引用。 */
    const EMPTY_ROWS = []

    /** 当前会话的 humanize 任务行。 */
    function useHumanizeJob(jobs, sessionId) {
      useEffect(() => jobs.watchRows(sessionId), [jobs, sessionId])
      const snapshot = useSyncExternalStore(
        (listener) => jobs.state.subscribe(listener),
        () => jobs.state.getSnapshot(),
      )
      // 这三类任务分别是 /humanize-review 批次、/humanize 单次合并和 /humanize-loop 循环合并。
      const rows = (snapshot.rows[sessionId] ?? EMPTY_ROWS).filter((row) => row.kind === 'humanize' || row.kind === 'humanize-review' || row.kind === 'humanize-loop')
      // 同一时刻只会有一条任务行在进行中。终态的任务行停留期间可能和新任务并存，
      // 优先取进行中的那条，只剩终态的任务行时取列表里最新的一条。
      return rows.find((row) => row.status === 'running' || row.status === 'stopping')
        ?? rows[rows.length - 1]
        ?? null
    }

    /** 把一条任务行转成进度条要用的显示数据。 */
    function jobView(row) {
      if (row.status === 'running' || row.status === 'stopping') {
        const match = /(\d+)\/(\d+)/.exec(row.progress ?? '')
        const done = match === null ? 0 : Number(match[1])
        const total = match === null ? 0 : Number(match[2])
        return { pct: total > 0 ? (done / total) * 100 : 0, meta: row.progress ?? '', done: false }
      }
      // 终态的任务行由宿主维护。它在任务列表里停留几秒后会被摘除，进度条也跟着消失。
      // 已完成的任务行画满进度条。其他终态只显示文字信息。
      return { pct: row.status === 'completed' ? 100 : null, meta: row.detail ?? '', done: row.status === 'completed' }
    }

    // 外框对齐官方 todo 条的容器规范，宽度与输入框卡片一致。
    const dockRootStyle = {
      boxSizing: 'border-box',
      width: 'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
      maxWidth: 'calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-specific-tip)',
      borderRadius: '12px',
      margin: '0 auto',
      overflow: 'hidden',
      flex: 'none',
    }
    const dockBodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '6px 12px',
    }
    const dockRowStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
    }
    const dockTitleStyle = {
      color: 'var(--dsw-alias-label-primary)',
      flex: 'none',
      fontSize: '13px',
      fontWeight: 500,
      lineHeight: '20px',
    }
    const dockTrackStyle = {
      width: '100%',
      height: '6px',
      borderRadius: '999px',
      background: 'var(--dsw-alias-border-l2)',
      overflow: 'hidden',
    }
    // 终态说明可能很长，例如失败清单，或轮次上限的未收敛批注数。
    // 这里让它换行，完整展示结果。
    const dockMetaStyle = {
      minWidth: 0,
      flex: 'auto',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '13px',
      lineHeight: '20px',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    }

    /** 输入框上方的进度条。任务进行中时一直显示，结束后隐藏。 */
    function ProgressDock(props) {
      const { jobs, sessionId } = props
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const row = useHumanizeJob(jobs, sessionId)
      if (row === null || row === undefined) return null
      const view = jobView(row)
      const rows = [h('div', { key: 'head', style: dockRowStyle },
        h('span', { style: dockTitleStyle }, row.kind === 'humanize-loop' ? t('progress.loop') : row.kind === 'humanize' ? t('progress.merge') : t('progress.review')),
        h('span', { style: dockMetaStyle }, view.meta),
      )]
      if (view.pct !== null) {
        rows.push(h('div', { key: 'track', style: dockTrackStyle }, h('div', {
          style: {
            height: '100%',
            borderRadius: '999px',
            background: view.done ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-business-primary)',
            width: `${Math.max(0, Math.min(100, view.pct))}%`,
            transition: 'width 200ms ease',
          },
        })))
      }
      return h('section', { style: dockRootStyle }, h('div', { style: dockBodyStyle }, rows))
    }

    module.exports.ProgressDock = ProgressDock
    return module.exports
  },
})
