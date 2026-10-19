/**
 * dsh-humanize 浏览器端入口，负责插槽装配。
 *
 * 设置卡片和进度条各自是独立的懒加载 chunk，分别在
 * client.settings.js 和 client.progress.js。设置卡片覆盖审查模型、
 * 并发、重试、轮次上限、压缩合并和储存位置。本文件只做
 * require.async 懒加载和插槽注册。chunk 的 URL 版本号由本文件的
 * 元数据算出，改完任何一个 chunk 都要同步改动本文件，浏览器才会
 * 加载新的 chunk。这个结构和官方
 * dsh-client-ui-sidebar-terminal 的 client.js 加 client.terminal.js
 * 是同一模式。手写为 __ModuleLoader__ 工厂格式，不引入构建步骤。
 * 外部依赖只有模块表里的 react。
 */
window.__ModuleLoader__.load({
  id: 'dsh-humanize',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { Suspense, lazy } = React

    /** 设置命名空间，宿主条目的 id，也是 Plugins 页面里本插件行的 id。 */
    const NS = 'dsh-humanize'

    /** 懒加载设置 chunk，首次渲染设置页时才拉取。 */
    const LazyRowCard = lazy(async () => ({ default: (await require.async('./client.settings.js')).RowCard }))
    const LazyConfigSection = lazy(async () => ({ default: (await require.async('./client.settings.js')).ConfigSection }))
    /** 懒加载进度条 chunk，首次出现审查任务时才拉取。 */
    const LazyProgressDock = lazy(async () => ({ default: (await require.async('./client.progress.js')).ProgressDock }))

    function apply(ctx) {
      // jobs 服务提供任务 roster 流。有 jobs 服务时才注册进度条，
      // 其余功能照常运行。
      ctx.inject(['jobs'], (jobCtx) => {
        const jobs = jobCtx.jobs
        jobCtx.slots.inject('conversation.input.dock', () => jobCtx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-humanize-progress',
          order: 30,
        }, (owner) => h(Suspense, { fallback: null },
          h(LazyProgressDock, { jobs, sessionId: String(owner.sessionId) }))))
      })
      // 设置页有两处插槽。一处在包页面上内联，按包名匹配。另一处在
      // 包内那一行点进去的配置页，按“包名#行 id”匹配。两者写同一份设置。
      ctx.inject(['configForms'], (formCtx) => {
        // remote 是按命名空间追踪的代理，访问 remote.session 这一跳必须在
        // inject 里声明 "remote.session"。只声明 "remote" 的话，渲染期会抛
        // cannot get property "remote.session" without inject。取好的方法
        // 往下传，渲染期不碰代理。
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
