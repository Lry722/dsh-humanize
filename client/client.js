/**
 * dsh-humanize 浏览器端入口，只做懒加载和插槽注册。
 */
window.__ModuleLoader__.load({
  id: 'dsh-humanize',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { Suspense, lazy } = React

    /** NS 是设置命名空间。同一个字符串也用作宿主条目的 id 和 Plugins 页面里本插件行的 id。 */
    const NS = 'dsh-humanize'

    // 各 chunk 的 URL 版本号由本文件的元数据算出，改完任何一个 chunk
    // 都要同步改动本文件，浏览器才会加载新的 chunk。

    /** 设置页 chunk 里的行卡片。 */
    const LazyRowCard = lazy(async () => ({ default: (await require.async('./client.settings.js')).RowCard }))
    /** 设置页 chunk 里的配置区。 */
    const LazyConfigSection = lazy(async () => ({ default: (await require.async('./client.settings.js')).ConfigSection }))
    /** 进度条 chunk，只在首次出现审查任务时请求。 */
    const LazyProgressDock = lazy(async () => ({ default: (await require.async('./client.progress.js')).ProgressDock }))

    function apply(ctx) {
      // 进度条依赖 jobs 服务提供的任务清单流，挂在这个 inject 里。
      ctx.inject(['jobs'], (jobCtx) => {
        const jobs = jobCtx.jobs
        jobCtx.slots.inject('conversation.input.dock', () => jobCtx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-humanize-progress',
          order: 30,
        }, (owner) => h(Suspense, { fallback: null },
          h(LazyProgressDock, { jobs, sessionId: String(owner.sessionId) }))))
      })
      // 设置页有两处插槽。一处在包页面上内联，按包名匹配。另一处是
      // 包内那一行点进去打开的设置页，键由包名、井号和行 id 拼成。两处
      // 插槽对应的是同一份设置数据。
      ctx.inject(['configForms'], (formCtx) => {
        // remote 是按命名空间追踪的代理。渲染的时候访问哪个命名空间，
        // 就要在 inject 里声明哪个命名空间。
        formCtx.inject(['remote', 'remote.session'], (remCtx) => {
          const configForms = formCtx.configForms
          const sessionRemote = remCtx.remote.session
          // 按命名空间追踪的代理只能在注入回调里碰。方法在这里先取出来
          // 再往下传，渲染的时候直接调用。
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
