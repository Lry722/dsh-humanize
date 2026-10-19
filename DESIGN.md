# dsh-humanize 实现方案

本文档记录 dsh-humanize 的整体设计，基于 @deepseek-ai/dsh 0.1.0-rc.7。

## 插件形态

DSH 插件是一个 npm 包。包内的 package.json 声明补丁文件的位置，补丁文件负责把插件挂进配置树。插件入口导出一个 apply 函数，通过 ctx 使用平台服务。

本地开发时用 dsh plugin 命令以 link 方式装载。

```sh
dsh plugin --profile web add link:/home/lry722/dev/dsh-humanize
```

link 装载本身不会热重载宿主插件。插件 link 落在 profile 的 node_modules 下，dsh-hmr 的默认 ignore 排除了这个目录，web 组合又把 hmr 的 root 设为空。改完 lib 下的源码后，运行进程仍会用 ESM 缓存里的旧模块。插件管理器的 disable/enable 也不会重新导入。开发时需要在 profile 的 cordis.patch.yml 里把插件目录纳入 hmr 监听：

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

第二步，准备规范。插件按被写文件所在的目录收集规范。先读用户全局的 PROSE.md，再从项目根目录向下逐级读取 PROSE.md，范围越小的规则优先级越高。规范内容有缓存，文件没变时直接复用缓存。

第三步，旁路审查。写入触发时，插件从原工具返回的写入前后内容算出改动区段，只把改动区段和规范发给模型。新建文件时，以及 /humanize-review 触发的全量审查，都把全文发给模型。

审查通过一次独立的模型调用进行，调用要求模型对照规范逐条批注。审查结果通过 submit_annotations 工具提交，字段结构由工具的 schema 约束。审查用哪个模型由插件配置决定，可以选择成本更低的模型。

审查在后台进行，失败只记录日志，主任务照常推进。

第四步，延迟合并。批注先暂存到文件里，对同一文件再次审查时，在已有批注的基础上更新批注内容。

合并有三个触发时机。

- 用户输入 /humanize 命令时，按命令指定的范围合并。
- 用户输入 /humanize-loop 命令时，循环执行合并和复审，直到复审结果收敛或达到轮次上限。
- 会话发生上下文压缩时，合并会话工作目录下的全部暂存批注。

轮次上限在设置页调整。

合并在独立的子代理里执行。插件把规范和批注组装成一条自包含的消息，派发一个合并子代理完成修订。

修订只带这一条消息，主会话上下文保持隔离。

子代理限定只能用读文件和改文件的工具，模型跟随主会话当前的选择。

子代理出结果后，成功就清空对应暂存批注，失败保留批注，两种结果都在主会话留一行说明。合并成功收尾后对被合并的文件逐个复审，修订引入的新违规会作为新批注回到暂存。

## 平台机制对照

### 标记旁路

平台允许给单个 agent 注册同名工具，遮蔽同名的全局工具。插件在 agent 创建时，把包装过的 write 和 edit 注册进 agent 专属上下文。包装工具保留原工具的 schema 和执行逻辑，只增加 human_facing 参数。执行时先去掉这个参数，再调用原工具完成写入。

agent 覆盖是完整的。新建会话、恢复会话和子代理最终都走同一个发布序列，都会发出 agent/created 通知。插件收到通知后注册包装工具。插件加载时已经在运行的 agent，遍历 agent 注册表补注册，从下一个请求开始生效。

原工具的参数 schema 是开放的，会忽略多余的字段。human_facing 由包装工具声明为必填，模型必须提供。

code mode 的 SDK 按 agent 可见的工具生成，生成的工具列表包含 human_facing。直接调用和代码调用行为一致。

### 规范加载

dsh-agent-instructions 实现了 AGENTS.md 的分层加载，PROSE.md 照搬这套思路。两者的差别是加载基准不同。AGENTS.md 按会话工作目录加载一次，PROSE.md 每次按被写文件所在目录加载。

### 审查调用

