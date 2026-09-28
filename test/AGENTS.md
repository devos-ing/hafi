# Verification

- Focus new tests on the user-visible CLI flow, preferably through the compiled binary and real services when credentials are available.
- Keep tests few and meaningful. Avoid mock frameworks and tests that repeat implementation details.
- If a live end-to-end path cannot run, report exactly which integration remains unverified. Add a focused invariant test only when that failure cannot be checked cheaply through the CLI.
