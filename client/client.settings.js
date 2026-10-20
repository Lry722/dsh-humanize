/**
 * dsh-humanize 浏览器端设置卡片，由通用表单控件和业务字段两部分组成。
 * 通用表单控件包括文本、数字、开关和恢复默认值。
 *
 * 业务字段按用途分三组。审查模型和审查推理等级负责模型选择。并行批次
 * 大小、失败重试次数和循环合并轮次上限负责批量与重试。上下文压缩时
 * 自动合并和储存位置负责合并与储存。
 */
window.__ModuleLoader__.load({
  id: 'dsh-humanize',
  chunk: 'client.settings.js',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { Fragment, useEffect, useState } = React

    /** 这是设置的命名空间，同时用作宿主条目和 Plugins 页面里本插件行的 id。 */
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
    const storageRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    }
    const storageLabelStyle = {
      flex: 'none',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-tertiary)',
    }
    const storagePathStyle = {
      flex: 1,
      minWidth: 0,
      fontSize: '12px',
      fontFamily: 'monospace',
      color: 'var(--dsw-alias-label-secondary)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    /** 字段被用户覆盖时给出恢复默认值的入口。 */
    function ResetButton(props) {
      if (!props.overridden) return null
      return h('button', { type: 'button', style: resetStyle, onClick: props.onReset }, '恢复默认值')
    }

    const copyButtonStyle = {
      flex: 'none',
      font: 'inherit',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-secondary)',
      background: 'var(--dsw-alias-bg-layer-3)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '6px',
      padding: '2px 10px',
      cursor: 'pointer',
    }

    /** 复制路径到剪贴板，复制成功后短暂显示已复制。 */
    function CopyButton(props) {
      const [copied, setCopied] = useState(false)
      return h('button', {
        type: 'button',
        style: copied ? { ...copyButtonStyle, color: 'var(--dsw-alias-state-success-primary)' } : copyButtonStyle,
        onClick: () => {
          navigator.clipboard?.writeText(props.text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }, () => {})
        },
      }, copied ? '已复制' : '复制')
    }

    /** 暂存批注与审查请求留档的储存位置，带复制入口。 */
    function StoragePaths(props) {
      const custom = typeof props.storageDir === 'string' ? props.storageDir.trim() : ''
      const root = custom.length > 0 ? custom.replace(/[\\/]+$/, '') : '~/.dsh/humanize'
      const rows = [
        ['暂存批注', `${root}/annotations`],
        ['审查请求留档', `${root}/requests`],
      ]
      return h('div', { style: fieldStyle },
        rows.map(([label, path]) => h('div', { key: label, style: storageRowStyle },
          h('span', { style: storageLabelStyle }, label),
          h('span', { style: storagePathStyle }, path),
          h(CopyButton, { text: path }),
        )),
      )
    }

    /**
     * 字段外壳：标签行、恢复默认值入口和说明文字，控件本体是 children。
     * labelContent 用于标签和控件同行的场景，比如开关。
     */
    function FieldShell(props) {
      return h('div', { style: fieldStyle },
        h('div', { style: labelRowStyle },
          props.labelContent ?? h('span', { style: labelStyle }, props.label),
          h(ResetButton, { overridden: props.overridden, onReset: props.onReset }),
        ),
        props.children,
        h('p', { style: hintStyle }, props.hint),
      )
    }

    /** 审查模型的两级选择，先选模型提供方，再选模型。 */
    function ModelPicker(props) {
      const { value, user, writable, groups, catalogFailed, set, unset } = props
      if (catalogFailed) {
        return h(Fragment, null,
          h(TextField, {
            label: '审查模型提供方', value: value.reviewProvider,
            overridden: Object.prototype.hasOwnProperty.call(user, 'reviewProvider'),
            writable, set: (next) => set('reviewProvider', next), unset: () => unset('reviewProvider'),
            placeholder: '跟随会话当前使用的模型',
            hint: '模型目录加载失败，请手动填写模型提供方。留空时跟随会话当前使用的模型。',
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
        // 换模型提供方后清掉旧模型，因为旧模型一般只属于原提供方。
        const nextGroup = groups === null ? undefined : groups.find((g) => g.id === next)
        if (model !== '' && (nextGroup === undefined || !nextGroup.models.some((m) => m.id === model))) {
          unset('reviewModel')
          // 推理等级是模型专属的，一并清掉。
          unset('reviewReasoningEffort')
        }
      }
      const pickModel = (next) => {
        if (next === '') unset('reviewModel')
        else set('reviewModel', next)
        unset('reviewReasoningEffort')
      }

      return h(Fragment, null,
        h(FieldShell, {
          label: '审查模型提供方',
          overridden: Object.prototype.hasOwnProperty.call(user, 'reviewProvider'),
          onReset: () => pickProvider(''),
          hint: groups === null ? '正在加载模型目录，请稍候。' : '审查时调用的模型提供方，留空时跟随会话当前使用的模型。',
        },
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
        ),
        h(FieldShell, {
          label: '审查模型',
          overridden: Object.prototype.hasOwnProperty.call(user, 'reviewModel'),
          onReset: () => pickModel(''),
          hint: provider === '' ? '选择模型提供方后可挑选模型。两者都留空时跟随会话当前使用的模型。' : '审查用的模型，可以选择成本更低的模型。',
        },
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
        ),
      )
    }

    /** 审查推理等级的选择，选项来自所选模型在目录里公布的等级列表。 */
    function EffortPicker(props) {
      const { value, user, writable, groups, catalogFailed, set, unset } = props
      const effort = value.reviewReasoningEffort ?? ''
      const overridden = Object.prototype.hasOwnProperty.call(user, 'reviewReasoningEffort')
      const provider = value.reviewProvider ?? ''
      const model = value.reviewModel ?? ''
      const info = groups?.find((g) => g.id === provider)?.models.find((m) => m.id === model)
      const efforts = info?.reasoning?.efforts
      // 以下情况退化为手动填写的文本框。跟随会话当前使用的模型。模型
      // 目录加载失败。所选模型缺少可选推理等级。留空时使用模型的默认
      // 推理等级。
      if (catalogFailed || provider === '' || model === '' || efforts === undefined || efforts.length === 0) {
        return h(TextField, {
          label: '审查推理等级',
          value: effort, overridden, writable,
          set: (next) => set('reviewReasoningEffort', next), unset: () => unset('reviewReasoningEffort'),
          placeholder: '使用模型的默认推理等级',
          hint: provider === '' || model === ''
            ? '当前跟随会话模型，没有可选的推理等级列表，可以手动填写。留空时使用模型的默认推理等级。'
            : '所选模型缺少可选推理等级，可以手动填写。留空时使用模型的默认推理等级。',
        })
      }
      const effortKnown = effort === '' || efforts.some((e) => e.id === effort)
      return h(FieldShell, {
        label: '审查推理等级',
        overridden,
        onReset: () => unset('reviewReasoningEffort'),
        hint: '审查模型的推理等级，选项来自所选模型公布的等级列表。',
      },
        h('select', {
          style: selectStyle,
          value: effort,
          disabled: !writable,
          onChange: (event) => {
            if (event.target.value === '') unset('reviewReasoningEffort')
            else set('reviewReasoningEffort', event.target.value)
          },
        },
          h('option', { value: '' }, '使用模型的默认推理等级'),
          efforts.map((e) => h('option', { key: e.id, value: e.id }, e.name)),
          !effortKnown && h('option', { value: effort }, effort + '，当前值，该模型不支持'),
        ),
      )
    }

    /** 文本字段在失焦时提交，清空后恢复默认值。 */
    function TextField(props) {
      const [text, setText] = useState(props.value ?? '')
      useEffect(() => setText(props.value ?? ''), [props.value])
      const commit = () => {
        const trimmed = text.trim()
        if (trimmed === (props.value ?? '')) return
        if (trimmed === '') props.unset()
        else props.set(trimmed)
      }
      return h(FieldShell, {
        label: props.label,
        overridden: props.overridden,
        onReset: () => props.unset(),
        hint: props.hint,
      },
        h('input', {
          style: inputStyle,
          value: text,
          disabled: !props.writable,
          placeholder: props.placeholder,
          onChange: (event) => setText(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => { if (event.key === 'Enter') event.target.blur() },
        }),
      )
    }

    /**
     * 数字字段在失焦时提交。提交时把值限制在最小值和最大值之间，
     * 再取整。清空后恢复默认值。
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
        const next = Math.max(props.min ?? 0, Math.min(props.max ?? Infinity, Math.round(parsed)))
        setText(String(next))
        if (next === props.value) return
        props.set(next)
      }
      return h(FieldShell, {
        label: props.label,
        overridden: props.overridden,
        onReset: () => props.unset(),
        hint: props.hint,
      },
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
      )
    }

    function BoolField(props) {
      return h(FieldShell, {
        labelContent: h('label', { style: checkRowStyle },
          h('input', {
            type: 'checkbox',
            checked: props.value ?? true,
            disabled: !props.writable,
            onChange: (event) => props.set(event.target.checked),
          }),
          props.label,
        ),
        overridden: props.overridden,
        onReset: () => props.unset(),
        hint: props.hint,
      })
    }

    /**
     * 插件行的配置页，负责渲染摘要文字和完整表单。view 区分这两种
     * 形态。设置快照和写入入口由调用方通过 props 传入。
     */
    function HumanizeCard(props) {
      const { form, view, modelCatalog } = props
      const [groups, setGroups] = useState(null)
      const [catalogFailed, setCatalogFailed] = useState(false)
      useEffect(() => {
        // modelCatalog 缺失时改为手动填写的表单。
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

      // 插件列表里这一行的摘要文字。
      if (view === 'summary') return h('p', { style: hintStyle }, '对写入的内容做行文审查，并把批注合并进来。')

      const snapshot = form?.state
      if (snapshot === undefined) return h('p', { style: hintStyle }, '设置服务不可用。')
      if (snapshot.status === 'loading') return h('p', { style: hintStyle }, '正在加载设置。')
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
        // 下面几个数字字段的默认值要和 lib/defaults.js 保持一致，改动时两处同步。
        h(NumberField, {
          label: '并行批次大小',
          value: value.reviewConcurrency ?? 3,
          overridden: Object.prototype.hasOwnProperty.call(user, 'reviewConcurrency'),
          writable,
          min: 1,
          set: (next) => set('reviewConcurrency', next),
          unset: () => unset('reviewConcurrency'),
          hint: '同时进行中的审查调用数，默认值是 3，最小值是 1。批次太大时会碰到模型提供方的速率限制，碰到限制的调用记为失败并重试。',
        }),
        h(NumberField, {
          label: '失败重试次数',
          value: value.reviewRetries ?? 1,
          overridden: Object.prototype.hasOwnProperty.call(user, 'reviewRetries'),
          writable,
          min: 0,
          max: 3,
          set: (next) => set('reviewRetries', next),
          unset: () => unset('reviewRetries'),
          hint: '审查调用失败后自动重试，间隔逐次递增，超过次数记为失败。范围为 0 到 3，默认值是 1。',
        }),
        h(NumberField, {
          label: '循环合并轮次上限',
          value: value.loopMaxRounds ?? 3,
          overridden: Object.prototype.hasOwnProperty.call(user, 'loopMaxRounds'),
          writable,
          min: 1,
          max: 10,
          set: (next) => set('loopMaxRounds', next),
          unset: () => unset('loopMaxRounds'),
          hint: '/humanize-loop 每轮合并后复审，还有新批注就继续合并，达到上限则停下。默认值是 3，范围为 1 到 10。',
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
        h(TextField, {
          label: '储存位置',
          value: value.storageDir,
          overridden: Object.prototype.hasOwnProperty.call(user, 'storageDir'),
          writable,
          set: (next) => set('storageDir', next),
          unset: () => unset('storageDir'),
          placeholder: '使用默认位置',
          hint: '暂存批注和审查请求留档的储存位置。留空使用默认位置 ~/.dsh/humanize。改动后需要自己把旧目录里的内容搬到新位置。',
        }),
        h(StoragePaths, { storageDir: value.storageDir }),
      )
    }

    /**
     * 渲染期错误边界。插槽条目渲染抛错时会被静默摘掉，插槽位置会变成空白。
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

    /** 插件行配置页的入口组件。 */
    function RowCard(props) {
      return h(DiagBoundary, null, h(HumanizeCard, props))
    }

    /** 页面内联的配置区，自己读取设置数据。 */
    function ConfigSection(props) {
      const { configForms, modelCatalog } = props
      let state
      let mutate = () => {}
      try {
        const form = configForms.get(NS)
        // 页面订阅了 describe 镜像，设置变化触发整页重渲染，每次渲染
        // 都在这里重新读取快照。
        state = form.getSnapshot()
        mutate = (ops, revision) => form.mutate(ops, revision)
      } catch (error) {
        return h('p', { style: hintStyle }, `行文审查设置读取失败：${String(error?.message ?? error)}`)
      }
      return h(DiagBoundary, null,
        h(HumanizeCard, { view: 'page', form: { state, mutate }, modelCatalog }))
    }

    module.exports.RowCard = RowCard
    module.exports.ConfigSection = ConfigSection
    return module.exports
  },
})
