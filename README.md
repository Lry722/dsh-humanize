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

Open the dsh-humanize row in the Plugins list and edit its configuration. The bottom of the settings page shows where staged annotations, annotation history, review request records, and final turn outputs are stored, with a copy button beside each path. These settings take effect immediately:

- `reviewProvider` and `reviewModel`: the model used for review, picked from the host model catalog. Defaults to the model the session is using.
- `reviewReasoningEffort`: reasoning effort for the review model, picked from the efforts that model publishes. Defaults to the model's own default.
- `mergeProvider` and `mergeModel`: the model used by the merge subagent, with the same controls as the review model. The merge subagent covers `/humanize`, `/humanize-loop`, compaction-triggered and final-turn-output merges. Defaults to the model the main session is using. Set both fields together. If only one is set, both follow the session model.
- `mergeReasoningEffort`: reasoning effort for the merge subagent, picked from the efforts that model publishes. Defaults to the reasoning effort the main session is using.
- `reviewConcurrency`: maximum number of concurrent review calls, shared across write review, batch review and re-review. Minimum 1, default 3.
- `reviewRetries`: number of retries after a failure. Minimum 0, maximum 3, default 1.
- `reviewIntervalSeconds`: minimum time between reviews, counted from the end of the previous review. Writes during the interval are reviewed together when it ends. Minimum 0, maximum 3600, default 60. Set 0 to review without waiting.
- `loopMaxRounds`: maximum rounds for loop merge. Minimum 1, maximum 10, default 3.
- `saveTurnOutputs`: whether to keep only the latest main-session response in a system temp file and run one silent review and merge round when rules match. Default false.
- `mergeOnCompaction`: whether to merge all staged annotations in the project when context compaction ends. Default true. When off, compaction does not trigger a merge; other triggers are unaffected.
- `storageDir`: where staged annotations are stored. Leave empty for the default `~/.dsh/humanize`.

Each of the review and merge model sections has a test button. It sends a minimal request to confirm the provider, model and reasoning effort respond. An empty model selection follows the session model for review. The test button requires both fields to be set.

Review request records are stored separately in the system temp directory. The exact path appears at the bottom of the settings page. When a review response cannot be parsed, the raw response is written next to the review request record for comparison.

Relative paths resolve against the process working directory. Changing the storage location leaves the old contents in place.

Review concurrency is shared across write review, batch review and re-review. A batch is also capped by the number of files it has to review. High concurrency can hit the model provider's rate limit.

A call that hits a rate limit is recorded as failed and retried. A review that times out ends as aborted and is not retried.

Other failures wait longer before each retry. After the retry budget is spent, the review is marked failed. Write review and batch review share this retry behavior.

When a batch review ends, it lists the files that still failed and why, up to three entries. The rest are counted only. If write reviews keep failing, a failed record appears in the task list and points at the review model configuration.

You can also pass the same settings to the `dsh-humanize` entry in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-humanize
  config:
    settings:
      reviewProvider: deepseek
      reviewModel: deepseek-chat
```

## Usage

### Spec sources

Specs come from three sources:

- The user-wide spec at `~/.dsh/PROSE.md`.
- Project specs: the direct `.md` children of `.agents/prose/` at the project root. Nested directories are not scanned.
- Directory specs: `PROSE.md` in the target file's directory and its ancestor directories.

The project root is the target file's git repository root, so project specs remain visible when the session starts in a subdirectory. A `PROSE.md` at the project root also works as a directory spec.

`base.md` is an ordinary project spec. Its filename gives it no special scope or priority. Use `include: ["**/*"]` when it should provide project-wide rules.

Each spec has an implicit scope: everywhere for the user spec, the project for a project spec, and the directory subtree for a directory spec. Omitting `include` applies the spec throughout that scope. An explicit `include` can narrow it, using .gitignore syntax, and is evaluated independently for that spec. One spec's patterns never include or exclude another spec.

For example, a project spec can cover several directories and the root changelog:

```markdown
---
include:
  - "docs/"
  - "examples/"
  - "/CHANGELOG.md"
