# Hafi

**Go hands-free.** Hafi is a local CLI for finding messages that need your reply and preparing a draft you can review.

Hafi is an early local CLI implementation. There is no release binary yet. The [implementation plan](./HAFI_CLI_IMPLEMENTATION_PLAN.md) defines the first build.

Read the [public Hafi Docs](https://hafi-go-hands-free-docs.free-hero-8440.chatgpt.site) for the workflow, architecture, and proposed commands.

## First workflow

1. Connect a Gmail or Lark account on your computer.
2. Let a scheduled Hafi run read new messages.
3. Ask Jev whether each conversation needs your personal reply.
4. Run the action in a local YAML workflow. The first action saves a suggested reply draft for review.
5. Read the result in the CLI or through a coding assistant such as Codex or Claude Code. You send the reply in the original app.

Hafi stores results locally. The first workflow does not send messages or notifications.

## Proposed CLI

These commands describe the CLI under development. Provider integrations still need live account verification.

```text
hafi init --source gmail --workflow hafi.yaml
hafi connect gmail
hafi workflow validate hafi.yaml --json
hafi run-once --workflow hafi.yaml --dry-run --json
hafi run-once --workflow hafi.yaml --json
hafi results --workflow reply-review --json
hafi status --workflow reply-review --json
hafi schedule print --workflow hafi.yaml --platform cron
```

The same connection and workflow commands support Lark. Codex or Claude Code can run the commands during onboarding; browser authorization remains a user step. System cron runs the one-shot command in the background. Hafi does not need a permanent daemon.

## Docs

- [Workflow YAML](./docs/workflows.md) explains the reusable configuration and the first action.
- [Architecture](./docs/architecture.md) maps the local components and state.
- [Example workflow](./hafi.workflow.example.yaml) shows Gmail and Lark sources.
- [Implementation plan](./HAFI_CLI_IMPLEMENTATION_PLAN.md) gives the build order, package choices, and live end-to-end check.

## Develop locally

Requires Bun 1.3 or later, a local Codex CLI, and credentials for the providers you choose to connect.

```sh
bun install
bun run typecheck
bun test
bun run build
./dist/hafi help --json
```

Use `hafi connect jev` to store a Jev API key through local input. Gmail app setup uses `HAFI_GMAIL_CLIENT_ID` and `HAFI_GMAIL_CLIENT_SECRET`; Lark app setup uses `HAFI_LARK_APP_ID`, `HAFI_LARK_APP_SECRET`, and `HAFI_LARK_REDIRECT_URI`. User tokens are stored in the operating system credential store, not in workflow YAML. Keep the app credentials out of committed files.

Lark's default chat listing returns groups. Its user-identity API also documents `types=p2p,group` for one-to-one and group chats; Hafi requests both. Live account permissions and coverage still need end-to-end verification. See the [Lark CLI API reference](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-list.md).
