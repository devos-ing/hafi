# CLI architecture

Hafi is an early local TypeScript and Bun CLI. Its first release aims to read Gmail and Lark messages, ask Jev whether a personal reply is needed, and save a suggested reply draft locally. The source integrations still need live account verification.

```text
Codex / Claude Code IDE ──> Hafi onboarding and review commands
OS cron or terminal ─────> hafi run-once --workflow hafi.yaml
                                  │
                             WorkflowRunner ── SQLite
                                  │
                       GmailSource or LarkSource
                                  │
                            Jev evaluator
                                  │
                       save_reply_draft action
                                  │
                             Codex CLI
                                  │
                          local draft result
```

`InboxSource` is a small interface implemented by Gmail and Lark adapters. Each adapter returns a common `InboxItem` with a stable provider reference and bounded conversation context. The concrete runner reads a validated workflow, claims a run lease, fetches new items, evaluates conversations, executes its one supported action, and records results. The CLI renders that core output as text or JSON. A later Web UI can reuse the core without changing provider adapters.

System cron runs a short-lived process; Hafi needs no always-running daemon. SQLite stores provider cursors, work items, run status, and reviewable drafts. A cursor and its queued message references are saved together. Failed Jev or Codex calls keep work retryable. Repeated runs must not create duplicate results.

The first run establishes an inbox baseline, so old messages do not become new work. Gmail uses history-based sync; Lark uses per-chat baselines for user-authorized chats. Lark's user-identity chat list documents `types=p2p,group` for both direct and group chats. Live permissions and coverage remain to be verified before release.

OAuth tokens and API keys belong in the local secret store, outside YAML and the repository. Drafts and state are private local files. Hafi does not send replies or notifications in the first workflow.

See [Workflow YAML](./workflows.md) for the configuration and the [implementation plan](../HAFI_CLI_IMPLEMENTATION_PLAN.md) for commands and delivery checks.
