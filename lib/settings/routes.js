/**
 * 设置页用到的两条查询路由：字段元数据和保存位置。
 *
 * 设置字段的默认值和边界由同目录 schema.js 的字段表定义。字段路由把
 * 设置页需要的元数据发给浏览器，避免两边各抄一份。
 *
 * 浏览器拿不到宿主机的临时目录和用户目录，路径路由把暂存批注、批注历史
 * 和审查请求记录的真实路径发给设置页。
 *
 * @module dsh-humanize/settings/routes
 */
import { SETTINGS_FIELDS } from './schema.js'
import { historyRoot, requestRoot, stagingRoot } from '../shared/staging.js'

/**
 * 返回字段名到元数据的映射，每次调用都按当前字段表生成。
 *
 * 只保留设置页用得上的类型、默认值和边界，描述等其余信息留在字段表里，
 * 返回值可以直接 JSON 序列化。
 */
export function humanizeFields() {
  const fields = {}
  for (const [key, field] of Object.entries(SETTINGS_FIELDS)) {
    const info = { type: field.type, default: field.default }
    if (field.min !== undefined) info.min = field.min
    if (field.max !== undefined) info.max = field.max
    if (field.integer === true) info.integer = true
    fields[key] = info
  }
  return fields
}

/**
 * 返回设置页展示的三条路径，每次调用都按当前设置重新计算。
 */
export function humanizePaths() {
  return {
    staging: stagingRoot(),
    history: historyRoot(),
    requests: requestRoot(),
  }
}

/** 处理设置页的字段元数据查询。 */
function handleFields() {
  return Response.json({ fields: humanizeFields() }, {
    headers: { 'cache-control': 'no-store' },
  })
}

/** 处理设置页的路径查询。 */
function handlePaths() {
  return Response.json(humanizePaths(), {
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * 在 Web 宿主上注册一条只读的 GET 路由，响应不进缓存。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} path
 * @param {() => Response} fetch
 * @param {string} label
 */
function registerGet(ctx, path, fetch, label) {
  ctx.inject(['connection'], (cctx) => {
    cctx.effect(() => cctx.connection.fetch.register({
      path,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch,
    }), label)
  })
}

/**
 * 在 Web 宿主上注册字段元数据路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerFieldsInfo(ctx) {
  registerGet(ctx, '/api/humanize.fields', () => handleFields(), 'dsh-humanize: field info route')
}

/**
 * 在 Web 宿主上注册路径查询路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerPathInfo(ctx) {
  registerGet(ctx, '/api/humanize.paths', () => handlePaths(), 'dsh-humanize: path info route')
}
