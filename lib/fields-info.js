/**
 * 设置字段的默认值和边界由 lib/settings.js 的字段表定义。这条路由把
 * 设置页需要的元数据发给浏览器，避免两边各抄一份。
 *
 * @module dsh-humanize/fields-info
 */
import { SETTINGS_FIELDS } from './settings.js'

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

/** 处理设置页的字段元数据查询。 */
function handleFields() {
  return Response.json({ fields: humanizeFields() }, {
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * 在 Web 宿主上注册字段元数据路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerFieldsInfo(ctx) {
  ctx.inject(['connection'], (cctx) => {
    cctx.effect(() => cctx.connection.fetch.register({
      path: '/api/humanize.fields',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => handleFields(),
    }), 'dsh-humanize: field info route')
  })
}
