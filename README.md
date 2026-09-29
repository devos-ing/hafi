# Hafi

**Go hands-free.** Hafi is a local CLI that finds new messages that may need your reply and saves a suggested draft for review. You send replies in Gmail or Lark yourself. Hafi does not send messages or notifications.

Hafi is in early development. Run it from source with Bun 1.3 or later; there is no release binary yet. Gmail and Lark adapters are implemented, but live provider coverage still needs verification. The [public docs](https://hafi-go-hands-free-docs.free-hero-8440.chatgpt.site) introduce the workflow; the [implementation plan](./HAFI_CLI_IMPLEMENTATION_PLAN.md) records the engineering detail.

## How to use

Install dependencies and make sure the Codex CLI is on your PATH:

```sh
bun install
bun run --silent dev help --json
```

Set the app credentials for each provider you want to connect in your shell:

| Provider | Environment variables |
| --- | --- |
| Gmail | `HAFI_GMAIL_CLIENT_ID`, `HAFI_GMAIL_CLIENT_SECRET` |
| Lark | `HAFI_LARK_APP_ID`, `HAFI_LARK_APP_SECRET`, `HAFI_LARK_REDIRECT_URI` |

For Gmail, [enable the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) in the project that owns your OAuth client. Create a [Desktop app OAuth client](https://console.cloud.google.com/auth/clients) and use its ID and secret together. Hafi uses a random loopback port for browser authorization, so a Web application client with a fixed redirect URI can fail with `redirect_uri_mismatch`. Do not register a fixed redirect URI for the Desktop app client.

If the Google OAuth app is in **Testing**, add the account you will authorize under [Google Auth Platform > Audience > Test users](https://console.cloud.google.com/auth/audience). Otherwise Google can return `Error 403: access_denied`. Testing-mode authorization and its refresh token expire after seven days; reconnect when that happens.

Run onboarding in a terminal. Choose Gmail, Lark, or both, and complete browser authorization. Onboarding writes a workflow only after the selected connections succeed.

```sh
bun run dev onboard --workflow hafi.yaml
bun run dev connect jev
```

Enter the Jev API key at the masked prompt. Hafi stores user tokens and the Jev key in the operating system credential store, outside the workflow YAML. If you already have a workflow file, skip onboarding and use `connect gmail`, `connect lark`, or `connect jev` as needed.

Validate and check your setup, then preview a run without advancing cursors or saving drafts:

```sh
bun run --silent dev workflow validate hafi.yaml --json
bun run --silent dev doctor --workflow hafi.yaml --json
bun run --silent dev dev --workflow hafi.yaml
```

Run once and review what happened:

```sh
bun run --silent dev run-once --workflow hafi.yaml --json
bun run --silent dev summary --workflow reply-review
bun run --silent dev results --workflow reply-review
```

The first normal run establishes a provider cursor and does not process older inbox messages. Later runs process new messages. `summary` reports run health, counts, skip reasons, and recent message references; `results` shows saved drafts. Both read local state. For Codex or Claude Code, use `bun run --silent dev summary --workflow reply-review --json` and ask it to explain the latest run. The JSON includes private message IDs and account aliases, but no message bodies or draft text.

### Run in the background

Hafi has no resident daemon. Your operating system can start the one-shot command on a schedule:

```sh
bun run --silent dev schedule print --workflow hafi.yaml --platform cron
crontab -e
```

Append the printed lines to your crontab without removing existing jobs. `schedule print` prepares a private log and prints an entry; it does not install it. Check `~/.local/share/hafi/cron.log` and `summary` after the first scheduled run. Cron runs while the computer is awake.

## Flow

1. Gmail or Lark supplies new message references. The first run sets a baseline; later runs save new references and the next cursor together in SQLite.
2. Hafi skips your own messages and conversations you already answered. Jev scores the rest against the question and threshold in your [workflow YAML](./docs/workflows.md).
3. A message below the threshold is marked skipped. A match asks the local Codex CLI for a bounded reply suggestion and saves it as a private draft.
4. `status` and `summary` report progress and failures. You review any draft with `results` and send the reply in the original app.

Failed work remains retryable. A run lease prevents overlapping scheduled runs from processing the same workflow at once. See [CLI architecture](./docs/architecture.md) for the state and provider boundaries.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
./dist/hafi help --json
```

`bun run dev <command>` runs the TypeScript source without watch mode. Use `bun run --silent dev <command> --json` when another program needs one JSON object on stdout without Bun's script banner. The compiled binary lives at `dist/hafi`.

## Contributing

Read [AGENTS.md](./AGENTS.md) and the scoped guidance in [src](./src/AGENTS.md), [test](./test/AGENTS.md), or [docs](./docs/AGENTS.md) before editing. Keep changes focused and update the relevant docs when a CLI or workflow contract changes. For provider or workflow changes, check the [implementation plan](./HAFI_CLI_IMPLEMENTATION_PLAN.md).

Run the development checks above before opening a pull request. Include what changed, how you tested it, and any live provider path you could not verify. Keep OAuth credentials, API keys, local state, and private drafts out of commits.

## More documentation

- [Example workflow](./hafi.workflow.example.yaml) for Gmail and Lark sources.
- [Workflow YAML](./docs/workflows.md) for fields and validation rules.
- [CLI architecture](./docs/architecture.md) for the local message flow.
- [Telegram source plan](./docs/telegram-source-plan.md) for planned personal-account intake.
