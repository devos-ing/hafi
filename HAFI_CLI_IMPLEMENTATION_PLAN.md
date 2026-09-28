# Hafi CLI implementation plan

Status: implementation plan, 28 September 2026. Reviewed with GPT-6 Astra at xhigh reasoning. [Workflow example](./hafi.workflow.example.yaml). Earlier notification concepts have been superseded by this local draft workflow.

Implementation finding: Lark's user-identity chat list documents `types=p2p,group` for direct and group chats; the default is group-only. The adapter should request both types. The requested all-personal-chat scope still needs live permission and coverage checks before release. [Lark CLI API reference](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-list.md).

## Finish line

One downloadable local TypeScript and Bun CLI reads new messages from a connected Gmail or Lark account, asks Jev what needs a personal reply, runs the next action named in a YAML workflow, and saves the result locally. The first action generates a reply draft with the selected local Codex CLI. The user reviews it through Hafi or their Codex or Claude Code IDE and sends the reply in the original app.

System cron starts `hafi run-once --workflow <file> --json` every five minutes. That scheduled one-shot process is the background worker; Hafi needs no permanent daemon. `hafi status --workflow <id> --json` shows whether the schedule has kept up. First release supports Gmail and Lark intake, one Jev filter, and the `save_reply_draft` action. It sends no message or notification. Claude as a runtime composer, native source drafts, automatic sending, and Web UI work follow after the live path works.

## Small architecture

```text
Codex or Claude Code IDE ──> hafi onboarding commands
cron or terminal ──────────> hafi run-once --workflow hafi.yaml
                                    |
                               WorkflowRunner <──> local SQLite
                                    |
                            GmailSource or LarkSource
                                    |
                               JevTriageBot
                                    |
                             save_reply_draft action
                                    |
                                Codex CLI
                                    |
                         private local draft result
```

Use one small `InboxSource` interface with Gmail and Lark implementations. Both return the same `InboxItem`. Use a concrete `WorkflowRunner`, a concrete Jev evaluator, and a simple action switch keyed by the YAML action type. Do not build a DAG engine, arbitrary script runner, action plugin registry, or source inheritance tree. The workflow format provides reuse without those layers.

The core returns data and never prints or calls `process.exit`. `src/cli.ts` owns terminal formatting. A later Web UI can call the same core through a local HTTP handler.

## Files and functions

Keep the first implementation to these eight source files. Give each exported function a one-sentence comment describing its job or invariant. Avoid comments that merely repeat the function name.

| File | Function or method | Short description |
| --- | --- | --- |
| `src/cli.ts` | `main()` | Parse one Hafi command and render one human or JSON result. |
| `src/cli.ts` | `printCronSchedule()` | Print a cron entry using absolute binary, workflow, and log paths. |
| `src/workflow.ts` | `loadWorkflow()` | Parse YAML with Bun and reject unknown fields or unsupported action types with Zod. |
| `src/workflow.ts` | `initWorkflow()` | Write a small reusable YAML example for the selected source. |
| `src/gmail.ts` | `connectGmail()` | Complete read-only Gmail OAuth and store refresh credentials privately. |
| `src/gmail.ts` | `fetchNew()` and `load()` | Read new Gmail IDs and normalize one message with bounded thread context. |
| `src/lark.ts` | `connectLark()` | Complete Lark user authorization and store refresh credentials privately. |
| `src/lark.ts` | `fetchNew()` and `load()` | Read new direct and group messages visible to the user and normalize them. |
| `src/jev.ts` | `evaluateWithJev()` | Return a bounded reply-needed probability and served model version. |
| `src/actions.ts` | `executeAction()` | Dispatch one allowlisted YAML action with a small switch. |
| `src/actions.ts` | `composeWithCodex()` | Run `codex exec` with bounded prompt, runtime, and structured output. |
| `src/core.ts` | `runOnce()` | Load the workflow, claim a lease, ingest new messages, process due work, and return a summary. |
| `src/core.ts` | `processWork()` | Evaluate one message, run its selected action, and persist the outcome. |
| `src/state.ts` | `queueAndAdvance()` | Insert message references and the new cursor in one SQLite transaction. |
| `src/state.ts` | `saveDraftResult()` | Save one private reviewable draft and mark its work item complete. |
| `src/state.ts` | `withRunLease()` | Prevent overlapping cron runs and renew the lease during slow calls. |
| `src/state.ts` | `status()` and `results()` | Report local health and selected messages to the CLI or an IDE. |

Add `package.json`, strict `tsconfig.json`, `.gitignore`, [example workflow](./hafi.workflow.example.yaml), and a short setup README. Keep the database, credentials, logs, and temporary Codex files outside the repository. The workspace currently has design notes only, so there are no existing project packages to reuse.

## Commands in the first release

