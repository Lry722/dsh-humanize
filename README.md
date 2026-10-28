# dsh-humanize

English | [简体中文](README.zh.md) | [Design (Chinese)](DESIGN.md)

> Let reasoning models focus on the work. Let what they deliver read like a person wrote it.

`dsh-humanize` is a plugin for `deepseek-harness`. It targets the machine-sounding jargon that coding-specialized models produce on complex tasks.

## Why it exists

Coding-specialized models handle complex engineering reasoning, but their prose drifts toward machine jargon. That costs the reader extra effort.

Packing many style and rhetoric constraints into the main prompt splits the model's reasoning attention, and complex tasks get slower.

## How it works

`dsh-humanize` separates logical reasoning from prose polish:

- **Mark at write time**: when content is written, separate code and data from text meant for people. Only human-facing writes trigger review.
- **One style contract**: `PROSE.md` defines how prose should read.
- **Cite each rule**: the reviewer annotates against individual `PROSE.md` rules and points at the expression that violates the rule.
- **Apply later**: review runs in the background while the main session keeps moving. Staged annotations are applied on demand, and compaction triggers a polish run.

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

## Quick reference

| Command | What it does |
| --- | --- |
| `/humanize [path]` | Polish prose from staged annotations once, then re-review the changed files. |
| `/humanize-loop [path]` | Polish and re-review in rounds until no annotations remain or the round limit is reached. |
| `/humanize-review [path]` | Review git-tracked files under the path. |
| `/humanize-review --changed [path]` | Review files changed since HEAD. |
| `/humanize-review --recent N [path]` | Review files touched by the last N commits. |

`path` defaults to the session working directory. The `--changed` and `--recent` flags can come before or after the path. Reviews keep only files matched by at least one spec.

## Configuration

Open the dsh-humanize row in the Plugins list and edit its configuration. All settings take effect immediately.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `reviewProvider`, `reviewModel` | Session model | Provider and model for review calls, picked from the host model catalog. |
| `reviewReasoningEffort` | Model default | Reasoning effort for review calls, picked from the efforts the model publishes. |
| `mergeProvider`, `mergeModel` | Session model | Provider and model for polish subagents, picked with the same controls. They apply to every polish trigger. |
| `mergeReasoningEffort` | Session effort | Reasoning effort for polish subagents, picked from the efforts the model publishes. |
| `reviewConcurrency` | `3` | Maximum concurrent review calls. Minimum 1. |
| `reviewRetries` | `1` | Retries after a failed review. Range 0 to 3. |
| `reviewIntervalSeconds` | `60` | Minimum gap before the next write review, counted from the end of the previous review. Range 0 to 3600. Set 0 to review immediately. |
| `loopMaxRounds` | `3` | Maximum rounds for `/humanize-loop`. Range 1 to 10. |
| `saveTurnOutputs` | `false` | Keep the latest main-session response in a system temp file. |
| `mergeOnCompaction` | `true` | Polish prose from staged annotations when context compaction ends. |
| `storageDir` | Empty | Where staged annotations are stored. The default is `~/.dsh/humanize`. |

The review and polish model sections each have a test button. It sends a minimal request to confirm the provider, model and reasoning effort respond. Set both fields of a model pair before testing. During normal calls, a pair with only one field set follows the session model.

### Storage paths

The bottom of the settings page shows where staged annotations, annotation history, review request records, and final turn outputs are stored. Each path has a copy button.

Relative paths resolve against the process working directory. Changing `storageDir` leaves the old contents in place.

### Config file

You can also pass the same settings to the `dsh-humanize` entry in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-humanize
  config:
    settings:
      reviewProvider: deepseek
      reviewModel: deepseek-chat
