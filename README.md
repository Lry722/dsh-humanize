# dsh-humanize

English | [简体中文](README.zh.md)

> Let reasoning models focus on the work. Let what they deliver read like a person wrote it.

`dsh-humanize` is a plugin for `deepseek-harness`. It targets the machine-sounding jargon that coding-specialized models produce on complex tasks.

---

## Why it exists

Coding-specialized models handle complex engineering reasoning, but their prose drifts toward machine jargon. That costs the reader extra effort.

Packing many style and rhetoric constraints into the main prompt splits the model's reasoning attention, and complex tasks get slower.

---

## How it works

`dsh-humanize` separates logical reasoning from prose polish:

- **Mark at write time**: when content is written, separate code and data from text meant for people. Only human-facing writes trigger review.
- **One style contract**: `PROSE.md` defines how prose should read.
- **Cite each rule**: the reviewer annotates against individual `PROSE.md` rules and points at the expression that violates the rule.
- **Apply later**: review runs in the background while the main session keeps moving. Annotations merge when the user asks for them.

---

## Install

Install from GitHub:

```sh
dsh plugin --profile web add github:Lry722/dsh-humanize
```

For local development, link the current directory:

```sh
dsh plugin --profile web add link:/path/to/dsh-humanize
```

Restart dsh after installation.

## Configuration

Open the dsh-humanize row in the Plugins list and edit its configuration. The bottom of the settings page shows where staged annotations and review request records are stored, with a copy button beside each path. These settings take effect immediately:

- `reviewProvider` and `reviewModel`: the model used for review, picked from the host model catalog. Defaults to the model the session is using.
- `reviewReasoningEffort`: reasoning effort for the review model, picked from the efforts that model publishes. Defaults to the model's own default.
- `mergeProvider` and `mergeModel`: the model used by the merge subagent, with the same controls as the review model. The merge subagent covers `/humanize`, `/humanize-loop` and compaction-triggered merges. Defaults to the model the main session is using. Set both fields together; if only one is set, both follow the session model.
- `mergeReasoningEffort`: reasoning effort for the merge subagent, picked from the efforts that model publishes. Defaults to the reasoning effort the main session is using.
- `reviewConcurrency`: maximum number of concurrent review calls, shared across write review, batch review and re-review. Minimum 1, default 3.
- `reviewRetries`: number of retries after a failure. Minimum 0, maximum 3, default 1.
- `loopMaxRounds`: maximum rounds for loop merge. Minimum 1, maximum 10, default 3.
- `mergeOnCompaction`: whether to merge all staged annotations in the project when context compaction ends. Default true. When off, merges only run on `/humanize` or `/humanize-loop`.
- `storageDir`: where staged annotations are stored. Leave empty for the default `~/.dsh/humanize`.

Each of the review and merge model sections has a test button. It sends a minimal request to confirm the provider, model and reasoning effort respond. An empty model selection follows the session model for review; the test button requires both fields to be set.

Review call records are stored separately in the system temp directory; the exact path appears at the bottom of the settings page. When a review response cannot be parsed, the raw response is written next to the call record for comparison.

Relative paths resolve against the process working directory. Changing the storage location leaves the old contents in place.

Review concurrency is shared across write review, batch review and re-review. A batch is also capped by the number of files it has to review. High concurrency can hit the model provider's rate limit.

A call that hits a rate limit is recorded as failed and retried. A review that times out is aborted; that review ends as aborted and is not retried. Other failures wait longer before each retry; after the retry budget is spent, the review is marked failed. Write review and batch review share this retry behavior.

When a batch review ends, it lists the files that still failed and why, up to three entries; the rest are counted only. If write reviews keep failing, a failed record appears in the task list and points at the review model configuration.

You can also pass the same settings to the `dsh-humanize` entry in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-humanize
  config:
    settings:
      reviewProvider: deepseek
      reviewModel: deepseek-chat
```

## Usage

Put a `PROSE.md` in the directory of the file under review or in a parent directory. The user-wide spec goes at `~/.dsh/PROSE.md`. Specs stack by directory; the narrower the scope, the higher the priority.

The front matter of `PROSE.md` can declare which files the spec covers with `include`, using .gitignore syntax:

```markdown
---
include:
  - '*.md'
  - 'docs/**/*.txt'
  - '!drafts/'