```text
hafi init --source gmail --workflow hafi.yaml
hafi connect gmail
hafi connect lark
hafi workflow validate hafi.yaml --json
hafi doctor --workflow hafi.yaml --json
hafi run-once --workflow hafi.yaml --dry-run --json
hafi run-once --workflow hafi.yaml --json
hafi results --workflow reply-review --json
hafi status --workflow reply-review --json
hafi schedule print --workflow hafi.yaml --platform cron
hafi help --json
```

`init` writes the YAML template and reports missing setup. Users can remove either source from that file. Browser consent remains a user step even when a Codex or Claude Code IDE runs the command. `--dry-run` checks recent new items with Jev without advancing cursors or writing drafts.

`--json` writes one object to stdout; diagnostics go to stderr. Preserve stable exit codes for configuration, source, Jev, and action failures. `hafi help --json` describes argument shapes, side effects, and sensitive outputs so coding agents can call Hafi directly. `results` and `status` read local state; `run-once` writes a local draft when the workflow matches.

### Onboarding through Codex or Claude Code

After the user downloads Hafi and puts the binary on their PATH, a coding IDE agent can follow this prompt:

> Run `hafi help --json`. Create a Gmail or Lark workflow with `hafi init`, then run the matching `hafi connect` command. Let me complete browser authorization. Validate the YAML, run one dry-run, and show me the cron entry from `hafi schedule print`. Keep credentials out of the prompt and terminal transcript.

The agent needs no Hafi-specific plugin. OAuth and any secret entry remain local interactive steps. The same commands work when a person types them directly.

Cron invokes the installed Hafi binary with `run-once --workflow <absolute-path> --json` every five minutes. `hafi schedule print` prints an entry with absolute binary, workflow, and log paths; the user or IDE agent installs it. A local job runs only while the computer is awake and credentials are available; `status` makes a stale last-success time visible. A launchd print option can follow. The installed Bun 1.3.8 has no `Bun.cron`, so use the operating system's cron without an npm scheduler package.

## Download and reusable workflow

