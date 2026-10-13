# Calibration browser checks

Build the production application with hardware startup disabled, install Chromium,
then run the isolated browser suite:

```sh
CI=1 pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

The runner creates new configuration and biometrics databases in a private temporary
directory, applies both migration sets, and seeds normal device defaults. It overrides
caller database paths. Playwright starts the standalone production server on loopback
port 3218 with `CI=1`, which disables hardware/service instrumentation. It refuses to
reuse a server already running on that port. Fixture databases are removed after the
suite exits. Screenshots for failures remain under `test-results/browser` (ignored).
No request interception, demo transport, or mocked router is used.

Current coverage:

- Review and save a numerical candidate through the UI and real tRPC API, assert the
  exact new SQLite revision, and reload to verify the persisted revision is displayed.
- Submit an out-of-range parameter, observe the server's validation error in the UI,
  and verify no revision was inserted. tRPC streaming batch errors use HTTP 200.

These are candidate-editor flows. They do not yet cover the complete reference import,
backtest, activation acknowledgement, and rollback journey required by the calibration
implementation plan, or live processor/hardware behavior.
