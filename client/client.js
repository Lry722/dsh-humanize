/**
 * dsh-humanize 浏览器端入口，只做懒加载和插槽注册。
 *
 * 各 chunk 的 URL 版本号由本文件的元数据算出。改完 chunk 后跑
 * `npm run stamp:client` 更新下面的 `// chunks:` 标记。
 *
 * 2026-10-21：设置页新增合并子代理的模型与推理等级选择。
 * 2026-10-21：进度条纳入单次合并与压缩触发的合并任务。
 */
// chunks: 8eb19607
window.__ModuleLoader__.load({
  id: 'dsh-humanize',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { Suspense, lazy } = React

    // NS 是设置项的命名空间标识。
    // 同一个字符串还用作宿主条目的 id，以及 Plugins 页面里本插件行的 id。
    const NS = 'dsh-humanize'


    const LazyRowCard = lazy(async () => ({ default: (await require.async('./client.settings.js')).RowCard }))
    const LazyConfigSection = lazy(async () => ({ default: (await require.async('./client.settings.js')).ConfigSection }))
    /** 进度条 chunk，只在首次出现审查任务时请求。 */
    const LazyProgressDock = lazy(async () => ({ default: (await require.async('./client.progress.js')).ProgressDock }))

    function apply(ctx) {
      void (async () => {
        // 文案表放在独立 chunk 里，加载完再注册 locale 和插槽。
        const { dictionaries } = await require.async('./client.locales.js')
        // 逐语言注册，新增语言时只要在 locales chunk 里加一份字典，
        // 这里不用假设只有 en/zh。
        ctx.effect(() => {
          const disposers = Object.entries(dictionaries)
            .map(([locale, dict]) => ctx.locale.register(NS, locale, dict))
          return () => { for (const dispose of disposers) dispose() }
        }, 'dsh-humanize: locale')
        // 进度条依赖 jobs 服务提供的任务清单流，挂在这个 inject 里。
        ctx.inject(['jobs'], (jobCtx) => {
          const jobs = jobCtx.jobs
          jobCtx.slots.inject('conversation.input.dock', () => jobCtx.slots.register({
            name: 'conversation.input.dock',
            id: 'dsh-humanize-progress',
            order: 30,
            locale: NS,
          }, (owner) => h(Suspense, { fallback: null },
            h(LazyProgressDock, { jobs, sessionId: String(owner.sessionId), t: owner.t }))))
        })
        ctx.inject(['configForms'], (formCtx) => {
          // remote 是按命名空间追踪的代理。渲染的时候访问哪个命名空间，
          // 就要在 inject 里声明哪个命名空间。
          formCtx.inject(['remote', 'remote.session'], (remCtx) => {
            const configForms = formCtx.configForms
            const sessionRemote = remCtx.remote.session
            const modelCatalog = typeof sessionRemote?.modelCatalog === 'function'
              ? sessionRemote.modelCatalog.bind(sessionRemote)
              : undefined
            formCtx.effect(() => configForms.whileServed([NS], () => {
              // 第一处设置插槽，内嵌在 Plugins 页面中。
              const bundle = formCtx.slots.register({
                name: 'plugins.bundle.config',
                key: NS,
                locale: NS,
              }, (props) => h(Suspense, { fallback: null },
                h(LazyConfigSection, { configForms, modelCatalog, t: props.t })))
              // 第二处设置插槽，包列表里点进去打开的设置页。键由包名、井号和行 id 拼成。
              const row = formCtx.slots.register({
                name: 'plugins.row.config',
                key: `${NS}#${NS}`,
                locale: NS,
              }, (props) => h(Suspense, { fallback: null },
                h(LazyRowCard, { view: props.view, form: props.form, modelCatalog, t: props.t })))
              return () => {
                bundle()
                row()
              }
            }), 'dsh-humanize: settings page')
          })
        })
      })().catch((error) => {
        console.error('dsh-humanize: failed to load locale dictionaries', error)
      })
    }

    exports.name = 'dsh-humanize'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
