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
hafi onboard --workflow hafi.yaml
hafi workflow validate hafi.yaml --json
hafi run-once --workflow hafi.yaml --dry-run --json
hafi run-once --workflow hafi.yaml --json
hafi results --workflow reply-review --json
hafi status --workflow reply-review --json
hafi schedule print --workflow hafi.yaml --platform cron
```

Run `hafi onboard` in a terminal. Answer Yes or No for Gmail and Lark; Hafi opens the browser for each selected account and writes the workflow after authorization succeeds. For scripts, use `hafi init` and `hafi connect` separately. System cron runs the one-shot command in the background. Hafi does not need a permanent daemon.

## Docs

- [Workflow YAML](./docs/workflows.md) explains the reusable configuration and the first action.
- [Architecture](./docs/architecture.md) maps the local components and state.
- [Example workflow](./hafi.workflow.example.yaml) shows Gmail and Lark sources.
- [Implementation plan](./HAFI_CLI_IMPLEMENTATION_PLAN.md) gives the build order, package choices, and live end-to-end check.

## Develop locally

Requires Bun 1.3 or later, a local Codex CLI, and credentials for the providers you choose to connect.

```sh
bun install
bun run dev help
bun run dev dev --workflow hafi.workflow.example.yaml
bun run typecheck
bun test
bun run build
./dist/hafi help --json
```

`bun run dev` runs the CLI from source without watch mode. Pass `dev --workflow <file>` to perform one safe dry-run: it reads and evaluates messages without advancing cursors or saving drafts.
For machine-readable output through the script, use `bun run --silent dev help --json` to suppress Bun's script banner.

Use `hafi connect jev` to store a Jev API key through local input. Gmail app setup uses `HAFI_GMAIL_CLIENT_ID` and `HAFI_GMAIL_CLIENT_SECRET`; Lark app setup uses `HAFI_LARK_APP_ID`, `HAFI_LARK_APP_SECRET`, and `HAFI_LARK_REDIRECT_URI`. User tokens are stored in the operating system credential store, not in workflow YAML. Keep the app credentials out of committed files.

For Gmail, [enable the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) in the Google Cloud project that owns your OAuth client. Create a Google OAuth client with application type **Desktop app** in [Google Cloud Console](https://console.cloud.google.com/auth/clients), then set `HAFI_GMAIL_CLIENT_ID` and `HAFI_GMAIL_CLIENT_SECRET` from that same client. Hafi listens on `127.0.0.1` using a random available port for the browser callback, so a **Web application** OAuth client with a fixed authorized redirect URI will produce `redirect_uri_mismatch`. If you already created a Web application client, create a Desktop app client and use its new ID and secret before rerunning `hafi connect gmail`. Do not register a fixed redirect URI for the Desktop app client.

While the Google OAuth app is in **Testing**, open [Google Auth Platform > Audience](https://console.cloud.google.com/auth/audience), add the exact Google account you will authorize under **Test users**, and use that account in the browser when running `hafi connect gmail`. Google otherwise shows `Error 403: access_denied` and says the app is available only to developer-approved testers. In Testing, Google expires this authorization and its refresh token after seven days, so reconnecting will be necessary for continued scheduled use.

Lark's default chat listing returns groups. Its user-identity API also documents `types=p2p,group` for one-to-one and group chats; Hafi requests both. Live account permissions and coverage still need end-to-end verification. See the [Lark CLI API reference](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-list.md).
