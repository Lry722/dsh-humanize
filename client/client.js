/**
 * dsh-humanize 浏览器端：在设置页的插件配置区注册本插件的设置卡片。
 *
 * 卡片通过 settings.plugin.item 插槽按命名空间投递，宿主只负责调度，
 * 卡片内容由插件自己绘制。读写走 settingsScope 服务绑定的命名空间，
 * 改动实时生效，不需要重启。
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
      const { scope, value, user, writable, api } = props
      const [groups, setGroups] = useState(null)
      const [failed, setFailed] = useState(false)
      useEffect(() => {
        if (api === null) {
          setFailed(true)
          return
        }
        let alive = true
        api.llm.models({}).then((res) => {
          if (!alive) return
          if (res.result && res.result.ok) setGroups(res.result.value.groups)
          else setFailed(true)
        }, () => { if (alive) setFailed(true) })
        return () => { alive = false }
      }, [])

      if (failed) {
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
        // 换 provider 后旧模型一般不存在于新目录，顺手清掉。
        const nextGroup = groups === null ? undefined : groups.find((g) => g.id === next)
        if (model !== '' && (nextGroup === undefined || !nextGroup.models.some((m) => m.id === model))) {
          scope.unset('reviewModel')
        }
      }
      const pickModel = (next) => {
        if (next === '') scope.unset('reviewModel')
        else void scope.set('reviewModel', next)
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
            scope, api: props.api, value, user,
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

    function apply(ctx) {
      // settingsScope 标识宿主有插件配置页。老宿主没有这个服务时卡片
      // 不出现，条目配置照常生效。
      ctx.inject(['settingsScope'], (scoped) => {
        const scope = scoped.settingsScope.bind({ namespace: NS })
        // 模型目录走 connection 的 api。没有 connection 时卡片仍注册，
        // ModelPicker 加载失败后退化为手填文本框。
        const api = scoped.get('connection') !== undefined ? scoped.get('connection').api : null
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