---
```

Anchored patterns in project specs resolve from the project root. In directory specs they resolve from the directory containing `PROSE.md`. Thus `/CHANGELOG.md` in a project spec names only the root changelog. Within one `include` list, the last matching pattern wins, and a `!` prefix excludes a match.

Specs merge in ascending numeric `priority` order, defaulting to 0. Ties put the user spec first, then project specs sorted by path, then directory specs from shallower to deeper. Later rules take precedence when they conflict.

If a matching spec declares `inherit: false`, it clears all previously accepted specs before adding itself. Matching specs later in the order are still added.

Every applicable spec must contain a level-1 `# Rules` heading. Numbered lines under it are review rules. Every other level-1 section is passed to review and merge unchanged as supplementary context, such as definitions or a glossary. For example:

```markdown
# Rules

1. Write plainly.
2. Avoid brackets in a sentence.

# Explanation

Abuse: xxx
```

Only numbered lines under `# Rules` take part in global rule numbering. Numbers in other sections stay as written. An applicable spec without a `# Rules` heading fails review with an error.

### Review scope

Review eligibility is independent of rule selection. Any candidate spec can declare `review.include` and `review.exclude`:

```markdown
---
review:
  include:
    - "docs/"
    - "/CHANGELOG.md"
  exclude:
    - "docs/drafts/"
---
```

Review declarations come from all candidate specs, independently of `include` matches and `inherit: false`. If any candidate declares `review.include`, review uses one allowlist across all candidates and starts denied. Include and exclude matches then enable or disable review in the same priority and source order. The last match wins.

Without any `review.include`, review starts allowed, so `review.exclude` alone can opt files out. These declarations control whether review runs. Merge rule selection stays independent of them.

Binary files such as images, archives, fonts and build output skip review. Detection samples the start of the file. Write review and batch review both use it. A batch review reports how many files it skipped.

When the model writes a file it must declare `human_facing`. Pass true for content meant for people, false for pure code or data. Writes marked true enter review. The rest are skipped. A programmatic call that omits the field is treated as false and logs a warning.

### How reviews run

After each review, the next write review waits one minute by default. Writes during the interval join the next review.

A review only looks at the regions changed in this write.

Reviews of the same file run serially. Writes from different sessions or subagents queue separately, and queued reviews are kept per agent without overwriting each other. While a merge runs, the reviews of the agent that started it are aborted or discarded. Reviews from other agents on the same target files are treated the same way. Batch reviews and merge re-reviews skip the interval and run immediately.

### Final turn outputs

`saveTurnOutputs` is off by default. When enabled, the end of each main-session turn writes the last assistant message with visible text to `dsh-humanize-<uid>/output/<session-title>--<short-id>.md` under the system temp directory. Each write replaces the previous version, keeping only the latest response. Reasoning, tool calls, empty messages and internal subagent responses are not saved. No output file is actually created in the project directory.

The filename uses the session title from the first saved turn. Path separators and other filesystem-unsafe characters become underscores, and an empty title falls back to `untitled-session`. The short ID suffix keeps same-title sessions separate. Later turns keep using the original file after a rename, and the suffix finds it after a plugin reload. Saving a new output cleans temporary outputs that have not been updated for 24 hours.

PROSE rules are still discovered and matched against the logical path `.agents/output/<session-title>--<short-id>.md` under the current working directory. This path is only a rule-matching label and need not exist. Review, merge and merge re-review share it, while all file I/O uses the real temp path. After the first new-version write, the plugin removes that session's legacy project output and its staged annotations.

Every write immediately runs a full review of the latest response without waiting for `reviewIntervalSeconds`; annotations from the previous turn are not carried over. If no rules apply, the review scope excludes the file, or review produces no annotations, the output is only saved and no merge is dispatched.

When review produces annotations, one merge and re-review round runs silently: no task progress row or main-session completion notice is created. Manual `/humanize` and `/humanize-loop` progress and results are unchanged. Further annotations produced by re-review remain staged as they do for a manual single merge; they do not trigger an automatic loop. Replacement, review and merge are serial within one session, and automatic merges from different sessions are dispatched one at a time.

With outputs enabled, the latest eligible turn shows concise polishing, ready or failed status in a compact single-line action row with a transparent background. Once ready, “View” opens the output in the built-in Markdown preview in the right sidebar. If finalization fails, the last saved version remains available. The original assistant response is unchanged and the sidebar does not open automatically. Older turns have no entry, preventing them from opening newer content that replaced their output.

### Staged annotations

Annotations are staged under `~/.dsh/humanize/annotations/`. The path mirrors the reviewed file. Annotations can be edited directly. The storage location can be changed on the settings page.

Staging groups them by complete rule text, and rule headings contain only that text. Global rule numbers validate the current review output and are not stored in staging. Staging content omits the file name. The next review matches rules by text.

