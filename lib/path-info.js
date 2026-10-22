/**
 * 设置页展示的保存位置。浏览器拿不到宿主机的临时目录和用户目录，
 * 由这条路由把真实路径发给设置页。
 *
 * @module dsh-humanize/path-info
 */
import { requestRoot, stagingRoot } from './staging.js'

/**
 * 返回设置页展示的两条路径，每次调用都按当前设置重新计算。
 */
export function humanizePaths() {
  return {
    staging: stagingRoot(),
    requests: requestRoot(),
  }
}

/** 处理设置页的路径查询。 */
function handlePaths() {
  return Response.json(humanizePaths(), {
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * 在 Web 宿主上注册路径查询路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerPathInfo(ctx) {
  ctx.inject(['connection'], (cctx) => {
    cctx.effect(() => cctx.connection.fetch.register({
      path: '/api/humanize.paths',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => handlePaths(),
    }), 'dsh-humanize: path info route')
  })
}
