/**
 * dsh-humanize 浏览器端：设置页的配置卡片，以及输入框上方的审查
 * 进度条。
 *
 * 卡片通过 settings.plugin.item 插槽按命名空间投递，读写走
 * settingsScope 服务，改动实时生效。进度条挂在 conversation.input.dock
 * 插槽，数据来自会话事件流里的 humanize/progress 事件。
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

    const NS = 'dsh-humanize'

    const cardStyle = {
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '12px',
      padding: '0 16px',
    }
    const headRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '14px 0',
      cursor: 'pointer',
      userSelect: 'none',
    }
    const titleStyle = {
      margin: 0,
      fontSize: '14px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
      lineHeight: 1.5,
    }
    const descStyle = {
      margin: '2px 0 0',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-tertiary)',
      lineHeight: 1.5,
    }
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

    /** 字段被用户覆盖时给出恢复缺省的入口，清除后落回 base 层。 */
    function ResetButton(props) {
      if (!props.overridden) return null
      return h('button', { type: 'button', style: resetStyle, onClick: props.onReset }, '恢复缺省')
    }

    /**
     * 审查模型的两级选择。provider 选项来自宿主的模型目录，模型选项
     * 跟随选中的 provider。目录加载失败时退化为手填文本框。两个字段
     * 都留空时跟随会话当前使用的模型。
     */
    function ModelPicker(props) {
      const { scope, value, user, writable, groups, catalogFailed } = props

      if (catalogFailed) {
        return h(Fragment, null,
          h(TextField, {
            scope, label: '审查模型 provider', field: 'reviewProvider',
            value: value.reviewProvider, overridden: Object.prototype.hasOwnProperty.call(user, 'reviewProvider'),
            writable, placeholder: '跟随会话当前模型',
            hint: '模型目录加载失败，请手动填写 provider。留空时跟随会话当前使用的模型。',
          }),
          h(TextField, {
            scope, label: '审查模型', field: 'reviewModel',
            value: value.reviewModel, overridden: Object.prototype.hasOwnProperty.call(user, 'reviewModel'),
            writable, placeholder: '跟随会话当前模型',
            hint: '模型目录加载失败，请手动填写模型名。留空时跟随会话当前使用的模型。',
          }),
        )
      }

      const provider = value.reviewProvider ?? ''
      const model = value.reviewModel ?? ''
      const group = groups === null ? undefined : groups.find((g) => g.id === provider)
      const providerKnown = provider === '' || groups === null || groups.some((g) => g.id === provider)

      const pickProvider = (next) => {
        if (next === '') scope.unset('reviewProvider')
        else void scope.set('reviewProvider', next)
        // 换 provider 后旧模型一般不存在于新目录，顺手清掉，推理等级
        // 是模型专属的，也一起清掉。
        const nextGroup = groups === null ? undefined : groups.find((g) => g.id === next)
        if (model !== '' && (nextGroup === undefined || !nextGroup.models.some((m) => m.id === model))) {
          scope.unset('reviewModel')
          scope.unset('reviewReasoningEffort')
        }
      }
      const pickModel = (next) => {
        if (next === '') scope.unset('reviewModel')
        else void scope.set('reviewModel', next)
        scope.unset('reviewReasoningEffort')
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
            h('option', { value: '' }, '跟随会话当前模型'),
            groups !== null && groups.map((g) => h('option', { key: g.id, value: g.id }, g.name)),
            !providerKnown && h('option', { value: provider }, provider + '（当前值，目录中不存在）'),
          ),
          h('p', { style: hintStyle }, groups === null ? '正在加载模型目录……' : '审查用的模型 provider。'),
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
            h('option', { value: '' }, '跟随会话当前模型'),
            group !== undefined && group.models.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
            group !== undefined && model !== '' && !group.models.some((m) => m.id === model)
              && h('option', { value: model }, model + '（当前值，目录中不存在）'),
          ),
          h('p', { style: hintStyle },
            provider === '' ? '选择 provider 后可挑选模型。两者都留空时跟随会话当前使用的模型。' : '审查用的模型，可以选比主模型便宜的模型。',
          ),
        ),
      )
    }

    /**
     * 审查推理等级的选择。选项来自所选模型在目录里公布的等级列表。
     * 跟随会话模型、目录加载失败、或者所选模型没公布等级时退化为
     * 手填文本框。留空时跟随模型自身的默认。
     */
    function EffortPicker(props) {
      const { scope, value, user, writable, groups, catalogFailed } = props
      const effort = value.reviewReasoningEffort ?? ''
      const overridden = Object.prototype.hasOwnProperty.call(user, 'reviewReasoningEffort')
      const provider = value.reviewProvider ?? ''
      const model = value.reviewModel ?? ''
      const info = groups?.find((g) => g.id === provider)?.models.find((m) => m.id === model)
      const efforts = info?.reasoning?.efforts
      if (catalogFailed || provider === '' || model === '' || efforts === undefined || efforts.length === 0) {
        return h(TextField, {
          scope, label: '审查推理等级', field: 'reviewReasoningEffort',
          value: effort, overridden, writable,
          placeholder: '跟随模型默认',
          hint: provider === '' || model === ''
            ? '跟随会话模型时列不出可选等级，可手填。留空跟随模型自身的默认。'
            : '所选模型未公布可选推理等级，可手填。留空跟随模型自身的默认。',
        })
      }
      const effortKnown = effort === '' || efforts.some((e) => e.id === effort)
      return h('div', { style: fieldStyle },
        h('div', { style: labelRowStyle },
          h('span', { style: labelStyle }, '审查推理等级'),
          h(ResetButton, { overridden, onReset: () => scope.unset('reviewReasoningEffort') }),
        ),
        h('select', {
          style: selectStyle,
          value: effort,
          disabled: !writable,
          onChange: (event) => {
            if (event.target.value === '') scope.unset('reviewReasoningEffort')
            else void scope.set('reviewReasoningEffort', event.target.value)
          },
        },
          h('option', { value: '' }, '跟随模型默认'),
          efforts.map((e) => h('option', { key: e.id, value: e.id }, e.name)),
          !effortKnown && h('option', { value: effort }, effort + '（当前值，该模型不支持）'),
        ),
        h('p', { style: hintStyle }, '审查模型的推理等级，选项来自所选模型公布的等级列表。'),
      )
    }

    /** 文本字段。失焦时提交，清空表示放弃覆盖，落回缺省行为。 */
    function TextField(props) {
      const [text, setText] = useState(props.value ?? '')
      useEffect(() => setText(props.value ?? ''), [props.value])
      const commit = () => {
        const trimmed = text.trim()
        if (trimmed === (props.value ?? '')) return
        if (trimmed === '') props.scope.unset(props.field)
        else void props.scope.set(props.field, trimmed)
      }
      return h('div', { style: fieldStyle },
        h('div', { style: labelRowStyle },
          h('span', { style: labelStyle }, props.label),
          h(ResetButton, { overridden: props.overridden, onReset: () => props.scope.unset(props.field) }),
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

    /** 开关字段，立即提交。 */
    function BoolField(props) {
      return h('div', { style: fieldStyle },
        h('div', { style: labelRowStyle },
          h('label', { style: checkRowStyle },
            h('input', {
              type: 'checkbox',
              checked: props.value ?? true,
              disabled: !props.writable,
              onChange: (event) => void props.scope.set(props.field, event.target.checked),
            }),
            props.label,
          ),
          h(ResetButton, { overridden: props.overridden, onReset: () => props.scope.unset(props.field) }),
        ),
        h('p', { style: hintStyle }, props.hint),
      )
    }

    /** 折叠箭头，跟随展开状态旋转。 */
    function Chevron(props) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 14 14',
        style: {
          color: 'var(--dsw-alias-label-tertiary)',
          transition: 'transform 150ms',
          transform: props.expanded ? 'rotate(90deg)' : 'none',
          flexShrink: 0,
        },
      }, h('path', {
        d: 'M5 3.5 8.5 7 5 10.5',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function HumanizeCard(props) {
      const scope = props.scope
      // subscribe 和 getSnapshot 依赖实例的 this，包一层箭头函数再交给 React。
      const snapshot = useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
      )
      const [expanded, setExpanded] = useState(false)
      const [groups, setGroups] = useState(null)
      const [catalogFailed, setCatalogFailed] = useState(false)
      useEffect(() => {
        if (props.api === null) {
          setCatalogFailed(true)
          return
        }
        let alive = true
        props.api.llm.models({}).then((res) => {
          if (!alive) return
          if (res.result && res.result.ok) setGroups(res.result.value.groups)
          else setCatalogFailed(true)
        }, () => { if (alive) setCatalogFailed(true) })
        return () => { alive = false }
      }, [])
      if (snapshot.status !== 'ready' || snapshot.value === undefined) return null
      const value = snapshot.value
      const user = snapshot.user ?? {}
      const overridden = (field) => Object.prototype.hasOwnProperty.call(user, field)
      return h('div', { style: cardStyle },
        h('div', {
          style: headRowStyle,
          onClick: () => setExpanded(!expanded),
        },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h3', { style: titleStyle }, '行文审查'),
            h('p', { style: descStyle }, '写入内容的行文审查与批注合并。'),
          ),
          h(Chevron, { expanded }),
        ),
        expanded && h('div', null,
          h(ModelPicker, {
            scope, value, user, groups, catalogFailed,
            writable: snapshot.writable,
          }),
          h(EffortPicker, {
            scope, value, user, groups, catalogFailed,
            writable: snapshot.writable,
          }),
          h(BoolField, {
            scope, label: '上下文压缩时自动合并', field: 'mergeOnCompaction',
            value: value.mergeOnCompaction, overridden: overridden('mergeOnCompaction'),
            writable: snapshot.writable,
            hint: '压缩结束时自动合并整个项目的暂存批注。关闭后只在手动执行 /humanize 时合并。',
          }),
        ),
      )
    }

    /** 审查进度 store。键是会话 id，值是最近一次进度事件的数据。 */
    function createProgressStore() {
      const batches = new Map()
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        get(sessionId) {
          return batches.get(sessionId)
        },
        set(sessionId, data) {
          batches.set(sessionId, data)
          emit()
        },
        clear(sessionId) {
          batches.delete(sessionId)
          emit()
        },
      }
    }

    /** 订阅事件流，把 humanize/progress 事件写进 store。断开就停，刷新页面重新订阅。 */
    function startProgressPump(ctx, api, store) {
      const ac = new AbortController()
      ctx.on('dispose', () => ac.abort())
      const run = async () => {
        const stream = api.events.mux({}, ac.signal)
        for await (const item of stream) {
          const frame = item !== null && typeof item === 'object' && 'payload' in item ? item.payload : item
          if (frame === null || typeof frame !== 'object' || frame.type !== 'session/event') continue
          const event = frame.event
          if (event === null || typeof event !== 'object' || event.type !== 'humanize/progress') continue
          if (event.data === null || typeof event.data !== 'object') continue
          store.set(String(frame.sessionId), event.data)
        }
      }
      run().catch(() => {})
    }

    /** 各阶段的进度条文案。 */
    function progressText(progress) {
      switch (progress.phase) {
        case 'start': return `行文审查中 · 0/${progress.total}`
        case 'progress': return `行文审查中 · ${progress.done}/${progress.total} · 已暂存 ${progress.annotations} 条批注`
        case 'done': {
          const extras = []
          if (progress.noSpec > 0) extras.push(`${progress.noSpec} 个没有规范可对照`)
          if (progress.failed > 0) extras.push(`${progress.failed} 个失败`)
          return `审查完成 · ${progress.total} 个文件 · 暂存批注 ${progress.annotations} 条${extras.length > 0 ? `（${extras.join('，')}）` : ''} · 用 /humanize 合并`
        }
        case 'empty': return '没有可审查的文件。只审查受 git 管理且后缀在规范链 extensions 声明范围内的文件。'
        case 'blocked': return progress.reason === 'merging' ? '批注合并进行中，完成后再审查。' : '已有一个审查任务在进行，等它结束后再派发。'
        case 'failed': return `审查任务失败：${progress.message}`
        default: return ''
      }
    }

    /** 终态停留这么久之后进度条消失。 */
    const PROGRESS_LINGER_MS = 6000

    const dockStyle = {
      fontSize: '12px',
      color: 'var(--dsw-alias-label-tertiary)',
      padding: '2px 4px',
    }

    /** 输入框上方的审查进度条。进行中的状态一直显示，终态停留几秒后消失。 */
    function ProgressDock(props) {
      const { store, sessionId } = props
      const progress = useSyncExternalStore(
        (listener) => store.subscribe(listener),
        () => store.get(sessionId) ?? null,
      )
      useEffect(() => {
        if (progress === null || progress.phase === 'start' || progress.phase === 'progress') return undefined
        const timer = setTimeout(() => store.clear(sessionId), PROGRESS_LINGER_MS)
        return () => clearTimeout(timer)
      }, [progress])
      if (progress === null) return null
      return h('div', { style: dockStyle }, progressText(progress))
    }

    function apply(ctx) {
      const progressStore = createProgressStore()
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'dsh-humanize-progress',
        order: 30,
      }, (owner) => h(ProgressDock, { store: progressStore, sessionId: String(owner.sessionId) })))
      // settingsScope 标识宿主有插件配置页。老宿主没有这个服务时卡片
      // 不出现，条目配置照常生效。
      ctx.inject(['settingsScope'], (scoped) => {
        const scope = scoped.settingsScope.bind({ namespace: NS })
        // 模型目录和事件流走 connection 的 api。没有 connection 时卡片
        // 仍注册，ModelPicker 加载失败后退化为手填文本框，进度条保持隐藏。
        const api = scoped.get('connection') !== undefined ? scoped.get('connection').api : null
        if (api !== null) startProgressPump(ctx, api, progressStore)
        scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
          name: 'settings.plugin.item',
          key: NS,
        }, () => h(HumanizeCard, { scope, api })))
      })
    }

    exports.name = 'dsh-humanize'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
