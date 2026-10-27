import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-jobs'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** dsh-humanize 产生的合并结果说明和历史重置占位消息。 */
    humanize: { kind: 'humanize' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    humanize: 'humanize'
    'humanize-review': 'humanize-review'
    'humanize-loop': 'humanize-loop'
  }
}