```

## Writing specs

### Sources and scope

Specs come from three sources:

- The user-wide spec at `~/.dsh/PROSE.md`.
- Project specs: the direct `.md` children of `.agents/prose/` at the project root. Nested directories are not scanned.
- Directory specs: `PROSE.md` in the target file's directory and its ancestor directories.

The project root is the target file's git repository root, so project specs remain visible when the session starts in a subdirectory. A `PROSE.md` at the project root also works as a directory spec.

`base.md` is an ordinary project spec. Its filename gives it no special scope or priority. Omitting `include` applies it throughout the project. An explicit `include: ["**/*"]` has the same effect.

Each spec has an implicit scope: everywhere for the user spec, the project for a project spec, and the directory subtree for a directory spec. Omitting `include` applies the spec throughout that scope.

### Include patterns

An explicit `include` narrows the spec's scope, using .gitignore syntax. It is evaluated independently for that spec. An empty list matches no files. One spec's patterns never include or exclude another spec.

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

### Priority and inheritance

Specs merge in ascending numeric `priority` order, defaulting to 0. Ties put the user spec first, then project specs sorted by path, then directory specs from shallower to deeper. Later rules take precedence when they conflict.

If a matching spec declares `inherit: false`, it clears all previously accepted specs before adding itself. Matching specs later in the order are still added.

### Rule format

Every applicable spec must contain a level-1 `# Rules` heading. Numbered lines under it are review rules. Every other level-1 section is passed to review and polish unchanged as supplementary context, such as definitions or a glossary. For example:

```markdown
# Rules

1. Write plainly.
2. Avoid brackets in a sentence.

# Explanation

Abuse: xxx
```

Only numbered lines under `# Rules` take part in global rule numbering. Numbers in other sections stay as written. An applicable spec without a `# Rules` heading fails review with an error.

## Review pipeline

### What enters review

A file enters review when at least one spec applies and the merged set contains at least one numbered rule. `include` selects the applicable specs. `priority` and `inherit` only affect merging. There is no separate review declaration.

Batch collection first drops files that no spec matches. Files matched by a spec without numbered rules are reported by the review pipeline. Write review, batch review and post-polish re-review share this decision.

Binary files such as images, archives, fonts and build output skip review. Detection samples the start of the file. Write review and batch review both use it. A batch review reports how many files it skipped.

When the model writes a file through the wrapped `write` or `edit` tool, it must declare `human_facing`. Pass true for content meant for people, false for pure code or data. Writes marked true enter review. The rest are skipped. Writes through other tools, such as shell commands, are outside this check. A programmatic call that omits the field is treated as false and logs a warning.

### When reviews run

After each review, the next write review waits one minute by default. Writes during the interval join the next review.

A write review of an existing file only looks at the regions changed in this write. A new file is reviewed in full. The review call still receives the full file. Markers only limit where new annotations may point.

Reviews of the same file run serially. Writes from different sessions or subagents queue separately, and each agent keeps its own pending review entry. While a polish run is in progress, the reviews of the agent that started it are aborted or discarded. Reviews from other agents on the same target files are treated the same way. Batch reviews and polish re-reviews skip the interval and run immediately.

### Concurrency and retries

All review calls share `reviewConcurrency`. A batch is also capped by the number of files it has to review. High concurrency can hit the model provider's rate limit.

Rate limits and review timeouts are recorded as failed and retried. Every retry waits longer than the previous one. After the retry budget is spent, the review is marked failed. Write review and batch review share this retry behavior.

When a batch review ends, it lists the files that still failed and why, up to three entries. The rest are counted only. If write reviews keep failing, a failed record appears in the task list and points at the review model configuration.

### Review records

Review request records are stored separately in the system temp directory. The exact path appears at the bottom of the settings page. When a review response cannot be parsed, the raw response is written next to the review request record for comparison.

## Final turn outputs

### Saving

`saveTurnOutputs` is off by default. When enabled, the end of each main-session turn writes the last assistant message with visible text to `dsh-humanize-<uid>/output/<session-title>--<short-id>.md` under the system temp directory. Each write replaces the previous version, keeping only the latest response.

Reasoning, tool calls, empty messages and internal subagent responses are not saved. No output file is actually created in the project directory.

