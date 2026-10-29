---
include:
  - "**/*.md"
  - "**/*.js"
  - "**/*.mjs"
  - "**/*.ts"
  - "!prompts/"
  - "!.agents/prose/"
priority: 50
---

# Rules

1. 相似的概念和动作应当用相同的术语表述，提高一致性，降低理解负担。

# 术语

下表列出各概念在文档、注释和界面文案里的统一说法。

| 英文 | 中文 | 说明 |
| --- | --- | --- |
| job | 后台任务 | 一项在后台运行的工作，在任务列表里显示进度和结果 |
| review | 审查 | 一次审查调用 |
| write review | 写入审查 | 写入文件后触发的审查 |
| batch review | 批次审查 | 一次覆盖多个文件的审查 |
| review batch | 审查批次 | 批次审查对应的后台任务 |
| re-review | 复审 | 合并后对刚改过的文件再跑的一次审查 |
| merge | 合并 | 把暂存批注应用到文件并触发复审 |
| loop merge | 循环合并 | 进行多轮合并 |
| annotation | 批注 | 一条审查意见 |
| staged annotation | 暂存批注 | 尚未合并的批注 |
| staging file | 暂存文件 | 按文件保存批注的 markdown 文件 |
| spec | 规范 | 规范文件提供的行文规则 |
| spec chain | 规范链 | 当前文件最终适用的有序规范集合 |
| changed region | 改动区段 | 本次改动覆盖的文件区段 |