Develop with Bun, then build a standalone executable with `bun build --compile ./src/cli.ts --outfile ./dist/hafi --no-compile-autoload-dotenv --no-compile-autoload-bunfig`. Bun includes its runtime and imported packages in the executable. Start with a tested macOS build, a versioned download, checksum, and short installation instructions. Do not build an auto-updater. Verify the Gmail and Lark SDKs inside the compiled binary before publishing it. [Bun executable guide](https://bun.com/docs/bundler/executables).

The user or IDE agent creates [hafi.workflow.example.yaml](./hafi.workflow.example.yaml) with `hafi init`. The YAML names account aliases, a schedule, one Jev question and threshold, and one allowlisted action. Parse it with `Bun.YAML.parse`, then validate it with Zod. Bun 1.3.8 provides the YAML parser, so no YAML package is needed. The first action is `save_reply_draft`: use the selected local composer and save the text to private local results. Reject unknown action names. Do not run shell snippets, JavaScript expressions, remote includes, or executable templates from YAML. [Bun YAML guide](https://bun.com/docs/runtime/yaml).

For the first schema, accept `schedule.every_minutes` values of 1, 2, 5, 10, 15, 30, or 60 and exactly one action. A later schema version can add action sequences. An account alias refers to local OAuth credentials rather than storing secrets in YAML, so the same workflow file can be moved to another machine after that user connects the account.

## Packages and plugins

| Type | Use in implementation | Decision |
| --- | --- | --- |
| npm runtime | [`googleapis`](https://github.com/googleapis/google-api-nodejs-client) | Use Google's official OAuth and Gmail client. |
| npm runtime | [`@larksuiteoapi/node-sdk`](https://github.com/larksuite/node-sdk) | Use the official Lark SDK for user-authorized personal-chat reads; select the Lark domain explicitly. |
| npm runtime | [`zod`](https://zod.dev/json-schema) | Validate the YAML workflow and reply JSON, and generate one JSON Schema for Codex. |
| Development | `typescript`, `@types/bun` | Run `bunx tsc --noEmit`; Bun does not type-check execution. |
| Bun built-ins | `Bun.YAML.parse`, `fetch`, `bun:sqlite`, `Bun.secrets`, `Bun.spawn`, `bun:test`, `node:util.parseArgs`, `bun build --compile` | Use these instead of YAML, ORM, keyring, process, CLI, or scheduler packages. |
| Codex plugin | Gmail connector is installed in this Codex session. | Optional for inspecting an approved test mailbox during development. The downloaded Hafi executable cannot call it from cron. |
| Codex plugin | No Lark or Jev connector appeared in plugin search. | Use their official SDK or HTTP API; no new plugin installation is needed. |
| Optional later | Claude CLI, [`@typesafe-ai/sdk`](https://github.com/typesafe-ai/typesafe-sdk-js), Web UI packages | Add only when a second composer, larger Jev use, or browser interface requires them. |

The local Codex CLI is installed and supports `exec`, read-only sandboxing, ephemeral sessions, output schema, and final-message output. The [official non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode) documents these flags. A workflow with `save_reply_draft` and `composer: codex` requires Codex CLI on the machine running cron. Claude Code can still help onboard Hafi from its IDE without being installed as Hafi's runtime composer.

`ReplyDraftBot` passes the bounded prompt to Codex on stdin and invokes `codex exec -` with `--sandbox read-only`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, `--cd <empty-temp-dir>`, `--output-schema <schema-file>`, and `--output-last-message <result-file>`. It validates the result, records only draft status, and deletes both temporary files. The read-only sandbox limits edits; this is a trusted local pilot, so the plan does not claim tool-free model execution.

Development skills are separate from plugins: use Ponytail to keep code small, Codebase Design for the source seam, and OpenAI Docs when checking Codex CLI flags. The Gmail connector can help with an approved smoke test. Hafi's scheduled process depends on none of these Codex-side capabilities.

## Delivery slices

1. **Onboard and parse.** Build the CLI entry point, YAML template and validator, secure credential store, Gmail OAuth, and `--json` command contract. An IDE agent can run `hafi init`, then the user can authorize Gmail.
2. **Finish one real workflow.** Add Gmail polling, Jev, the Codex-backed `save_reply_draft` action, SQLite cursors and results, and `run-once`. One new reply-worthy Gmail message becomes one private local draft.
3. **Meet the source choice.** Add Lark user authorization and personal-chat reads through the same small source interface. The same YAML action works with either account without changing the Jev or draft code.
4. **Schedule and distribute.** Print a cron entry, build the standalone binary, and run the compiled-binary end-to-end check for both advertised sources. Confirm a repeated run creates no duplicate result.

Do not add arbitrary script actions, Claude runtime composition, a background daemon, or a Web UI during these slices.

## State and failure decisions

- Key each cursor by `(workflow_id, provider, account)` and each work item by `(workflow_id, provider, account, message_id)`. One workflow must not consume another workflow's inbox position.
- On first activation, save Gmail's current `historyId` and activation time. Do not treat the old inbox as new mail. Establish a per-chat baseline for Lark. [Gmail profile reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile).
- Read all pages from Gmail `history.list` before committing its replacement cursor. On an expired cursor, rescan from the saved last-success time with an overlap, never from the entire old mailbox. Deduplicate by message ID. [Gmail sync guide](https://developers.google.com/workspace/gmail/api/guides/sync).
- Group new items by conversation and evaluate its latest state. Suppress an obsolete request when the owner already replied. Record each consumed message ID.
- Save references and cursor together in SQLite. Save the selected action and workflow revision with queued work so a YAML edit cannot silently change a retry. Refresh the run lease while source, Jev, or Codex calls are in flight.
- Keep the application directory private (`0700`) and database and draft files user-only (`0600`). Store OAuth tokens and API keys in `Bun.secrets`; log counts and error codes. The selected reply draft is intentionally stored as a local result so the user or IDE can review it later.
- Bound the whole Codex prompt, including every context message. Pass it on stdin to `codex exec`; use a private temporary directory, read-only sandbox, ephemeral session, output schema, runtime limit, and output limit. Remove temporary files in `finally`.
- If source, Jev, or Codex fails, keep the work item retryable and surface the error in `status`. Save the draft and mark the action complete in one transaction. A repeated cron run must not duplicate the local result.

## One end-to-end check

Use one live procedure, once with a Gmail test account and once with a Lark test account. It exercises the compiled binary, real provider reads, Jev, Codex, SQLite, and cron execution. Do not build a fake provider framework or per-function mock suites.

1. Download the compiled Hafi binary, create the YAML workflow, connect the chosen account, and run `hafi doctor --workflow <file> --json`.
2. Run `hafi run-once --workflow <file> --json` to establish the initial cursor. Expect no old-inbox result.
3. Deliver one controlled reply-worthy message from another account: an email for Gmail or a direct chat for Lark. Use a unique subject or text marker.
4. Run `hafi run-once --workflow <file> --dry-run --json`. Confirm a Jev match without cursor movement or saved result.
5. Run normally. Confirm one result with the source reference, Jev probability and model, nonempty local reply draft, and any unresolved facts. Review it through `hafi results --workflow <id> --json`.
6. Run again. Confirm no duplicate result and a healthy `hafi status --workflow <id> --json`.
7. Execute the printed cron command under the normal user account. Confirm that secure credentials and the chosen local composer work outside the interactive IDE shell.

Also run `bunx tsc --noEmit`. If the accounts or credentials are unavailable, keep the live path marked unverified; do not replace it with a large mocked suite.