ctx.llm.stream 发起独立的模型调用。写入触发的审查只发送改动区段，区段两侧各带三行上下文。调用参数里有一个可选的 purpose 字段，只接受 compaction 和 session-title 两个值。这个字段的作用是让适配器对辅助调用采用不同的传输策略。审查调用不填这个字段。平台会把这类调用和主任务的请求区分开记录。

插件热重载期间，在途审查照常跑完。这次审查属于无状态的旁路调用。流建立后，审查不再依赖插件上下文，写入暂存文件照常走普通写入路径。

热重载后新旧两个实例可能对同一文件并发审查。审查完成时把被审查文件重读一遍，和本次审查的内容快照比对。内容不一致就按当前内容补一轮复审，复审的区段由快照和当前内容的差异算出。批注最终收敛到最新内容。

### 批注暂存

暂存为 markdown 文件，放在用户数据目录下，支持用户自行增改。

### 触发时机

#### 斜杠命令触发

注册 `/humanize PATH` 命令。

PATH 是文件时合并这一个文件，是目录时合并目录下所有有批注的文件。

/humanize-loop 的循环注册成 kind 为 humanize-loop 的后台任务，进度条显示当前轮次、轮次上限和本轮批注数，可以在任务列表里取消，取消在下一轮开始前生效。

合并子代理的写入跳过审查，直接按批注修订。

识别依据是父会话有在途合并，或落盘的在途合并记录里登记了这个子代理。合并锁在热重载后有一段时间没有恢复，这种识别要覆盖这段窗口。

修订引入的新违规由合并收尾后的复审兜住。

合并等待期间的状态需要落盘，只放内存里会在重载后丢失。派发时把子代理的会话 id 和文件清单落盘，插件加载时对照子代理的状态补做收尾。子代理还在跑就等它回合结束，已经出过结果就直接收尾，子代理离场就放弃收尾。批注保留给下次合并。

#### 主动审查

注册 `/humanize-review PATH` 命令，立即触发对一个 PATH 的全量审查。

PATH 是文件时审查这一个文件，是目录时递归展开。两种情况下都只审查受 git 管理且路径命中规范链 include 模式的文件。各级的声明合并生效，范围越小的优先级越高。

审查在后台进行。

批次注册成 kind 为 humanize-review 的后台任务，通过 ctx.jobs 上报进度。进度行进任务 roster，由 job-controller 实时推到浏览器。客户端渲染成输入框上方的进度条，会话头部的任务列表也会显示并允许取消。

并行批次大小由 reviewConcurrency 控制，缺省为 3。实际并发取 reviewConcurrency 与待审文件数中的较小值。批次同时在途审查多个文件，用滚动窗口推进。每批取队列头部最多 N 个，失败的文件插回队首，和还没处理过的文件凑成下一批。例如队列有 A B C D E 五个文件，三并发时，A 失败后第二批是 A D E。

单个文件最多尝试 1 + reviewRetries 次，reviewRetries 缺省为 1。额度用尽才计入最终失败。

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

匹配规则如下：

- 模式里没有 `/` 时，匹配任意层级的文件名。
- 含 `/` 的模式按声明文件所在目录锚定。
- `!` 前缀表示排除。
- 结尾 `/` 匹配该目录下所有文件。
- `*` 不跨目录，`**` 跨目录。

判定按规范链范围从小到大依次套用各条模式，最后一次命中的结果生效。

#### 压缩后触发

上下文压缩结束时，会话日志会出现 compaction/end 事件，插件订阅 session/event 就能拿到。

支持设置是否开启该功能。关闭时只在手动执行 /humanize 命令时合并。

## 设置页

插件导出 Config 声明设置，设置页只暴露标了 `volatile()` 的节点。命名空间是条目在补丁里声明的 id，也就是 dsh-humanize。运行时该节点交给插件的是一个带 `get()` 的引用，读取时要解引用。插件用访问器在使用时实时读，设置页改动直接生效。

浏览器端注册进 `plugins.row.config`，key 是 `<包名>#<行 id>`，用 `configForms.whileServed(['dsh-humanize'], ...)` 保证宿主真的服务这个命名空间时才出现。

