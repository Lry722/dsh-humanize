/**
 * dsh-humanize 浏览器端设置卡片，由通用表单控件和业务字段两部分组成。
 * 通用表单控件包括文本、数字、开关和恢复默认值。
 *
 * 业务字段按用途依次排列，具体分组在字段定义处说明。
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
    // 插槽传入的翻译函数。插槽没提供时，直接用 key 当作文案显示。
    let t = (key) => key
    // 数值字段的默认值，需要和 lib/settings.js 的字段表手动对齐。
    const FIELD_DEFAULTS = { reviewConcurrency: 3, reviewRetries: 1, loopMaxRounds: 3 }
    const FIELD_LIMITS = {
      reviewConcurrency: { min: 1 },
      reviewRetries: { min: 0, max: 3 },
      loopMaxRounds: { min: 1, max: 10 },
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

    /** 用户没改过这个字段时整个按钮都不渲染，标签行里也就不会留下空位。 */
    function ResetButton(props) {
      if (!props.overridden) return null
      return h('button', { type: 'button', style: resetStyle, onClick: props.onReset }, t('common.reset'))
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

    /** 把路径写入剪贴板，并给出复制成功的提示。 */
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
      }, copied ? t('common.copied') : t('common.copy'))
    }

    const testRowStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '8px',
      padding: '0 0 12px',
    }
    const testButtonStyle = { ...copyButtonStyle, flex: 'none' }
    const testStatusStyle = (status) => ({
      flex: 1,
      minWidth: 0,
      maxHeight: '120px',
      overflow: 'auto',
      fontSize: '12px',
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      color: status === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : status === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)',
    })

    /**
     * 测试审查模型或合并子代理的模型能否正常调用，结果就近显示在按钮右侧。
     */
    function ModelTest(props) {
      const { prefix, value, writable } = props
      const provider = value[`${prefix}Provider`] ?? ''
      const model = value[`${prefix}Model`] ?? ''
      const effort = value[`${prefix}ReasoningEffort`] ?? ''
      const [state, setState] = useState({ status: 'idle' })
      // 换了模型或推理等级后，上一次的测试结果就过期了。
      useEffect(() => { setState({ status: 'idle' }) }, [provider, model, effort])
      const ready = writable && provider !== '' && model !== ''
      const testing = state.status === 'testing'
      const run = () => {
        if (!ready || testing) return
        setState({ status: 'testing' })
        void fetch('api/humanize.model-test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider,
            model,
            ...(effort !== '' ? { reasoningEffort: effort } : {}),
          }),
        }).then(async (response) => {
          const result = await response.json().catch(() => null)
          if (result?.ok === true) {
            setState({ status: 'ok' })
            return
          }
          const message = result?.code === 'timeout'
            ? t('model.testTimeout')
            : (result?.message ?? `HTTP ${response.status}`)
          setState({ status: 'error', message })
        }).catch((error) => {
          setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        })
      }
      let statusText = ''
      if (!ready) statusText = writable ? t('model.testNeedSelection') : ''
      else if (testing) statusText = t('model.testing')
      else if (state.status === 'ok') statusText = t('model.testOk')
      else if (state.status === 'error') statusText = t('model.testFailed') + state.message
      return h('div', { style: testRowStyle },
        h('button', {
          type: 'button',
          style: ready && !testing ? testButtonStyle : { ...testButtonStyle, opacity: 0.5, cursor: 'default' },
          disabled: !ready || testing,
          title: t('model.testHint'),
          onClick: run,
        }, testing ? t('model.testing') : t('model.test')),
        statusText !== ''
          ? h('span', { style: testStatusStyle(state.status), 'aria-live': 'polite' }, statusText)
          : null,
      )
    }

    /** 暂存批注和审查请求记录的保存位置。暂存位置可以复制。 */
    function StoragePaths(props) {
      const custom = typeof props.storageDir === 'string' ? props.storageDir.trim() : ''
      const root = custom.length > 0 ? custom.replace(/[\\/]+$/, '') : '~/.dsh/humanize'
      const rows = [
        { label: t('paths.staging'), path: `${root}/annotations`, copy: true },
        { label: t('paths.requests'), path: t('paths.requestsValue'), copy: false },
      ]
      return h('div', { style: fieldStyle },
        rows.map((row) => h('div', { key: row.label, style: storageRowStyle },
          h('span', { style: storageLabelStyle }, row.label),
          h('span', { style: storagePathStyle }, row.path),
          row.copy ? h(CopyButton, { text: row.path }) : null,
        )),
      )
    }

    /**
     * 字段外壳由标签行、恢复默认值入口和说明文字组成。控件本体通过
     * children 传入。
     *
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

    /** 模型的两级选择，先选模型提供方，再选模型。prefix 区分审查和合并两组字段。 */
    function ModelPicker(props) {
      const { value, user, writable, groups, catalogFailed, set, unset } = props
      const prefix = props.prefix
      const providerKey = `${prefix}Provider`
      const modelKey = `${prefix}Model`
      if (catalogFailed) {
        return h(Fragment, null,
          h(TextField, {
            label: t(prefix === 'review' ? 'model.reviewProvider' : 'model.mergeProvider'), value: value[providerKey],
            overridden: Object.prototype.hasOwnProperty.call(user, providerKey),
            writable, set: (next) => set(providerKey, next), unset: () => unset(providerKey),
            placeholder: t('model.follow'),
            hint: t('model.providerFailed'),
          }),
          h(TextField, {
            label: t(prefix === 'review' ? 'model.reviewModel' : 'model.mergeModel'), value: value[modelKey],
            overridden: Object.prototype.hasOwnProperty.call(user, modelKey),
            writable, set: (next) => set(modelKey, next), unset: () => unset(modelKey),
            placeholder: t('model.follow'),
            hint: t('model.modelFailed'),
          }),
        )
      }

      const provider = value[providerKey] ?? ''
      const model = value[modelKey] ?? ''
      const group = groups === null ? undefined : groups.find((g) => g.id === provider)
      const providerKnown = provider === '' || groups === null || groups.some((g) => g.id === provider)

      const pickProvider = (next) => {
        if (next === '') unset(providerKey)
        else set(providerKey, next)
        // 换模型提供方后清掉旧模型，因为旧模型一般只属于原模型提供方。
        const nextGroup = groups === null ? undefined : groups.find((g) => g.id === next)
        if (model !== '' && (nextGroup === undefined || !nextGroup.models.some((m) => m.id === model))) {
          unset(modelKey)
          // 推理等级是模型专属的，一并清掉。
          unset(`${prefix}ReasoningEffort`)
        }
      }
      const pickModel = (next) => {
        if (next === '') unset(modelKey)
        else set(modelKey, next)
        unset(`${prefix}ReasoningEffort`)
      }

      return h(Fragment, null,
        h(FieldShell, {
          label: t(prefix === 'review' ? 'model.reviewProvider' : 'model.mergeProvider'),
          overridden: Object.prototype.hasOwnProperty.call(user, providerKey),
          onReset: () => pickProvider(''),
          hint: groups === null ? t('model.loading') : t(prefix === 'review' ? 'model.reviewProviderHint' : 'model.mergeProviderHint'),
        },
          h('select', {
            style: selectStyle,
            value: provider,
            disabled: !writable || groups === null,
            onChange: (event) => pickProvider(event.target.value),
          },
            h('option', { value: '' }, t('model.follow')),
            groups !== null && groups.map((g) => h('option', { key: g.id, value: g.id }, g.name)),
            !providerKnown && h('option', { value: provider }, provider + t('model.currentValue')),
          ),
        ),
        h(FieldShell, {
          label: t(prefix === 'review' ? 'model.reviewModel' : 'model.mergeModel'),
          overridden: Object.prototype.hasOwnProperty.call(user, modelKey),
          onReset: () => pickModel(''),
          hint: provider === '' ? t('model.selectProviderHint') : t(prefix === 'review' ? 'model.reviewModelHint' : 'model.mergeModelHint'),
        },
          h('select', {
            style: selectStyle,
            value: model,
            disabled: !writable || provider === '' || group === undefined,
            onChange: (event) => pickModel(event.target.value),
          },
            h('option', { value: '' }, t('model.follow')),
            group !== undefined && group.models.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
            group !== undefined && model !== '' && !group.models.some((m) => m.id === model)
              && h('option', { value: model }, model + t('model.currentValue')),
          ),
        ),
      )
    }

    /** 推理等级的选择，选项来自所选模型在目录里公布的等级列表。 */
    function EffortPicker(props) {
      const { value, user, writable, groups, catalogFailed, set, unset } = props
      const prefix = props.prefix
      const effortKey = `${prefix}ReasoningEffort`
      const effort = value[effortKey] ?? ''
      const overridden = Object.prototype.hasOwnProperty.call(user, effortKey)
      const provider = value[`${prefix}Provider`] ?? ''
      const model = value[`${prefix}Model`] ?? ''
      const info = groups?.find((g) => g.id === provider)?.models.find((m) => m.id === model)
      const efforts = info?.reasoning?.efforts
      // 缺模型或不支持推理等级时改为手动填写。
      if (catalogFailed || provider === '' || model === '' || efforts === undefined || efforts.length === 0) {
        return h(TextField, {
          label: t(prefix === 'review' ? 'model.reviewEffort' : 'model.mergeEffort'),
          value: effort, overridden, writable,
          set: (next) => set(effortKey, next), unset: () => unset(effortKey),
          placeholder: t('model.effortDefault'),
          hint: provider === '' || model === ''
            ? t('model.effortFollowHint')
            : t('model.effortMissingHint'),
        })
      }
      const effortKnown = effort === '' || efforts.some((e) => e.id === effort)
      return h(FieldShell, {
        label: t(prefix === 'review' ? 'model.reviewEffort' : 'model.mergeEffort'),
        overridden,
        onReset: () => unset(effortKey),
        hint: t(prefix === 'review' ? 'model.reviewEffortHint' : 'model.mergeEffortHint'),
      },
        h('select', {
          style: selectStyle,
          value: effort,
          disabled: !writable,
          onChange: (event) => {
            if (event.target.value === '') unset(effortKey)
            else set(effortKey, event.target.value)
          },
        },
          h('option', { value: '' }, t('model.effortDefault')),
          efforts.map((e) => h('option', { key: e.id, value: e.id }, e.name)),
          !effortKnown && h('option', { value: effort }, effort + t('model.currentEffort')),
        ),
      )
    }

    /** 用失焦提交，避免用户还在输入时就改写设置。清空后恢复默认值。 */
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

    /** 数字输入控件，配合 min 和 max 限制取值范围。失焦时提交，清空后恢复默认值。 */
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
     * 插件配置页，包含摘要视图和设置表单。
     */
    function HumanizeCard(props) {
      if (typeof props.t === 'function') t = props.t
      const { form, view, modelCatalog } = props
      const [groups, setGroups] = useState(null)
      const [catalogFailed, setCatalogFailed] = useState(false)
      useEffect(() => {
        // 目录服务不可用时降级为手动填写。
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

      if (view === 'summary') return h('p', { style: hintStyle }, t('settings.summary'))

      const snapshot = form?.state
      if (snapshot === undefined) return h('p', { style: hintStyle }, t('settings.unavailable'))
      if (snapshot.status === 'loading') return h('p', { style: hintStyle }, t('settings.loading'))
      if (snapshot.status !== 'ready') return h('p', { style: hintStyle }, t('settings.unavailable'))
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
        h(ModelPicker, { prefix: 'review', value, user, writable, groups, catalogFailed, set, unset }),
        h(EffortPicker, { prefix: 'review', value, user, writable, groups, catalogFailed, set, unset }),
        h(ModelTest, { prefix: 'review', value, writable }),
        h(ModelPicker, { prefix: 'merge', value, user, writable, groups, catalogFailed, set, unset }),
        h(EffortPicker, { prefix: 'merge', value, user, writable, groups, catalogFailed, set, unset }),
        h(ModelTest, { prefix: 'merge', value, writable }),
        h(NumberField, {
          label: t('settings.reviewConcurrency'),
          value: value.reviewConcurrency ?? FIELD_DEFAULTS.reviewConcurrency,
          overridden: Object.prototype.hasOwnProperty.call(user, 'reviewConcurrency'),
          writable,
          min: FIELD_LIMITS.reviewConcurrency.min,
          set: (next) => set('reviewConcurrency', next),
          unset: () => unset('reviewConcurrency'),
          hint: t('settings.reviewConcurrencyHint'),
        }),
        h(NumberField, {
          label: t('settings.reviewRetries'),
          value: value.reviewRetries ?? FIELD_DEFAULTS.reviewRetries,
          overridden: Object.prototype.hasOwnProperty.call(user, 'reviewRetries'),
          writable,
          min: FIELD_LIMITS.reviewRetries.min,
          max: FIELD_LIMITS.reviewRetries.max,
          set: (next) => set('reviewRetries', next),
          unset: () => unset('reviewRetries'),
          hint: t('settings.reviewRetriesHint'),
        }),
        h(NumberField, {
          label: t('settings.loopMaxRounds'),
          value: value.loopMaxRounds ?? FIELD_DEFAULTS.loopMaxRounds,
          overridden: Object.prototype.hasOwnProperty.call(user, 'loopMaxRounds'),
          writable,
          min: FIELD_LIMITS.loopMaxRounds.min,
          max: FIELD_LIMITS.loopMaxRounds.max,
          set: (next) => set('loopMaxRounds', next),
          unset: () => unset('loopMaxRounds'),
          hint: t('settings.loopMaxRoundsHint'),
        }),
        h(BoolField, {
          label: t('settings.mergeOnCompaction'),
          value: value.mergeOnCompaction,
          overridden: Object.prototype.hasOwnProperty.call(user, 'mergeOnCompaction'),
          writable,
          set: (next) => set('mergeOnCompaction', next),
          unset: () => unset('mergeOnCompaction'),
          hint: t('settings.mergeOnCompactionHint'),
        }),
        h(TextField, {
          label: t('settings.storageDir'),
          value: value.storageDir,
          overridden: Object.prototype.hasOwnProperty.call(user, 'storageDir'),
          writable,
          set: (next) => set('storageDir', next),
          unset: () => unset('storageDir'),
          placeholder: t('settings.storagePlaceholder'),
          hint: t('settings.storageHint'),
        }),
        h(StoragePaths, { storageDir: value.storageDir }),
      )
    }

    /**
     * 渲染期错误边界。插槽条目渲染抛错时会被静默摘除，插槽位置会变成空白。
     * 这里把异常显示成文字，方便直接看到渲染失败的原因。
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
          const tr = typeof this.props.t === 'function' ? this.props.t : t
          return h('p', { style: hintStyle }, tr('settings.renderError') + String(this.state.error?.message ?? this.state.error))
        }
        return this.props.children
      }
    }

    /** 插件行配置页的入口组件。 */
    function RowCard(props) {
      return h(DiagBoundary, { t: props.t }, h(HumanizeCard, props))
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
        return h('p', { style: hintStyle }, (props.t ?? ((key) => key))('settings.readError') + String(error?.message ?? error))
      }
      return h(DiagBoundary, { t: props.t },
        h(HumanizeCard, { view: 'page', form: { state, mutate }, modelCatalog, t: props.t }))
    }

    module.exports.RowCard = RowCard
    module.exports.ConfigSection = ConfigSection
    return module.exports
  },
})
