# Telegram personal-account source plan

Status: design plan, 29 September 2026. No Telegram implementation has been added.

## Scope

Add a Telegram source for the user's own private chats and groups. The first version reads new text messages only. In groups, it considers messages that mention the account or reply to one of its messages. It excludes broadcast channels, media-only messages, and Secret Chats. Hafi saves reply suggestions locally and never sends Telegram messages.

This requires a Telegram user session through MTProto. A Bot API token sees the bot's conversations, not the user's ordinary inbox. Telegram requires an `api_id` and `api_hash` for a user client, and login may ask for a phone number, code, and two-step verification password. The saved session is a full account credential, not a read-only grant. [Telegram app setup](https://core.telegram.org/api/obtaining_api_id), [user authorization](https://core.telegram.org/api/auth), [Bot FAQ](https://core.telegram.org/bots/faq).

## Release gate

Hafi currently sends source content to Jev and Codex. Telegram's [API terms](https://core.telegram.org/api/terms) and [content licensing terms](https://telegram.org/tos/content-licensing) restrict using platform data with AI systems and describe a narrow consent exception. Confirm that Hafi's intended message processing is permitted before routing Telegram content to either service or shipping this source. If that cannot be established, stop the Telegram source release; a successful login alone does not clear this gate.

## Implementation sequence

1. **Check the client library in the shipped runtime.** Try the maintained [teleproto](https://github.com/sanyok12345/teleproto) client in Bun and a compiled Hafi binary. Verify login, saved-session reuse, `updates.getDifference`, group updates, and clean process exit. Do not add the dependency until that check passes. The older [GramJS repository](https://github.com/gram-js/gramjs) is archived.
2. **Add account connection.** Extend `hafi onboard` with `Connect Telegram? [y/N]` and add `hafi connect telegram`. Read `HAFI_TELEGRAM_API_ID` and `HAFI_TELEGRAM_API_HASH` at connection time. Prompt locally for the phone number, login code, and two-step password when required. Never echo the code or password. Save the session and app credentials under the account alias in `Bun.secrets`; keep them out of YAML, JSON output, and logs. Verify the account before reporting `connected: true`. Make `doctor` check the saved session.
3. **Wire one source adapter into the existing interface.** Add `telegram` to the workflow provider schema, CLI choices, `doctor`, and the source selection in `src/core.ts`. Implement `src/telegram.ts` behind the existing `InboxSource.fetchNew()` and `load()` interface. Keep Telegram transport, login, synchronization, and message normalization inside that file. The runner and draft action need no Telegram-specific branch.
4. **Make polling loss-aware.** On first activation, save Telegram's current common update state and each selected supergroup's state, and create no work from older chats. On later `run-once` calls, fetch offline updates with `updates.getDifference`; consume every `differenceSlice` and the indicated supergroup differences before returning the new cursor. On `differenceTooLong`, do a bounded recovery from the last successful time and record a visible sync-gap code if complete recovery is impossible. Queue message references and advance the cursor together in SQLite. Close the MTProto connection so the one-shot cron process exits. [Telegram update guide](https://core.telegram.org/api/updates).
5. **Preserve message identity and reply context.** Telegram message IDs can repeat across chats. Change the `work_items` uniqueness key to include the chat ID, with a migration that preserves existing Gmail and Lark work. Use chat and topic or reply-root IDs for conversation grouping. Load at most 12 relevant context messages, distinguish the account's own messages, and detect a later reply in the same conversation. For group intake, include only direct mentions or replies to the account. Omit a message URL when a stable link cannot be formed.
6. **Verify the end-to-end path.** Test login and code/password cancellation on Telegram's test servers, then run the compiled binary against an authorized test account. Confirm that first activation imports no old chat, a new private message and a group mention each produce one local result, an unrelated group message produces none, a repeat run creates no duplicate, a reply by the owner suppresses a draft, and an offline interval is recovered. Check that Hafi never sends a Telegram message or silently changes message read status. Keep the existing Gmail and Lark checks green.

## Delivery condition

Ship only after the terms gate, compiled-runtime check, and live account checks pass. Until then, `onboard` should not offer Telegram as a working source.
