/**
 * dsh-humanize 浏览器端入口：插槽装配。
 *
 * 设置卡片和进度条各拆成独立的懒加载 chunk（client.settings.js、
 * client.progress.js），本文件只做 require.async 懒加载和插槽注册，
 * 与官方 dsh-client-ui-sidebar-terminal 的 client.js + client.terminal.js
 * 同一模式。手写为 __ModuleLoader__ 工厂格式，不引入构建步骤。唯一的
 * 外部依赖是模块表里的 react。
 */
window.__ModuleLoader__.load({
  id: 'dsh-humanize',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { Suspense, lazy } = React

    /** 设置命名空间：宿主条目的 id，也是 Plugins 页面里本插件行的 id。 */
    const NS = 'dsh-humanize'

    /** 懒加载设置 chunk，首次渲染设置页时才拉取。 */
    const LazyRowCard = lazy(async () => ({ default: (await require.async('./client.settings.js')).RowCard }))
    const LazyConfigSection = lazy(async () => ({ default: (await require.async('./client.settings.js')).ConfigSection }))
    /** 懒加载进度条 chunk，首次出现审查任务时才拉取。 */
    const LazyProgressDock = lazy(async () => ({ default: (await require.async('./client.progress.js')).ProgressDock }))

    function apply(ctx) {
      // jobs 服务提供任务 roster 流。没有它时进度条不注册，其余功能
      // 照常。
      ctx.inject(['jobs'], (jobCtx) => {
        const jobs = jobCtx.jobs
        jobCtx.slots.inject('conversation.input.dock', () => jobCtx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-humanize-progress',
          order: 30,
        }, (owner) => h(Suspense, { fallback: null },
          h(LazyProgressDock, { jobs, sessionId: String(owner.sessionId) }))))
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
            }, () => h(Suspense, { fallback: null },
              h(LazyConfigSection, { configForms, modelCatalog })))
            const row = formCtx.slots.register({
              name: 'plugins.row.config',
              key: `${NS}#${NS}`,
            }, (props) => h(Suspense, { fallback: null },
              h(LazyRowCard, { view: props.view, form: props.form, modelCatalog })))
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
