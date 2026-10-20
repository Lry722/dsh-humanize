/**
 * dsh-humanize 浏览器端进度条，显示在输入框上方。数据来自宿主注册
 * 的后台任务。
 */
// 进度条通过模块加载器懒加载。
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

    /**
     * 当前会话的 humanize 任务行。
     *
     * 任务来自宿主注册的 humanize-review 与 humanize-loop 两类
     * 后台任务。
     *
     * 同一时刻只会有一条进行中。结算记录停留期间可能和新任务并存。
     */
    function useHumanizeJob(jobs, sessionId) {
      useEffect(() => jobs.watchRows(sessionId), [jobs, sessionId])
      const snapshot = useSyncExternalStore(
        (listener) => jobs.state.subscribe(listener),
        () => jobs.state.getSnapshot(),
      )
      const rows = (snapshot.rows[sessionId] ?? EMPTY_ROWS).filter((row) => row.kind === 'humanize-review' || row.kind === 'humanize-loop')
      // 优先取进行中的，否则取最新的一条。
      return rows.find((row) => row.status === 'running' || row.status === 'stopping')
        ?? rows[rows.length - 1]
        ?? null
    }

    /**
     * 任务行的展示形态。pct 有值时才画进度条。
     */
    function jobView(row) {
      if (row.status === 'running' || row.status === 'stopping') {
        // 进度取自任务行的进度文本，格式是 done/total。
        const match = /(\d+)\/(\d+)/.exec(row.progress ?? '')
        const done = match === null ? 0 : Number(match[1])
        const total = match === null ? 0 : Number(match[2])
        return { pct: total > 0 ? (done / total) * 100 : 0, meta: row.progress ?? '', done: false }
      }
      return { pct: row.status === 'completed' ? 100 : null, meta: row.detail ?? '', done: row.status === 'completed' }
    }

    // 外框对齐官方 todo 条的容器规范，宽度与 composer 卡片一致。
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
      alignItems: 'center',
      gap: '10px',
    }
    const dockTitleStyle = {
      color: 'var(--dsw-alias-label-primary)',
      flex: 'none',
      fontSize: '13px',
      fontWeight: 500,
      lineHeight: '24px',
    }
    const dockTrackStyle = {
      width: '100%',
      height: '6px',
      borderRadius: '999px',
      background: 'var(--dsw-alias-border-l2)',
      overflow: 'hidden',
    }
    const dockMetaStyle = {
      minWidth: 0,
      flex: 'auto',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '13px',
      lineHeight: '20px',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
    }

    /**
     * 输入框上方的审查进度条。进行中的状态一直显示。终态停留由宿主
     * 控制，结算记录在任务列表里停留几秒后被摘掉，进度条随之消失。
     */
    function ProgressDock(props) {
      const { jobs, sessionId } = props
      const row = useHumanizeJob(jobs, sessionId)
      if (row === null || row === undefined) return null
      const view = jobView(row)
      const rows = [h('div', { key: 'head', style: dockRowStyle },
        h('span', { style: dockTitleStyle }, row.kind === 'humanize-loop' ? '循环合并' : '行文审查'),
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
