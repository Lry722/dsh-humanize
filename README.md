# dsh-humanize

> 让推理模型专注干活，让交付内容好好说人话。

`dsh-humanize` 是一个面向 `deepseek-harness` 的插件，旨在解决编码特化模型在复杂任务中不说人话的问题。

---

## 为什么需要它？

主流编码模型能处理复杂工程推理，但输出的文字偏向机器化黑话。人类读起来非常难受。

如果尝试在主提示词中施加过多风格与修辞约束，又会分散模型的推理注意力，降低复杂任务的效率。

---

## 核心构想

`dsh-humanize` 的核心理念是**将逻辑推理与文风润色解耦**：

- **标记旁路**：在内容写入时，区分纯逻辑代码与面向人类阅读的部分，仅对面向人类阅读的内容触发旁路审查。
- **风格契约**：引入 `PROSE.md`，一份类似 `AGENTS.md` 的层级规范文档，支持多级目录规则合并，作为行文可读性的统一标准。
- **逐条溯源**：审查过程对照 `PROSE.md` 中的规范分点进行批注，定位表达不当之处。
- **延迟应用**：审查在旁路进行，主任务流照常推进。批注异步暂存，仅在用户需要时按需合并。

---

## 安装

```sh
dsh plugin --profile web add link:/path/to/dsh-humanize
```

重启后生效。本地开发时，需要把 `@deepseek-ai/*` 依赖解析到 dsh 安装上。做法是在插件目录里建一个指向 profile 模块目录的 `node_modules` 符号链接：

```sh
ln -s ~/.dsh/profiles/node_modules node_modules
```

## 配置

在设置页的插件列表中找到 dsh-humanize，打开那一行的配置。六个参数直接修改，实时生效：

- `reviewProvider` 与 `reviewModel`：审查用的模型，从宿主模型目录里下拉选择。默认跟随会话当前使用的模型。
- `reviewReasoningEffort`：审查模型的推理等级，从所选模型公布的等级里下拉选择。默认采用模型自身的默认值。
- `reviewConcurrency`：并行批次大小，同时在途的审查调用数，最小 1，默认 3。上限由模型提供方的速率限制决定，同时并发不超过待审文件数。触及速率限制的文件记为失败，插回下一批重试。
- `reviewRetries`：失败重试次数，0 到 3，默认 1。失败的文件插回下一批，和还没处理过的文件凑成同一批。例如三并发下 A 失败时，下一批是 A 加后面两个。
- `mergeOnCompaction`：上下文压缩结束时是否自动合并整个项目的暂存批注，默认 true。设为 false 时只在手动执行 `/humanize` 时合并。

审查调用沿用模型自身的输出上限。失控防护由看门狗负责。单次调用空闲两分钟或总时长超过十分钟就中止，中止记为失败并插回下一批重试。批次终态会列出仍然失败的文件和原因。

也可以在 profile 的 `cordis.patch.yml` 里为 `dsh-humanize` 条目传入配置，作为设置页之下的底层配置：

```yaml
- id: dsh-humanize
  config:
    settings:
      reviewProvider: deepseek
      reviewModel: deepseek-chat
```

## 使用

在被审查文件的目录或上级目录放 `PROSE.md` 规范，用户全局规范放在 `~/.dsh/PROSE.md`。范围越小的规则优先级越高。

模型写文件时必须声明 `human_facing`：面向人类阅读的内容传 true，纯代码或数据传 false。只有标记为 true 的写入会进入审查，审查只看本次改动的区段。

批注暂存在 `~/.dsh/humanize/annotations/` 下，存放路径镜像被审查文件的路径，可以直接编辑。输入 `/humanize 路径` 合并指定文件或目录的批注。省略路径时使用当前工作目录。合并在独立子会话里执行，主会话的上下文不参与，完成后主会话收到一行结果说明，对应批注随之清空。

输入 `/humanize-review 路径`，可以在写入之外随时主动触发审查。只审查受 git 管理且路径命中 PROSE.md 文件头 include 模式的文件。模式语法参考 .gitignore：

```markdown
---
include:
  - '*.md'
  - 'docs/**/*.txt'
  - '!drafts/'
---
```

不含 `/` 的模式匹配任意层级的文件名。含 `/` 的按声明文件所在目录锚定。`!` 前缀表示排除。结尾 `/` 匹配该目录下所有文件。各层级声明合并生效，范围越小的优先级越高。审查在后台进行，批次显示为一个后台任务。进度条在输入框上方实时更新，会话头部的任务列表里也能看到，并可以取消。审查内容与会话上下文相互隔离。

## 提示词

发给模型的提示词都放在包的根目录 `prompts/` 下，直接编辑即可：

- `prompts/review-system.md`：旁路审查调用的 system 提示词。
- `prompts/merge-header.md`：`/humanize` 合并消息开头的提示词。
- `prompts/human-facing-field.md`：包装工具里 `human_facing` 参数的描述。

每次审查或合并都会重新读取对应文件，改完保存即生效。
