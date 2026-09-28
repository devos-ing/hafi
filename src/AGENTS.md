# Source code

- Validate unknown input and third-party responses with Zod at the boundary. Infer types from schemas; avoid `any` and unchecked casts for untrusted data.
- Prefer concrete functions and small interfaces that have multiple real implementations. Keep the flow easy to follow.
- Give each function a one-sentence comment describing its purpose or invariant.
- Keep structured `--json` output and cron output free of presentation formatting. Preserve the local-only draft and no-send behavior.