---
```

`include` belongs to the whole spec chain. If any level of the chain declares it, only files that match enter review. Write review and batch review both follow this scope. If no level declares `include`, the spec applies to every file.

Binary files such as images, archives, fonts and build output skip review. Detection samples the start of the file; write review and batch review both use it. A batch review reports how many files it skipped.

When the model writes a file it must declare `human_facing`. Pass true for content meant for people, false for pure code or data. Writes marked true enter review; the rest are skipped. A programmatic call that omits the field is treated as false and logs a warning. Review looks only at the regions changed in this write.

Reviews of the same file run serially. Writes from different sessions or subagents queue separately, and pending entries are kept per agent without overwriting each other. While a merge runs, the reviews of the agent that started it step aside. Reviews from other agents on the same target files also step aside.

Annotations are staged under `~/.dsh/humanize/annotations/`. The path mirrors the reviewed file. Annotations can be edited directly. Staging groups them by rule, and each rule heading carries its rule number so the next review can reuse it. The storage location can be changed on the settings page.

Run `/humanize <path>` to merge annotations for a file or directory. With no path, it uses the current working directory.

The merge runs in a separate context. When it finishes, the main session receives a summary.

The staged annotations for the merged files are cleared.

The plugin then runs another review over the files it just changed; this is called re-review. New annotations from re-review also stay in the staging files.

The merge result appears in the main session summary; the re-review result appears in the task row. If re-review fails for `/humanize` or `/humanize-loop`, the task ends as failed, no longer counts as converged, and a note is added to the main session.

When a merge starts, running reviews are aborted first. Queued reviews are discarded, and annotations already produced are discarded with them. Reviews from other sessions on the same files also step aside.

If the plugin reloads during a merge or re-review, that run ends. Completed merges still clear their staged annotations. Incomplete merges keep them; run the command again to continue.

Run `/humanize-loop <path>` to merge and re-review in a loop. After each merge round, every file just merged is re-reviewed. New annotations from re-review feed the next merge round. The loop ends when re-review produces no new annotations or the round limit is reached.

The merge target, round and files awaiting re-review stay in memory. If staged annotations are empty mid-run, the loop waits for re-review before deciding whether new annotations remain. Only one merge run is allowed at a time, across sessions.

If the plugin reloads during a loop, that run ends. Completed merges still clear their staged annotations. Incomplete merges keep them.

`/humanize`, `/humanize-loop` and compaction-triggered merges all register background tasks. The loop progress bar shows the current round and the number of annotations in that round.

`/humanize` and `/humanize-loop` tasks can be cancelled from the task list. Cancelling a loop takes effect before the next round; completed merges still clear their staged annotations. Compaction-triggered merges only report results and cannot be cancelled.

If the profile watches this plugin's directory with HMR, changing the plugin's own source triggers a plugin reload. Reload ends a running merge; run the command again to continue.

Run `/humanize-review <path>` to dispatch a batch review. By default, it reviews every git-tracked file under the target.

Run `/humanize-review --changed <path>` to review only files changed since HEAD. The flag can come before or after the path; omit the path to use the current working directory. Changed files include working-tree modifications, staged changes, and untracked files that git does not ignore. Deleted files are skipped. The full file is still sent, but annotations are limited to the changed regions; new files get a full review. When nothing changed, the task ends as completed and says so.

Review runs in the background as a task. The progress bar updates above the input box. The task list in the session header shows the same task. Review runs in a separate context; what it reads stays separate from the session.

The target must be inside a git repository whose status can be read. If either condition is missing, the task ends as failed with a reason. If there is nothing to review, the task ends as completed and says so. The default mode checks git-tracked files and the include patterns; the incremental mode checks changed files and the include patterns.

## Prompts

Prompts sent to the model live in `prompts/` at the package root; edit them directly:

- `prompts/review-system.md`: system prompt for review calls, shared by write review and batch review.
- `prompts/merge-request.md`: user message sent to the merge subagent; contains the path to the merge request file.
- `prompts/merge-header.md`: prompt at the start of the merge message, shared by all three merge triggers.
- `prompts/human-facing-field.md`: description of the `human_facing` field in the wrapped tool.

Review and merge read their prompt files on every call. The `human_facing` description is read when the wrapped tools are registered, so changes apply to new sessions.
