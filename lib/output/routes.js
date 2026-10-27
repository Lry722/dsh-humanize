/**
 * 最终回复输出的会话级只读查询路由。
 *
 * 浏览器只能提供 sessionId。正文仍由 GUI 已有的授权文件预览读取，
 * 这里只返回输出链路自己记录的元数据，读取的具体文件由 sessionId 决定。
 *
 * @module dsh-humanize/output/routes
 */

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * 注册认证 Connection 内的 GET 路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ readOutput: (sessionId: string) => Promise<object> }} outputs
 */
export function registerTurnOutputInfo(ctx, outputs) {
  ctx.inject(['connection'], (cctx) => {
    cctx.effect(() => cctx.connection.fetch.register({
      path: '/api/humanize.turn-output',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url)
        const names = [...url.searchParams.keys()]
        const sessionIds = url.searchParams.getAll('sessionId')
        if (names.some((name) => name !== 'sessionId') || sessionIds.length !== 1) {
          return json({ error: 'Expected exactly one sessionId and no other parameters.' }, 400)
        }
        const sessionId = sessionIds[0]
        if (sessionId.length === 0 || sessionId.length > 256 || /[\x00-\x1F\x7F]/.test(sessionId)) {
          return json({ error: 'Invalid sessionId.' }, 400)
        }
        try {
          return json(await outputs.readOutput(sessionId))
        } catch {
          return json({ error: 'Output status is unavailable.' }, 500)
        }
      },
    }), 'dsh-humanize: turn output route')
  })
}