页面把 `{ view, form }` 交给组件。`view: 'summary'` 渲染行内说明，`view: 'page'` 渲染表单。

读取走 `form.state`，它提供 value、base、user、revision、writable 五个字段。写入是一次原子 `form.mutate(ops, revision)`，path 以 volatile 节点名开头。

插件自带页面时声明 `settings.configure({ auto: false })`。

## 代码布局

宿主端代码放在 lib/ 下，按流程步骤分模块，index.js 只做组合：

- `lib/index.js`，组合根，读设置、装包装工具、接管钩子和命令。
- `lib/wrap.js`，标记写入，包装 write/edit，增加必填 human_facing。
- `lib/specs.js`，PROSE.md 分层规范加载、渲染与 include 模式匹配。
- `lib/pipeline.js`，审查管线，跨模块共享状态包括合并锁、审查锁和每文件串行队列，并负责单次审查的编排。
- `lib/review.js`，负责发起旁路审查，并用两个看门狗控制时长，空闲两分钟，总时长十分钟。
- `lib/annotations.js`，批注解析与暂存 markdown 渲染。
- `lib/review-run.js`，/humanize-review 批次。批次按滚动窗口并发执行，失败会重试。jobs 可用时上报进度，否则继续执行批次。批次执行期间不发完成通知。
- `lib/merge.js`，/humanize 合并、/humanize-loop 循环合并与 compaction/end 自动合并、子代理执行与收尾。
- `lib/staging.js`、`lib/diff.js`、`lib/prompts.js`，暂存读写、改动区段、提示词资源。

浏览器端的 client/ 目录拆为主入口加两个按需加载 chunk，与官方 dsh-client-ui-sidebar-terminal 的 client.js + client.terminal.js 同一模式。主入口只做 `require.async` 懒加载和插槽注册。chunk 用同样的 `__ModuleLoader__.load` 工厂格式注册。chunk 的注册对象在主入口基础上多一个 chunk 字段。

- `client/client.js`，入口，按需加载 chunk。注册 conversation.input.dock 与两处设置座位。
- `client/client.settings.js`，设置卡片，通用表单控件与业务字段。
- `client/client.progress.js`，输入框上方的进度条，渲染审查批次和循环合并两种任务。

chunk 地址随主入口文件变化，浏览器可以长期缓存。改完 chunk 需要同步更新主入口，让浏览器加载新的 chunk。

## 服务速查

| 能力           | 入口                       | 所属包         |
| -------------- | -------------------------- | -------------- |
| 工具注册与遮蔽 | ctx.tools.register 方法    | dsh-tools      |
| agent 创建通知 | agent/created 事件         | dsh-agent      |
| 会话事件       | session/event 事件         | dsh-session    |
| 主任务通知     | agent.session.append 方法  | dsh-session    |
| 审查调用       | ctx.llm.stream 方法        | dsh-llm        |
| 斜杠命令       | ctx.commands.register 方法 | dsh-commands   |
| 压缩时机       | compaction/end 事件        | dsh-compaction |
| 文件读写       | node:fs/promises           | —              |
| 设置读写       | ctx.configForms 服务       | dsh-client-ui-settings |
| 任务进度       | ctx.jobs.start 方法        | dsh-jobs       |

## 遗留事项

fiber 清理。fiber 是 cordis 里插件的运行实体，销毁它才会执行登记的清理动作。

这个 cordis 分叉的 fiber 状态变化通过 internal/status 事件派发，dispose 这个事件名不再使用。ctx.on('dispose') 注册的监听器永远不会被调用。

插件 fiber 销毁时要执行的清理动作，比如摘除包装工具、清理定时器，要用 ctx.effect 返回的清理函数登记，fiber 销毁时才会执行。

用错这个 API 会导致热重载后旧实例的包装工具残留，同名工具注册失败，审查功能挂死。

维护成本。官方 write 和 edit 升级时，包装工具要跟着检查一遍。

绕过通道。模型用 bash 写文件会绕过写入工具，因此没有标记。这个盲区暂不处理。
