# Build identity under container ownership

The first ERP-01 and ERP-02 remote runs rejected Git ownership inside the Playwright container and emitted `unknown`, correctly failing all 12 revision assertions. The build now scopes `safe.directory` to its current checkout for that single read-only Git invocation. It changes no user or global Git settings and retains `unknown` for source archives without Git metadata.

Reproduction: `GIT_TEST_ASSUME_DIFFERENT_OWNER=1 git -c safe.directory= rev-parse HEAD` failed with the same ownership error. `GIT_TEST_ASSUME_DIFFERENT_OWNER=1 pnpm build` after the fix emitted the actual 40-character parent revision. Remote reruns will validate the committed head.