### Files and cleanup

The filename uses the session title from the first saved turn. Path separators and other filesystem-unsafe characters become underscores, and an empty title falls back to `untitled-session`. The short ID suffix keeps same-title sessions separate. Later turns keep using the original file after a rename, and the suffix finds it after a plugin reload.

Saving a new output cleans temporary outputs that have not been updated for 24 hours. The cleanup scan runs at most once an hour.

PROSE rules are still discovered and matched against the logical path `.agents/output/<session-title>--<short-id>.md` under the current working directory. This path is only a rule-matching label and need not exist. Review and polish share it, while all file I/O uses the real temp path. The first write also removes this session's project outputs that an older version left behind, along with their staged annotations.

### Polishing

Each write saves only the original output and clears annotations from the previous turn. Review starts only when the user clicks the polish icon. Clicking the icon in the action row of the latest eligible turn immediately runs a full review, without waiting for `reviewIntervalSeconds`. If no rules apply or review produces no annotations, output polishing ends without dispatching a prose-polish run.

When review produces annotations, one prose-polish round runs silently. Output polishing finishes as soon as that round completes, and a re-review is skipped. The polish round stays out of the task list and skips the result notice to the main session.

Manual `/humanize` and `/humanize-loop` runs show progress and results in the task list, and re-review the polished files. Saving, review and prose polishing are serial within one session, and polish runs for final turn outputs from different sessions are dispatched one at a time.

### Action row

After saving, the latest eligible turn shows a polish icon in its assistant action row, immediately after Fork. Clicking it shows a loading icon while polishing.

The final file is compared with the original turn output. A clickable View icon is shown only when the content actually changed. Clicking it opens the built-in Markdown preview in the right sidebar.

Unchanged and failed outputs show only their status icon, and hover text explains the state. The original assistant response stays intact, and the sidebar opens only when the user clicks the View icon.

Older turns have no entry, preventing them from opening newer content that replaced their output.

## Staged annotations

### Staging files

By default, annotations are staged under `~/.dsh/humanize/annotations/`. The path mirrors the reviewed file. Annotations can be edited directly. The storage location can be changed on the settings page.

Staging groups them by complete rule text, and rule headings contain only that text. Global rule numbers validate the current review output and are not stored in staging. Staging content omits the file name. The next review matches rules by text.

### History

Before overwriting or removing a staging file, the plugin appends its current contents to `history/`, beside the review request records in the system temp directory. The exact path appears on the settings page. History paths mirror the reviewed file.

Every operation adds a new file and keeps older snapshots, and each filename records the archive time and operation. Review clearing, polish clearing, and orphan cleanup each use a distinct label.

History serves troubleshooting only, and polishing proceeds independently. The plugin leaves history files in place. The system may clean the temp directory according to its own policy.

## Prose polishing

### Commands and targets

Run `/humanize <path>` to polish prose from staged annotations for a file or directory. With no path, it uses the current working directory. A file target polishes that file. A directory target polishes every file with staged annotations under it.

Run `/humanize-loop <path>` to polish and re-review in a loop. After each polish round, every file just polished is re-reviewed. New annotations from re-review feed the next polish round. The loop ends when re-review produces no new annotations or the round limit is reached.

Manual polish runs send a summary to the main session when they finish. Automatic polish runs do not inject this notice.

### Polish subagent

Prose polishing runs in a separate context. Each parent session reuses one polish subagent. Before a continued polish, the previous model-visible polish turns are replaced by one fixed reset marker, so old requests, replies, and tool calls are not sent to the model again. The durable session log is still retained.

The polish subagent model follows the polish settings. The subagent only has file read/write, search and persona tools. Its writes skip review.

### Polish lifecycle

When a polish run starts, running reviews are aborted first. Queued reviews are discarded, and annotations already produced are discarded with them. Reviews from other sessions on the same files also step aside.

The staged annotations for the polished files are cleared on success. A failed polish keeps them.

