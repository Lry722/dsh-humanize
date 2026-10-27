/**
 * 最终回复输出的会话级查询和手动润色路由。
 *
 * 浏览器只能提供 sessionId，手动触发时另带 turn，不能提供文件路径。
 * 正文仍由 GUI 已有的授权文件预览读取，具体文件由宿主输出记录决定。
 *
 * @module dsh-humanize/output/routes
 */

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

function validSessionId(value) {
  return value.length > 0 && value.length <= 256 && !/[\x00-\x1F\x7F]/.test(value)
}

/**
 * 注册认证 Connection 内的输出路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   readOutput: (sessionId: string) => Promise<object>,
 *   polishOutput: (sessionId: string, turn: number) => Promise<object>,
 * }} outputs
 */
export function registerTurnOutputInfo(ctx, outputs) {
  ctx.inject(['connection'], (cctx) => {
    cctx.effect(() => cctx.connection.fetch.register({
      path: '/api/humanize.turn-output',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url)
        const polishing = request.method === 'POST'
        const names = [...url.searchParams.keys()]
        const sessionIds = url.searchParams.getAll('sessionId')
        const invalidName = names.some((name) => name !== 'sessionId' && (!polishing || name !== 'turn'))
        if (invalidName || sessionIds.length !== 1 || (polishing && !names.includes('turn'))) {
          return json({ error: 'Expected sessionId, a turn for POST, and no other parameters.' }, 400)
        }
        const sessionId = sessionIds[0]
        if (!validSessionId(sessionId)) return json({ error: 'Invalid sessionId.' }, 400)
        let turn
        if (polishing) {
          const turns = url.searchParams.getAll('turn')
          turn = Number(turns[0])
          if (turns.length !== 1 || !/^[1-9]\d*$/.test(turns[0]) || !Number.isSafeInteger(turn)) {
            return json({ error: 'Invalid turn.' }, 400)
          }
        }
        try {
          const result = polishing
            ? await outputs.polishOutput(sessionId, turn)
            : await outputs.readOutput(sessionId)
          return json(result)
        } catch {
          return json({ error: polishing ? 'Output polishing is unavailable.' : 'Output status is unavailable.' }, 500)
        }
      },
    }), 'dsh-humanize: turn output route')
  })
}
