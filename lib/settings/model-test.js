/**
 * 模型可用性测试。设置页的审查模型和合并模型各有一个测试按钮。点一下会
 * 发一条最小请求，确认提供方、模型和推理等级能正常返回。
 *
 * @module dsh-humanize/settings/model-test
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { clampLine } from '../shared/text.js'

/** 单次测试的总时长上限。模型冷启动或限流时，超时后自动结束。 */
const TEST_TIMEOUT_MS = 30_000
/** 测试只需要确认能返回，回答内容可以很短。 */
const TEST_MAX_TOKENS = 32
/** 错误信息写进界面，这里限制它的长度。 */
const MESSAGE_MAX = 2_000

/** 只有字符串才当作用户输入，其余类型一律当作空字符串。 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把中止归因为超时或被取消。发生中止时返回对应的失败原因，否则返回 undefined。
 * @param {import('@deepseek-ai/dsh-timeout').Deadline} d
 * @returns {{ ok: false, code: 'timeout' | 'aborted', message?: string } | undefined}
 */
function abortOutcome(d) {
  if (timeoutOf(d.signal, 'HUMANIZE_MODEL_TEST') !== undefined) return { ok: false, code: 'timeout' }
  // 本地计时器没触发，signal 却已经中止，说明是浏览器侧取消了这次请求。
  if (d.signal.aborted) return { ok: false, code: 'aborted', message: 'request aborted' }
  return undefined
}

/**
 * 对一个模型发送一条最小请求。
 *
 * 失败时返回 code 字段，取值有 timeout、aborted 和 provider 三种。
 * message 保留原始错误。
 * @param {{ llm: { stream: Function } }} ctx - 至少需要提供 llm 服务。
 * @param {{ provider: string, model: string, reasoningEffort?: string }} target
 * @param {AbortSignal} [outerSignal] - 浏览器请求中止时一并中止这次测试。
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, truncated?: boolean }>}
 */
export async function probeModel(ctx, target, outerSignal) {
  const d = deadline(outerSignal, TEST_TIMEOUT_MS, 'HUMANIZE_MODEL_TEST')
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
      signal: d.signal,
    })
    const assembler = new BlockAssembler()
    for await (const chunk of stream) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error') {
      return { ok: false, code: 'provider', message: clampLine(finish.failure?.message ?? 'provider error', MESSAGE_MAX) }
    }
    if (finish.kind === 'aborted') {
      // 提供方自己中止流时也按取消处理。
      return abortOutcome(d) ?? { ok: false, code: 'aborted', message: 'request aborted' }
    }
    // max-tokens 说明模型已经正常返回，只是这次测试设置的输出上限很小。
    return finish.kind === 'max-tokens' ? { ok: true, truncated: true } : { ok: true }
  } catch (error) {
    const aborted = abortOutcome(d)
    if (aborted !== undefined) return aborted
    return { ok: false, code: 'provider', message: clampLine(error instanceof Error ? error.message : String(error), MESSAGE_MAX) }
  } finally {
    d[Symbol.dispose]()
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
 * 在 Web 宿主上注册测试路由。端口和现有设置页保持一致。
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
