# Unified Sleep foundation

This fork starts from stable v3.4.0 (`f8948b04586542fab1817aadc72b65a9c2988f8c`).
It remains AGPL-3.0; the existing license and upstream attribution are retained.
The separately implemented native companion is in https://github.com/lucaandrea/free-sleep.

## Implemented locally

- Owner authorization across REST, tRPC, raw data, exports, diagnostics and the live sensor socket. See [owner access](OWNER_ACCESS.md). General MCP and raw actuator passthrough default to disabled.
- Legacy Pod 4 capacitance profiles and frame quality/freshness checks, with incomplete readings treated as unavailable.
- Five primary destinations: Tonight, Sleep, Autopilot, Home, More. Existing detailed settings, diagnostics and base routes remain available. Shared blue/navy tokens come from `design/unified-tokens.json`; regenerate CSS with `node scripts/generate-unified-design.mjs`.
- Autopilot's persisted setting is loaded before timers start. Missing/unreadable settings and new installations default to disabled. Existing explicit settings survive the generated migration.
- Pure personal comfort learning and decision policy, with default 70–95°F limits, one-degree steps, 30-minute spacing, six-hour manual-pause semantics and explicit freshness/presence/water/artifact guards. Preview produces explanations without changing hardware. This policy is not yet connected to the production runtime.
- Passive policy proposals join the existing temperature authority without being erased by rule refreshes. Each producer owns its leases; failed freshness/consent guards revoke them, and the controller rechecks after transport recovery. Policy proposals cannot turn an off side on or extend a hardware duration.
- Next.js updated from 16.4.0 to 16.4.3 after review of the official October 14 security update and patch release notes.

## Validation

521 targeted tests passed across authorization, endpoint gates, streaming, occupancy,
navigation, startup settings and migrations. Changed TypeScript files pass ESLint.
The production build passes using Node 24 and pnpm 10.34.6. For the isolated build,
both SQLite databases were initialized/migrated before Next's parallel page workers;
the first attempt against new files hit WAL initialization contention.

The broader pre-push gate subsequently passed TypeScript, full ESLint, both Drizzle
schema checks and 3,507 related tests across 148 files. Authentication fixtures and
a rolling-date fixture were corrected; the piezo processor's locked uv environment
was installed for the Python integration test. API status/diagnostics now report
Autopilot disabled when settings are missing, matching the startup default.

The subsequent comfort policy/arbitration change passed 184 targeted tests across
the learner, shared controller, database-backed controller instance and rule engine.
These are deterministic software tests, not evidence of improved sleep outcomes.

Demo screens were inspected in the browser; they are labeled sample data and do not
operate a Pod. This is not deployment, hardware verification or an external security audit.
Production-browser checks reject an invalid synthetic connection key, accept a valid
local test key, and return to the connection gate after signing out. Real Pod credentials
were not used in these checks.

## Remaining integration gates

Production wiring for the personal comfort policy, native compatibility API, reversible Free Sleep importer,
Home Assistant room-context adapter, real notification delivery and hardware qualification
are still required. The Home screen describes the unconnected services honestly.
The comfort runtime must resolve actual routine windows (including DST and bedtime
shifts), persist learning cursors/manual pauses/acknowledgments, include the global
Autopilot opt-in in every lease guard and withdraw proposals in Off/Preview. None of
those requirements can be inferred from the pure policy tests.

The working Pod has not been switched to this fork. No base movement, vibration or new
automatic thermal action was issued. Preserve its installation and dedicated SSH service
through migration and restore testing. Seven actual Preview nights are required before
reviewing bounded activation; no nightly evidence is synthesized.
