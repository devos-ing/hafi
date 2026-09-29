# Workflow YAML

Hafi is in early development. The CLI parses and validates workflow v1; live Gmail, Lark, and Jev runs still need account verification.

## Example

```yaml
version: 1
id: reply-review
sources:
  - provider: gmail
    account: personal
  - provider: lark
    account: work
schedule:
  every_minutes: 5
filter:
  bot: jev
  question: "Does this new message need a personal reply from me?"
  match_at_or_above: 0.7
actions:
  - type: save_reply_draft
    composer: codex
    max_words: 120
```

The workflow can include Gmail, Lark, or both. `account` is a local credential alias established by `hafi connect`; the YAML contains no OAuth tokens or API keys. `schedule.every_minutes` accepts 1, 2, 5, 10, 15, 30, or 60. System cron starts the one-shot Hafi process at that interval.

Jev evaluates new conversation state against `filter.question`. A score at or above `match_at_or_above` selects the first action. Workflow v1 permits exactly one action: `save_reply_draft`. Codex generates a bounded draft that Hafi saves as a private local result. The user reviews it through the CLI or an IDE and sends it in the original app.

Hafi rejects unknown fields and action types. The YAML cannot run arbitrary commands, scripts, or remote includes. `hafi workflow validate <file> --json` checks the format before a scheduled run.

## Check workflow activity

`hafi summary --workflow <id> --json` reads SQLite only. It reports the latest run and last successful run, queued and retryable work, lifetime work and draft counts, skip and retry reasons, and up to 100 recent message references. It includes IDs and account aliases but no message bodies or draft text, so treat its output as private. Codex or Claude Code can read this JSON to explain what happened without polling Gmail or Lark.

`summary` is a one-shot report. It does not run the workflow or install a schedule. `hafi schedule print` only prints a cron entry; the user or IDE agent installs that entry. Hafi has no persistent daemon. Each cron invocation runs `hafi run-once` and exits.

See the [implementation plan](../HAFI_CLI_IMPLEMENTATION_PLAN.md) for the state model and build sequence.