After a successful manual polish, the plugin runs another review over the files it just changed. This is called re-review. New annotations from re-review also stay in the staging files. The polish result appears in the main session summary. The re-review result appears in the task row.

If re-review fails for `/humanize` or `/humanize-loop`, the task ends as failed, no longer counts as converged, and a note is added to the main session.

Only one polish run is allowed at a time, across sessions. Before dispatch, the plugin checks for a live polish subagent from the same session and refuses to start another.

If the plugin reloads during a polish or re-review, that run ends. Completed polish runs still clear their staged annotations. Incomplete runs keep them. For a manual polish, run the command again to continue.

### Loop polish

The polish target, round and files awaiting re-review stay in memory. If staged annotations are empty mid-run, the loop waits for re-review before deciding whether new annotations remain.

### Automatic polish

`mergeOnCompaction` defaults to true. When context compaction ends, the plugin polishes prose under the session working directory from all staged annotations. When the setting is off, compaction skips the polish, while manual commands and output polishing are unaffected. These polish runs are silent and skip the task row and result notice. They still re-review the files they changed.

The prose-polish run triggered by output polishing is also silent. It runs one round and skips re-review. See [Final turn outputs](#final-turn-outputs).

### Background tasks

Only manual `/humanize` and `/humanize-loop` runs register polish tasks. The loop progress bar shows the current round and the number of annotations in that round. Compaction-triggered polish runs and prose-polish runs started from output polishing run silently without a task row or result notice.

`/humanize` and `/humanize-loop` tasks can be cancelled from the task list. Cancelling a loop takes effect before the next round. Completed polish runs still clear their staged annotations.

If the profile watches this plugin's directory with HMR, changing the plugin's own source triggers a plugin reload. Reload ends a running polish. For a manual polish, run the command again to continue.

## Batch review

### Modes

Run `/humanize-review <path>` to dispatch a batch review. `path` defaults to the current working directory. Flags can come before or after the path.

| Mode | Files checked | Review scope |
| --- | --- | --- |
| Default | Git-tracked files under the path. | Full file. |
| `--changed` | Files changed since HEAD, plus untracked files git does not ignore. | Changed regions. New files are reviewed in full. |
| `--recent N` | Files touched by the last N commits and still present in the working tree. | Full current content. |

`--changed` and `--recent` skip deleted files. The default mode works from git-tracked paths, so a missing tracked file can be reported as a read failure. `--recent` and `--changed` are mutually exclusive.

### Selection details

For `--changed`, changed files include working-tree modifications and staged changes, as well as untracked files that git does not ignore. The full file is still sent, but annotations are limited to the changed regions. When nothing changed, the task ends as completed and says so.

For `--recent N`, the commits only select the file set. Review uses the current working-tree content and covers the whole file. If the repository has fewer than N commits, it falls back to all files at HEAD. Files missing from the working tree are skipped.

### Runtime and completion

Review runs in the background as a task. The progress bar updates above the input box. The task list in the session header shows the same task. Review runs in a separate context. What it reads stays separate from the session.

The target must be inside a git repository whose status can be read. If either condition is missing, the task ends as failed with a reason. If there is nothing to review, the task ends as completed and says so.

All three modes keep only files matched by at least one spec. The pipeline then requires at least one numbered rule. Binary files skip review, and the batch completion note reports how many files were skipped.

Batch review uses the shared review concurrency and retry behavior. Failures are summarized as described in [Concurrency and retries](#concurrency-and-retries).

## Prompts

Prompts sent to the model live in `prompts/` at the package root. Edit them directly:

- `prompts/review-system.md`: system prompt for every review call.
- `prompts/merge-request.md`: user message sent to the polish subagent. It contains the path to the polish request file.
- `prompts/merge-header.md`: prompt at the start of every polish message.
- `prompts/human-facing-field.md`: description of the `human_facing` field in the wrapped tool.

Review and polish read their prompt files on every call. The `human_facing` description is read when the wrapped tools are registered, so changes apply to new sessions.
