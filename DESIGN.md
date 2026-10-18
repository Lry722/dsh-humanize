# dsh-humanize 实现方案

本文档记录 dsh-humanize 的整体设计，基于 @deepseek-ai/dsh 0.1.0-rc.7。

## 插件形态

DSH 插件是一个 npm 包。包内的 package.json 声明补丁文件的位置，补丁文件负责把插件挂进配置树。插件入口导出一个 apply 函数，通过 ctx 使用平台服务。

本地开发时用 dsh plugin 命令以 link 方式装载。

```sh
dsh plugin --profile web add link:/home/lry722/dev/dsh-humanize
```

link 装载本身不会热重载宿主插件：插件 link 在 profile 的 node_modules 下，而 dsh-hmr 的默认 ignore 排除 `**/node_modules`，shipped 的 web 组合又把 hmr 的 root 设为空。改完 lib 下的源码后，运行进程仍会用 ESM 缓存里的旧模块。插件管理器的 disable/enable 也不会重新导入。开发时需要在 profile 的 cordis.patch.yml 里把插件目录纳入 hmr 监听：

```yaml
- id: hmr
  name: "@deepseek-ai/dsh-hmr"
  config:
    root:
      - /home/lry722/dev/dsh-humanize
    ignored:
      - "**/node_modules"
      - "**/.git/**"
```

hmr 检测到改动后，会把该插件的全部依赖加入重载集合、逐个清掉 ESM 与 CJS 缓存再重新导入，因此改 lib 下任意一个文件都会整图重载。浏览器端 client/ 下的改动仍需刷新页面。没有 dev:web watcher 时改动需手动重建。

## 整体流程

整体流程分四步。

第一步，标记写入。插件给每个 agent 提供包装过的写入和编辑工具。包装工具比原工具多一个必填参数 human_facing。模型每次写文件都要声明内容是否面向人类。true 表示内容要给人看，比如文档和注释。false 表示纯代码或数据。只有标记为 true 的写入会进入审查。

第二步，准备规范。插件按被写文件所在的目录收集规范。先读用户全局的 PROSE.md，再从项目根目录向下逐级读取 PROSE.md，范围越小的规则优先级越高。规范内容有缓存，文件没变就不重复读取。

第三步，旁路审查。写入触发时，插件从原工具返回的写入前后内容算出改动区段，两侧各带三行上下文，只把改动区段和规范发给一次独立的模型调用。新建文件和 /humanize-review 的全量审查发送全文。调用要求模型对照规范逐条批注，输出结构化的审查结果。审查用哪个模型由插件配置决定，可以选比主模型便宜的模型。审查在后台进行，失败只记录日志，不影响主任务。

第四步，延迟合并。批注先暂存到文件里，对同一文件再次审查时，基于已有批注修改。合并有两个触发时机。用户输入 /humanize 命令时，按命令指定的范围合并。会话发生上下文压缩时，合并整个项目的全部暂存批注。插件把规范和批注发给主模型完成编辑，并避免处理过程占用会话上下文。

## 平台机制对照

### 标记旁路

平台允许给单个 agent 注册同名工具，遮蔽同名的全局工具。插件在 agent 创建时，把包装过的 write 和 edit 注册进 agent 专属上下文。包装工具保留原工具的 schema 和执行逻辑，只增加 human_facing 参数。执行时先去掉这个参数，再调用原工具完成写入。

agent 覆盖是完整的。新建会话、恢复会话和子 agent 最终都走同一个发布序列，都会发出 agent/created 通知。插件收到通知后注册包装工具。插件加载时已经在运行的 agent，遍历 agent 注册表补注册即可，从下一个请求开始生效。

原工具的参数 schema 是开放的，会忽略多余的字段。human_facing 由包装工具声明为必填，模型必须提供。

code mode 的 SDK 按 agent 可见的工具生成，包装工具自然包含 human_facing。直接调用和代码调用行为一致。

### 规范加载

dsh-agent-instructions 实现了 AGENTS.md 的分层加载，PROSE.md 照搬这套思路。两者的差别是加载基准不同。AGENTS.md 按会话工作目录加载一次，PROSE.md 每次按被写文件所在目录加载。

### 审查调用

ctx.llm.stream 发起独立的模型调用。调用参数里有一个可选的 purpose 字段，只接受 compaction 和 session-title 两个值，作用是让适配器对辅助调用采用不同的传输策略。审查调用两种都不是，留空即可。平台会把这类调用和主任务的请求区分开记录。

### 批注暂存

暂存为 markdown 文件，放在用户数据目录下，支持用户自行增改。

### 触发时机

#### 斜杠命令触发

注册 `/humanize PATH` 命令。

PATH 是文件时合并这一个文件，是目录时合并目录下所有有批注的文件。

合并完成后清空对应的暂存批注。

#### 主动审查

注册 `/humanize-review PATH` 命令，立即触发对一个 PATH 的完整审查。

PATH 是文件时审查这一个文件，是目录时递归展开。两种情况下都只审查受 git 管理且路径命中规范链 include 模式的文件。各级的声明合并生效，范围越小的优先级越高。

审查在后台进行。

批次注册成 kind 为 humanize-review 的后台任务（ctx.jobs）。进度行进任务 roster，由 job-controller 实时推到浏览器。客户端渲染成输入框上方的进度条，会话头部的任务列表也会显示并允许取消。

