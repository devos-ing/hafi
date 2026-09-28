# Hafi agent guidance

- Move quickly. Choose the smallest clear change that meets the request.
- Before writing a helper or adding a dependency, check nearby code, Bun, and maintained packages. Use available plugins for development work when they fit; the shipped CLI must run without them.
- Keep decisions and code simple. Remove one redundant element at a time and keep the removal when behavior and quality hold.
- For TypeScript changes, follow [src/AGENTS.md](src/AGENTS.md). For tests, follow [test/AGENTS.md](test/AGENTS.md). For docs, follow [docs/AGENTS.md](docs/AGENTS.md).
- For workflow or provider behavior changes, consult [HAFI_CLI_IMPLEMENTATION_PLAN.md](HAFI_CLI_IMPLEMENTATION_PLAN.md).
