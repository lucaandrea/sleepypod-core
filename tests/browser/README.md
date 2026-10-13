# Calibration browser checks

Build the production application with hardware startup disabled, install the locked
Python runtime and Chromium, then run the isolated browser suite:

```sh
uv sync --locked --no-install-project --project modules/piezo-processor
CI=1 pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

The runner creates new configuration and biometrics databases in a private temporary
directory, applies both migration sets, and seeds normal device defaults plus a
synthetic ten-minute recorded session. It overrides caller database paths. Playwright
starts the standalone production server on loopback port 3218 with `CI=1`, which
disables hardware/service instrumentation. It refuses to reuse a server already
running on that port. Fixture databases are removed after the suite exits.
No request interception, demo transport, or mocked router is used.

Coverage:

- Review and save a numerical candidate through the UI and real tRPC API, assert the
  exact new SQLite revision, and reload to verify the persisted revision is displayed.
- Submit an out-of-range parameter, observe the server's validation error in the UI,
  and verify no revision was inserted. tRPC streaming batch errors use HTTP 200.
- Import a reference, save a candidate, freeze the recorded session with its reference,
  save a stage-replay protocol, queue and execute the real packaged worker, and view
  the report. Check that execution does not change stored vitals or active bindings.
  Explicitly request unvalidated manual application, verify pending delivery, run the
  shipped Python and stage consumers, verify acknowledgement, and roll back to the
  previous defaults. Verify acknowledgement again and preserve the other side.

`fixture.ts` supplies data and runs consumers normally hosted by background services.
Its replay admission is test-only and unmeasured; the Python runtime sees a single
synthetic empty-bed frame without a daemon, DAC transport, or hardware commands.
The report must say evidence is insufficient for validated improvement. This suite
checks the manual workflow, not waveform accuracy, qualified holdout promotion,
continuous live processing, or target-pod resource budgets.

CI runs these tests in the Browser Tests matrix entry. JUnit results, failure
screenshots, and successful report/rollback screenshots are written under
`test-results/browser` (ignored) and uploaded as CI artifacts.