Before overwriting or removing a staging file, the plugin appends its current contents to `history/`, beside the review request records in the system temp directory. The exact path appears on the settings page. History paths mirror the reviewed file. Every operation adds a new file and keeps older snapshots, and each filename records the archive time and operation.

Review clearing, merge clearing, and orphan cleanup each use a distinct label.

History serves troubleshooting only, and merging proceeds independently. The plugin leaves history files in place. The system may clean the temp directory according to its own policy.

### Merge and re-review

Run `/humanize <path>` to merge annotations for a file or directory. With no path, it uses the current working directory.

The merge runs in a separate context. A manual merge sends a summary to the main session when it finishes; automatic merges do not inject this notice.

The staged annotations for the merged files are cleared.

The plugin then runs another review over the files it just changed. This is called re-review. New annotations from re-review also stay in the staging files.

The merge result appears in the main session summary. The re-review result appears in the task row. If re-review fails for `/humanize` or `/humanize-loop`, the task ends as failed, no longer counts as converged, and a note is added to the main session.

When a merge starts, running reviews are aborted first. Queued reviews are discarded, and annotations already produced are discarded with them. Reviews from other sessions on the same files also step aside.

If the plugin reloads during a merge or re-review, that run ends. Completed merges still clear their staged annotations. Incomplete merges keep them. Run the command again to continue.

Run `/humanize-loop <path>` to merge and re-review in a loop. After each merge round, every file just merged is re-reviewed. New annotations from re-review feed the next merge round. The loop ends when re-review produces no new annotations or the round limit is reached.

The merge target, round and files awaiting re-review stay in memory. If staged annotations are empty mid-run, the loop waits for re-review before deciding whether new annotations remain. Only one merge run is allowed at a time, across sessions.

If the plugin reloads during a loop, that run ends. Completed merges still clear their staged annotations. Incomplete merges keep them.

### Background tasks

Only manual `/humanize` and `/humanize-loop` runs register merge tasks. The loop progress bar shows the current round and the number of annotations in that round. Automatic merges triggered by compaction or final turn output run silently without a task row or result notice.

`/humanize` and `/humanize-loop` tasks can be cancelled from the task list. Cancelling a loop takes effect before the next round. Completed merges still clear their staged annotations.

If the profile watches this plugin's directory with HMR, changing the plugin's own source triggers a plugin reload. Reload ends a running merge. Run the command again to continue.

### Batch review

Run `/humanize-review <path>` to dispatch a batch review. By default, it reviews every git-tracked file under the target.

Run `/humanize-review --changed <path>` to review only files changed since HEAD. The flag can come before or after the path. Omit the path to use the current working directory.

Changed files include working-tree modifications, staged changes, and untracked files that git does not ignore. Deleted files are skipped.

The full file is still sent, but annotations are limited to the changed regions. New files get a full review. When nothing changed, the task ends as completed and says so.

Run `/humanize-review --recent N <path>` to re-review files touched by the last N commits. The commits only select the file set. Review uses the current working-tree content and covers the whole file.

If the repository has fewer than N commits, it falls back to all files at HEAD. Files missing from the working tree are skipped. `--recent` and `--changed` are mutually exclusive.

Review runs in the background as a task. The progress bar updates above the input box. The task list in the session header shows the same task. Review runs in a separate context. What it reads stays separate from the session.

The target must be inside a git repository whose status can be read. If either condition is missing, the task ends as failed with a reason. If there is nothing to review, the task ends as completed and says so.

All three modes apply the independent `review.include` and `review.exclude` decision described above. A file must be allowed for review and have at least one applicable numbered rule. The modes differ in which files they check:

- The default mode checks git-tracked files.
- The incremental mode checks changed files.
- The recent mode checks the files touched by the last N commits and their presence in the working tree.

## Prompts

Prompts sent to the model live in `prompts/` at the package root. Edit them directly:

- `prompts/review-system.md`: system prompt for review calls, shared by write review and batch review.
- `prompts/merge-request.md`: user message sent to the merge subagent. It contains the path to the merge request file.
- `prompts/merge-header.md`: prompt at the start of the merge message, shared by all three merge triggers.
- `prompts/human-facing-field.md`: description of the `human_facing` field in the wrapped tool.

Review and merge read their prompt files on every call. The `human_facing` description is read when the wrapped tools are registered, so changes apply to new sessions.