并行批次大小由 reviewConcurrency 控制，缺省为 3。不设上限，实际并发不超过待审文件数。批次同时在途审查多个文件，用滚动窗口推进。每批取队列头部最多 N 个，失败的文件插回队首，和还没处理过的文件凑成下一批。例如队列有 A B C D E 五个文件，三并发时，A 失败后第二批是 A D E。单个文件最多尝试 1 + reviewRetries 次（缺省 1），额度用尽才计入最终失败。

终态说明列出仍然失败的文件和原因，仅用于界面展示。批次全程等待用户处理，避免完成通知打扰主会话。结算记录在任务列表停留几秒后由插件摘掉。

同一个 agent 同时只允许一个审查批次，批注合并进行中时拒绝派发。

PROSE.md 的文件头是一个可选的 YAML 块，include 声明审查范围，语法参考 .gitignore：

```markdown
---
include:
  - '*.md'
  - 'docs/**/*.txt'
  - '!drafts/'
---
```

不含 `/` 的模式匹配任意层级的文件名，含 `/` 的按声明文件所在目录锚定，`!` 前缀表示排除，结尾 `/` 匹配该目录下所有文件，`*` 不跨目录，`**` 跨目录。判定按规范链范围从小到大依次套用各条模式，最后一次命中的结果生效。

#### 压缩前触发

上下文压缩结束时，会话日志会出现 compaction/end 事件，插件订阅 session/event 就能拿到。

支持设置是否开启该功能。关闭时只在手动执行 /humanize 命令时合并。

## 设置页

0.2.0 的 dsh-settings 没有命令式的 register(ns, schema)。插件导出 Config 声明设置，设置页只暴露标了 `volatile()` 的节点，命名空间是条目在补丁里声明的 id（dsh-humanize）。运行时该节点交给插件的是一个带 `get()` 的引用，读取时要解引用。插件用访问器在使用时实时读，设置页改动直接生效。

浏览器端注册进 `plugins.row.config`，key 是 `<包名>#<行 id>`，用 `configForms.whileServed(['dsh-humanize'], ...)` 保证宿主真的服务这个命名空间时才出现。页面把 `{ view, form }` 交给组件：`view: 'summary'` 渲染行内说明，`view: 'page'` 渲染表单。读取走 `form.state`（value/base/user/revision/writable），写入是一次原子 `form.mutate(ops, revision)`，path 以 volatile 节点名开头。插件自带页面时声明 `settings.configure({ auto: false })`。

## 代码布局

宿主端（lib/）按流程步骤分模块，index.js 只做组合：

- `lib/index.js` — 组合根：读设置、装包装工具、接管线和命令。
- `lib/wrap.js` — 标记写入：包装 write/edit，增加必填 human_facing。
- `lib/specs.js` — PROSE.md 分层规范加载、渲染与 include 模式匹配。
- `lib/pipeline.js` — 审查管线：跨模块共享状态（合并锁、审查锁、每文件串行队列）与单次审查的编排。
- `lib/review.js` — 旁路审查调用与双看门狗（空闲两分钟、总时长十分钟）。
- `lib/annotations.js` — 批注解析与暂存 markdown 渲染。
- `lib/review-run.js` — /humanize-review 批次：滚动窗口并发、失败重试、jobs 进度上报，jobs 不可用时静默降级。批次全程挂一个 jobs.wait，让结算被记为 awaited，抑制 dsh-tool-jobs 的完成通知。结算依赖这个 wait，它挂的 signal 提前终止会让结算失效。注册表在 done 的微任务里结算，abort 抢跑会把 wait 移出等待集合，awaited 失效，通知照样漏进主会话。
- `lib/merge.js` — /humanize 合并与 compaction/end 自动合并、合并上下文遮蔽。
- `lib/staging.js`、`lib/diff.js`、`lib/prompts.js` — 暂存读写、改动区段、提示词资源。

浏览器端（client/）拆为主入口加两个懒加载 chunk，与官方 dsh-client-ui-sidebar-terminal 的 client.js + client.terminal.js 同一模式：主入口只做 `require.async` 懒加载和插槽注册，chunk 用同样的 `__ModuleLoader__.load` 工厂格式注册，多一个 chunk 字段：

- `client/client.js` — 入口：React.lazy 包 chunk，注册 conversation.input.dock 与两处设置座位。
- `client/client.settings.js` — 设置卡片：通用表单控件与业务字段。
- `client/client.progress.js` — 输入框上方的审查进度条。

## 服务速查

| 能力           | 入口                       | 所属包         |
| -------------- | -------------------------- | -------------- |
| 工具注册与遮蔽 | ctx.tools.register 方法    | dsh-tools      |
| agent 创建通知 | agent/created 事件         | dsh-agent      |
| 会话事件       | session/event 事件         | dsh-session    |
| 主任务通知     | agent.inject 方法          | dsh-agent      |
| 审查调用       | ctx.llm.stream 方法        | dsh-llm        |
| 斜杠命令       | ctx.commands.register 方法 | dsh-commands   |
| 压缩时机       | compaction/end 事件        | dsh-compaction |
| 文件读写       | ctx.fs 服务                | dsh-fs         |
| 设置读写       | ctx.configForms 服务       | dsh-client-ui-settings |
| 任务进度       | ctx.jobs.start 方法        | dsh-jobs       |

## 遗留事项

维护成本。官方 write 和 edit 升级时，包装工具要跟着检查一遍。

绕过通道。模型用 bash 写文件会绕过写入工具，因此没有标记。这是可接受的盲区。
