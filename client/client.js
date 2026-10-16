/**
 * dsh-humanize 浏览器端：设置页的配置卡片，以及输入框上方的审查
 * 进度条。
 *
 * 卡片注册进 plugins.row.config，挂在 Plugins 页面本插件那一行的配置区，
 * 读写走 configForms 服务，改动实时生效；模型目录走 remote.session。
 * 进度条挂在 conversation.input.dock 插槽，数据来自 ctx.jobs：
 * 宿主把 /humanize-review 批次注册成后台任务，roster 流经
 * job-controller 实时推到浏览器。
 *
 * 手写为 __ModuleLoader__ 工厂格式，不引入构建步骤。唯一的外部依赖
 * 是模块表里的 react。
 */
window.__ModuleLoader__.load({
  id: 'dsh-humanize',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { Fragment, useEffect, useState, useSyncExternalStore } = React

    /** 设置命名空间：宿主条目的 id，也是 Plugins 页面里本插件行的 id。 */
    const NS = 'dsh-humanize'
    /** Config 里承载可编辑设置的 volatile 节点名，写入路径以它为前缀。 */
    const SETTINGS_KEY = 'settings'

    const fieldStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '12px 0',
      borderTop: '1px solid var(--dsw-alias-border-l2)',
    }
    const labelRowStyle = { display: 'flex', alignItems: 'center', gap: '8px' }
    const labelStyle = {
      flex: 1,
      fontSize: '13px',
      fontWeight: 500,
      color: 'var(--dsw-alias-label-primary)',
    }
    const inputStyle = {
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-3)',
      height: '34px',
      font: 'inherit',
      fontSize: '13px',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: '8px',
      padding: '0 12px',
    }
    const hintStyle = {
      margin: 0,
      fontSize: '12px',
      color: 'var(--dsw-alias-label-tertiary)',
      lineHeight: 1.5,
    }
    const resetStyle = {
      font: 'inherit',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-secondary)',
      background: 'none',
      border: 'none',
      padding: 0,
      cursor: 'pointer',
    }
    const checkRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '13px',
      color: 'var(--dsw-alias-label-primary)',
    }
    const selectStyle = {
      ...inputStyle,
      cursor: 'pointer',
    }

    /** 字段被用户覆盖时给出恢复缺省的入口。 */
    function ResetButton(props) {
      if (!props.overridden) return null
      return h('button', { type: 'button', style: resetStyle, onClick: props.onReset }, '恢复缺省')
    }

    /**
     * 审查模型的两级选择。provider 选项来自宿主的模型目录，模型选项
     * 跟随选中的 provider。目录加载失败时退化为手动填写的文本框。两者
     * 都留空时跟随会话当前使用的模型。
     */
    function ModelPicker(props) {
      const { value, user, writable, groups, catalogFailed, set, unset } = props
      if (catalogFailed) {
        return h(Fragment, null,
          h(TextField, {
            label: '审查模型 provider', value: value.reviewProvider,
            overridden: Object.prototype.hasOwnProperty.call(user, 'reviewProvider'),
            writable, set: (next) => set('reviewProvider', next), unset: () => unset('reviewProvider'),
            placeholder: '跟随会话当前使用的模型',
            hint: '模型目录加载失败，请手动填写 provider。留空时跟随会话当前使用的模型。',
          }),
          h(TextField, {
            label: '审查模型', value: value.reviewModel,
            overridden: Object.prototype.hasOwnProperty.call(user, 'reviewModel'),
            writable, set: (next) => set('reviewModel', next), unset: () => unset('reviewModel'),
            placeholder: '跟随会话当前使用的模型',
            hint: '模型目录加载失败，请手动填写模型名。留空时跟随会话当前使用的模型。',
          }),
        )
      }

      const provider = value.reviewProvider ?? ''
      const model = value.reviewModel ?? ''
      const group = groups === null ? undefined : groups.find((g) => g.id === provider)
      const providerKnown = provider === '' || groups === null || groups.some((g) => g.id === provider)

      const pickProvider = (next) => {
        if (next === '') unset('reviewProvider')
        else set('reviewProvider', next)
        // 换 provider 后旧模型通常已不在新目录，清掉。推理等级是模型
        // 专属的，一并清掉。
        const nextGroup = groups === null ? undefined : groups.find((g) => g.id === next)
        if (model !== '' && (nextGroup === undefined || !nextGroup.models.some((m) => m.id === model))) {
          unset('reviewModel')
          unset('reviewReasoningEffort')
        }
      }
      const pickModel = (next) => {
        if (next === '') unset('reviewModel')
        else set('reviewModel', next)
        unset('reviewReasoningEffort')
      }

      return h(Fragment, null,
        h('div', { style: fieldStyle },
          h('div', { style: labelRowStyle },
            h('span', { style: labelStyle }, '审查模型 provider'),
            h(ResetButton, {
              overridden: Object.prototype.hasOwnProperty.call(user, 'reviewProvider'),
              onReset: () => pickProvider(''),
            }),
          ),
          h('select', {
            style: selectStyle,
            value: provider,
            disabled: !writable || groups === null,
            onChange: (event) => pickProvider(event.target.value),
          },
            h('option', { value: '' }, '跟随会话当前使用的模型'),
            groups !== null && groups.map((g) => h('option', { key: g.id, value: g.id }, g.name)),
            !providerKnown && h('option', { value: provider }, provider + '，当前值，目录中不存在'),
          ),
          h('p', { style: hintStyle }, groups === null ? '正在加载模型目录，请稍候。' : '审查用的模型 provider。'),
        ),
        h('div', { style: fieldStyle },
          h('div', { style: labelRowStyle },
            h('span', { style: labelStyle }, '审查模型'),
            h(ResetButton, {
              overridden: Object.prototype.hasOwnProperty.call(user, 'reviewModel'),
              onReset: () => pickModel(''),
            }),
          ),
          h('select', {
            style: selectStyle,
            value: model,
            disabled: !writable || provider === '' || group === undefined,
            onChange: (event) => pickModel(event.target.value),
          },
            h('option', { value: '' }, '跟随会话当前使用的模型'),
            group !== undefined && group.models.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
            group !== undefined && model !== '' && !group.models.some((m) => m.id === model)
              && h('option', { value: model }, model + '，当前值，目录中不存在'),
          ),
          h('p', { style: hintStyle },
            provider === '' ? '选择 provider 后可挑选模型。两者都留空时跟随会话当前使用的模型。' : '审查用的模型，可以选比主模型便宜的模型。',
          ),
        ),
      )
    }

    /**
     * 审查推理等级的选择。选项来自所选模型在目录里公布的等级列表。
     * 跟随会话模型、目录加载失败、或者所选模型未公布可选推理等级时
     * 退化为手动填写的文本框。留空时跟随模型自身的默认。
     */
    function EffortPicker(props) {
      const { value, user, writable, groups, catalogFailed, set, unset } = props
      const effort = value.reviewReasoningEffort ?? ''
      const overridden = Object.prototype.hasOwnProperty.call(user, 'reviewReasoningEffort')
      const provider = value.reviewProvider ?? ''
      const model = value.reviewModel ?? ''
      const info = groups?.find((g) => g.id === provider)?.models.find((m) => m.id === model)
      const efforts = info?.reasoning?.efforts
      if (catalogFailed || provider === '' || model === '' || efforts === undefined || efforts.length === 0) {
        return h(TextField, {
          label: '审查推理等级',
          value: effort, overridden, writable,
          set: (next) => set('reviewReasoningEffort', next), unset: () => unset('reviewReasoningEffort'),
          placeholder: '跟随模型自身的默认',
          hint: provider === '' || model === ''
            ? '跟随会话模型时无法列出可选推理等级，可手动填写。留空跟随模型自身的默认。'
            : '所选模型未公布可选推理等级，可手动填写。留空跟随模型自身的默认。',
        })
      }
      const effortKnown = effort === '' || efforts.some((e) => e.id === effort)
      return h('div', { style: fieldStyle },
        h('div', { style: labelRowStyle },
          h('span', { style: labelStyle }, '审查推理等级'),
          h(ResetButton, { overridden, onReset: () => unset('reviewReasoningEffort') }),
        ),
        h('select', {
          style: selectStyle,
          value: effort,
          disabled: !writable,
          onChange: (event) => {
            if (event.target.value === '') unset('reviewReasoningEffort')
            else set('reviewReasoningEffort', event.target.value)
          },
        },
          h('option', { value: '' }, '跟随模型自身的默认'),
          efforts.map((e) => h('option', { key: e.id, value: e.id }, e.name)),
          !effortKnown && h('option', { value: effort }, effort + '，当前值，该模型不支持'),
        ),
        h('p', { style: hintStyle }, '审查模型的推理等级，选项来自所选模型公布的等级列表。'),
      )
    }

    /** 文本字段。失焦时提交，清空表示放弃覆盖，恢复缺省。 */
    function TextField(props) {
      const [text, setText] = useState(props.value ?? '')
      useEffect(() => setText(props.value ?? ''), [props.value])
      const commit = () => {
        const trimmed = text.trim()
        if (trimmed === (props.value ?? '')) return
        if (trimmed === '') props.unset()
        else props.set(trimmed)
      }
      return h('div', { style: fieldStyle },
        h('div', { style: labelRowStyle },
          h('span', { style: labelStyle }, props.label),
          h(ResetButton, { overridden: props.overridden, onReset: () => props.unset() }),
        ),
        h('input', {
          style: inputStyle,
          value: text,
          disabled: !props.writable,
          placeholder: props.placeholder,
          onChange: (event) => setText(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => { if (event.key === 'Enter') event.target.blur() },
        }),
        h('p', { style: hintStyle }, props.hint),
      )
    }

    /**
     * 数字字段。失焦时提交，值夹到 [min, max] 内取整，清空恢复缺省。
     */
    function NumberField(props) {
      const [text, setText] = useState(String(props.value ?? ''))
      useEffect(() => setText(String(props.value ?? '')), [props.value])
      const commit = () => {
        const raw = text.trim()
        if (raw === '') {
          props.unset()
          return
        }
        const parsed = Number(raw)
        if (!Number.isFinite(parsed)) {
          setText(String(props.value ?? ''))
          return
        }
        const next = Math.max(props.min, Math.min(props.max, Math.round(parsed)))
        setText(String(next))
        if (next === props.value) return
        props.set(next)
      }
      return h('div', { style: fieldStyle },
        h('div', { style: labelRowStyle },
          h('span', { style: labelStyle }, props.label),
          h(ResetButton, { overridden: props.overridden, onReset: () => props.unset() }),
        ),
        h('input', {
          style: inputStyle,
          type: 'number',
          min: props.min,
          max: props.max,
          step: 1,
          value: text,
          disabled: !props.writable,
          onChange: (event) => setText(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => { if (event.key === 'Enter') event.target.blur() },
        }),
        h('p', { style: hintStyle }, props.hint),
      )
    }

    /** 开关字段，立即提交。 */
    function BoolField(props) {
      return h('div', { style: fieldStyle },
        h('div', { style: labelRowStyle },
          h('label', { style: checkRowStyle },
            h('input', {
              type: 'checkbox',
              checked: props.value ?? true,
              disabled: !props.writable,
              onChange: (event) => props.set(event.target.checked),
            }),
            props.label,
          ),
          h(ResetButton, { overridden: props.overridden, onReset: () => props.unset() }),
        ),
        h('p', { style: hintStyle }, props.hint),
      )
    }

    /**
     * 插件行的配置页。0.2.0 的设置界面把插件配置挂在 Plugins 页面里该插件
     * 那一行上：页面把 `{ view, form }` 交给注册进 `plugins.row.config` 的
     * 组件，form 提供快照和写入。读取走快照里的 value，写入是一次原子
     * mutate，path 指向 Config 里那个 volatile 节点。
     */
    function HumanizeCard(props) {
      const { form, view, modelCatalog } = props
      const [groups, setGroups] = useState(null)
      const [catalogFailed, setCatalogFailed] = useState(false)
      useEffect(() => {
        // 模型目录走 remote.session.modelCatalog。方法在注入回调里就取好
        // 传进来，避免在渲染期访问追踪型服务代理。没有 remote.session 时
        // 退化为手动填写的文本框。
        if (typeof modelCatalog !== 'function') {
          setCatalogFailed(true)
          return
        }
        let alive = true
        modelCatalog().then((res) => {
          if (!alive) return
          if (res.ok) setGroups(res.value.groups)
          else setCatalogFailed(true)
        }, () => { if (alive) setCatalogFailed(true) })
        return () => { alive = false }
      }, [])

      // 行摘要：Plugins 列表里作为该行的说明文字。
      if (view === 'summary') return h('p', { style: hintStyle }, '写入内容的行文审查与批注合并。')

      const snapshot = form?.state
      if (snapshot === undefined) return h('p', { style: hintStyle }, '设置服务不可用。')
      if (snapshot.status === 'loading') return h('p', { style: hintStyle }, '正在加载设置…')
      if (snapshot.status !== 'ready') return h('p', { style: hintStyle }, '设置服务不可用。')
      const value = snapshot.value?.[SETTINGS_KEY] ?? {}
      const user = snapshot.user?.[SETTINGS_KEY] ?? {}
      const writable = snapshot.writable !== false
      const set = (field, next) => {
        void form.mutate([{ op: 'set', path: [SETTINGS_KEY, field], value: next }], snapshot.revision)
      }
      const unset = (field) => {
        void form.mutate([{ op: 'unset', path: [SETTINGS_KEY, field] }], snapshot.revision)
      }

      return h('div', null,
        h(ModelPicker, { value, user, writable, groups, catalogFailed, set, unset }),
        h(EffortPicker, { value, user, writable, groups, catalogFailed, set, unset }),
        h(NumberField, {
          label: '并行批次大小',
          value: value.reviewConcurrency ?? 3,
          overridden: Object.prototype.hasOwnProperty.call(user, 'reviewConcurrency'),
          writable,
          min: 1,
          max: 16,
          set: (next) => set('reviewConcurrency', next),
          unset: () => unset('reviewConcurrency'),
          hint: '同时在途的审查调用数，1 到 16。缺省 3，调大更快但更容易撞上模型的速率限制。',
        }),
        h(NumberField, {
          label: '失败重试次数',
          value: value.reviewRetries ?? 1,
          overridden: Object.prototype.hasOwnProperty.call(user, 'reviewRetries'),
          writable,
          min: 0,
          max: 5,
          set: (next) => set('reviewRetries', next),
          unset: () => unset('reviewRetries'),
          hint: '失败的文件会插回下一批重试（和未处理的文件凑成同一批），单个文件最多重试几次，0 到 5。缺省 1。',
        }),
        h(BoolField, {
          label: '上下文压缩时自动合并',
          value: value.mergeOnCompaction,
          overridden: Object.prototype.hasOwnProperty.call(user, 'mergeOnCompaction'),
          writable,
          set: (next) => set('mergeOnCompaction', next),
          unset: () => unset('mergeOnCompaction'),
          hint: '压缩结束时自动合并整个项目的暂存批注。关闭后只在手动执行 /humanize 时合并。',
        }),
      )
    }

    /**
     * 渲染期错误边界。插槽条目渲染抛错时会被静默摘掉，页面上什么都不剩；
     * 这里把异常显示成文字，省得再对着空白页排查。
     */
    class DiagBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error !== null) {
          return h('p', { style: hintStyle }, `行文审查设置渲染失败：${String(this.state.error?.message ?? this.state.error)}`)
        }
        return this.props.children
      }
    }

    /**
     * 包页面内联的配置区。plugins.bundle.config 这个座位不传 form，组件
     * 自己从 configForms 取。这里不用 hooks：页面本身订阅了 describe 镜像，
     * 设置变化会让整页重渲染，重渲染时重新读取快照即可。
     */
    function ConfigSection(props) {
      const { configForms, modelCatalog } = props
      let state
      let mutate = () => {}
      try {
        const form = configForms.get(NS)
        state = form.getSnapshot()
        mutate = (ops, revision) => form.mutate(ops, revision)
      } catch (error) {
        return h('p', { style: hintStyle }, `行文审查设置读取失败：${String(error?.message ?? error)}`)
      }
      return h(DiagBoundary, null,
        h(HumanizeCard, { view: 'page', form: { state, mutate }, modelCatalog }))
    }

    /** 空 roster 的共享引用，避免 getSnapshot 每次新建数组。 */
    const EMPTY_ROWS = []

    /**
     * 当前会话的审查任务行。宿主把 /humanize-review 批次注册成
     * kind 为 humanize-review 的后台任务，进度行形如
     * `done/total · 已暂存 N 条批注`，终态信息在 detail 上。
     * 进行中只会有一个；结算记录停留期间可能和新批次并存，优先
     * 取进行中的，否则取最新的一条。
     */
    function useReviewJob(jobs, sessionId) {
      useEffect(() => jobs.watchRows(sessionId), [jobs, sessionId])
      const snapshot = useSyncExternalStore(
        (listener) => jobs.state.subscribe(listener),
        () => jobs.state.getSnapshot(),
      )
      const rows = (snapshot.rows[sessionId] ?? EMPTY_ROWS).filter((row) => row.kind === 'humanize-review')
      return rows.find((row) => row.status === 'running' || row.status === 'stopping')
        ?? rows[rows.length - 1]
        ?? null
    }

    /**
     * 任务行的展示形态。pct 为 null 时不画进度条。进度从进度行的
     * `done/total` 前缀解析，解析不出时按 0 处理。
     */
    function jobView(row) {
      if (row.status === 'running' || row.status === 'stopping') {
        const match = /(\d+)\/(\d+)/.exec(row.progress ?? '')
        const done = match === null ? 0 : Number(match[1])
        const total = match === null ? 0 : Number(match[2])
        return { pct: total > 0 ? (done / total) * 100 : 0, meta: row.progress ?? '', done: false }
      }
      return { pct: row.status === 'completed' ? 100 : null, meta: row.detail ?? '', done: row.status === 'completed' }
    }

    // 外框照抄官方 todo 条的容器规范。宽度让出两侧边距，圆角卡片，
    // tip 底色加一级描边，与 composer 卡片对齐。
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
     * 输入框上方的审查进度条。进行中的状态一直显示；终态停留由宿主
     * 控制——结算记录在任务列表里停留几秒后被摘掉，进度条随之消失。
     */
    function ProgressDock(props) {
      const { jobs, sessionId } = props
      const row = useReviewJob(jobs, sessionId)
      if (row === null || row === undefined) return null
      const view = jobView(row)
      const rows = [h('div', { key: 'head', style: dockRowStyle },
        h('span', { style: dockTitleStyle }, '行文审查'),
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

    function apply(ctx) {
      // jobs 服务提供任务 roster 流。没有它时进度条不注册，其余功能
      // 照常。
      ctx.inject(['jobs'], (jobCtx) => {
        const jobs = jobCtx.jobs
        jobCtx.slots.inject('conversation.input.dock', () => jobCtx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-humanize-progress',
          order: 30,
        }, (owner) => h(ProgressDock, { jobs, sessionId: String(owner.sessionId) })))
      })
      // 设置页有两处座位：包页面上内联的配置区（按包名），以及包内那一行
      // 点进去的配置页（按 <包名>#<行 id>）。两者写同一份设置。
      ctx.inject(['configForms'], (formCtx) => {
        // remote 是按命名空间追踪的代理：访问 remote.session 这一跳必须在
        // inject 里声明 "remote.session"（只声明 "remote" 会在渲染期抛
        // cannot get property "remote.session" without inject）。方法在这里
        // 就取好绑定好，往下传普通函数，渲染期不再碰代理。
        formCtx.inject(['remote', 'remote.session'], (remCtx) => {
          const configForms = formCtx.configForms
          const sessionRemote = remCtx.remote.session
          const modelCatalog = typeof sessionRemote?.modelCatalog === 'function'
            ? sessionRemote.modelCatalog.bind(sessionRemote)
            : undefined
          formCtx.effect(() => configForms.whileServed([NS], () => {
            const bundle = formCtx.slots.register({
              name: 'plugins.bundle.config',
              key: NS,
            }, () => h(ConfigSection, { configForms, modelCatalog }))
            const row = formCtx.slots.register({
              name: 'plugins.row.config',
              key: `${NS}#${NS}`,
            }, (props) => h(DiagBoundary, null,
              h(HumanizeCard, { view: props.view, form: props.form, modelCatalog })))
            return () => {
              bundle()
              row()
            }
          }), 'dsh-humanize: settings page')
        })
      })
    }

    exports.name = 'dsh-humanize'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
