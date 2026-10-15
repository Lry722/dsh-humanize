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
    const { useEffect, useState, useSyncExternalStore } = React

    const NS = 'dsh-humanize'

    const cardStyle = {
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '12px',
      padding: '0 16px',
    }
    const headStyle = { padding: '14px 0' }
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

    /** 字段被用户覆盖时给出恢复缺省的入口，清除后落回 base 层。 */
    function ResetButton(props) {
      if (!props.overridden) return null
      return h('button', { type: 'button', style: resetStyle, onClick: props.onReset }, '恢复缺省')
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

    /** 数字字段。输入不是正整数时不提交，保持原值。 */
    function NumberField(props) {
      const [text, setText] = useState(String(props.value ?? ''))
      useEffect(() => setText(String(props.value ?? '')), [props.value])
      const commit = () => {
        const parsed = Number.parseInt(text, 10)
        if (Number.isNaN(parsed) || parsed <= 0) {
          setText(String(props.value ?? ''))
          return
        }
        if (parsed === props.value) return
        void props.scope.set(props.field, parsed)
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
          inputMode: 'numeric',
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

    function HumanizeCard(props) {
      const scope = props.scope
      const snapshot = useSyncExternalStore(scope.subscribe, scope.getSnapshot)
      if (snapshot.status !== 'ready' || snapshot.value === undefined) return null
      const value = snapshot.value
      const user = snapshot.user ?? {}
      const overridden = (field) => Object.prototype.hasOwnProperty.call(user, field)
      return h('div', { style: cardStyle },
        h('div', { style: headStyle },
          h('h3', { style: titleStyle }, 'dsh-humanize'),
          h('p', { style: descStyle }, '写入内容的行文审查。修改实时生效。'),
        ),
        h(TextField, {
          scope, label: '审查模型 provider', field: 'reviewProvider',
          value: value.reviewProvider, overridden: overridden('reviewProvider'),
          writable: snapshot.writable, placeholder: '跟随会话当前模型',
          hint: '审查用的模型 provider。留空时跟随会话当前使用的模型。',
        }),
        h(TextField, {
          scope, label: '审查模型', field: 'reviewModel',
          value: value.reviewModel, overridden: overridden('reviewModel'),
          writable: snapshot.writable, placeholder: '跟随会话当前模型',
          hint: '审查用的模型，可以选比主模型便宜的模型。留空时跟随会话当前使用的模型。',
        }),
        h(NumberField, {
          scope, label: '审查输出上限', field: 'reviewMaxTokens',
          value: value.reviewMaxTokens, overridden: overridden('reviewMaxTokens'),
          writable: snapshot.writable,
          hint: '审查调用的输出 token 上限，缺省 4096。',
        }),
        h(BoolField, {
          scope, label: '上下文压缩时自动合并', field: 'mergeOnCompaction',
          value: value.mergeOnCompaction, overridden: overridden('mergeOnCompaction'),
          writable: snapshot.writable,
          hint: '压缩结束时自动合并整个项目的暂存批注。关闭后只在手动执行 /humanize 时合并。',
        }),
      )
    }

    function apply(ctx) {
      // settingsScope 标识宿主有插件配置页。老宿主没有这个服务时卡片
      // 不出现，条目配置照常生效。
      ctx.inject(['settingsScope'], (scoped) => {
        const scope = scoped.settingsScope.bind({ namespace: NS })
        scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
          name: 'settings.plugin.item',
          key: NS,
        }, () => h(HumanizeCard, { scope })))
      })
    }

    exports.name = 'dsh-humanize'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
