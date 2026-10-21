/**
 * 模型可用性测试。设置页的审查模型和合并模型各有一个测试按钮，点一下
 * 发一条最小请求，确认提供方、模型和推理等级能正常返回。
 *
 * 走 Connection 的受认证 Fetch 路由，不新开公开端口。路由只在 Web 宿主
 * 提供 connection 服务时注册。
 *
 * @module dsh-humanize/model-test
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

/** 单次测试的总时长上限。模型冷启动或限流时不会一直挂着。 */
const TEST_TIMEOUT_MS = 30_000
/** 测试只需要确认能返回，不需要完整回答。 */
const TEST_MAX_TOKENS = 32
/** 错误信息写进界面，截断到可读长度。 */
const MESSAGE_MAX = 2_000

/** 去空白，非字符串时返回空串。 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 截断过长的错误信息。 */
function trimMessage(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length <= MESSAGE_MAX ? oneLine : `${oneLine.slice(0, MESSAGE_MAX - 1)}…`
}

/**
 * 对一个模型发一条最小请求。成功时 ok 为 true；失败时 code 区分超时、
 * 取消和提供方错误，message 保留原始错误。
 * @param {{ llm: { stream: Function } }} ctx - 至少提供 llm 服务。
 * @param {{ provider: string, model: string, reasoningEffort?: string }} target
 * @param {AbortSignal} [outerSignal] - 浏览器请求中止时一并停掉这次测试。
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, truncated?: boolean }>}
 */
export async function probeModel(ctx, target, outerSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), TEST_TIMEOUT_MS)
  const signal = outerSignal === undefined
    ? controller.signal
    : AbortSignal.any([outerSignal, controller.signal])
  try {
    const stream = ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      ...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort } : {}),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Reply with the single word OK.' }],
        // types.d.ts 声明了 humanize 这个来源。
        source: { kind: 'humanize' },
      })],
      maxTokens: TEST_MAX_TOKENS,
      signal,
    })
    const assembler = new BlockAssembler()
    for await (const chunk of stream) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error') {
      return { ok: false, code: 'provider', message: trimMessage(finish.failure?.message ?? 'provider error') }
    }
    if (finish.kind === 'aborted') {
      if (controller.signal.aborted) return { ok: false, code: 'timeout' }
      return { ok: false, code: 'aborted', message: 'request aborted' }
    }
    // max-tokens 说明模型已经正常返回，只是测试给的上限很小。
    return finish.kind === 'max-tokens' ? { ok: true, truncated: true } : { ok: true }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, code: 'timeout' }
    return { ok: false, code: 'provider', message: trimMessage(error instanceof Error ? error.message : String(error)) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 处理设置页的一次测试请求。请求体是 { provider, model, reasoningEffort? }。
 * @returns {Promise<Response>}
 */
async function handleModelTest(ctx, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, code: 'bad-request' }, { status: 400 })
  }
  const provider = textOf(body?.provider)
  const model = textOf(body?.model)
  const reasoningEffort = textOf(body?.reasoningEffort)
  if (provider === '' || model === '') {
    return Response.json({ ok: false, code: 'missing-selection' })
  }
  if (provider.length > 200 || model.length > 200 || reasoningEffort.length > 50) {
    return Response.json({ ok: false, code: 'bad-request' }, { status: 400 })
  }
  const result = await probeModel(ctx, {
    provider,
    model,
    ...(reasoningEffort !== '' ? { reasoningEffort } : {}),
  }, request.signal)
  return Response.json(result)
}

/**
 * 在 Web 宿主上注册测试路由。没有 connection 服务时什么也不做，其他宿主
 * 的设置页不会出现这个按钮。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerModelTest(ctx) {
  ctx.inject(['connection', 'llm'], (cctx) => {
    cctx.effect(() => cctx.connection.fetch.register({
      path: '/api/humanize.model-test',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleModelTest(cctx, request),
    }), 'dsh-humanize: model test route')
  })
}
