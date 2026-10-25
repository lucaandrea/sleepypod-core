# Client capability discovery, v1

`GET /api/v1/capabilities` requires the existing owner Bearer credential or
browser session. It is also available as tRPC `capabilities.get({})` and is
included in `/api/openapi.json`. REST responses use `private, no-store`.

The read observes existing DAC, Bluetooth and MQTT state without starting a
connection, creating a controller or issuing a hardware command. Missing build
metadata returns a null revision; the recorded revision comes from `.git-info`.
The upstream baseline is v3.4.0, not a claim that the fork is an upstream release.

Each feature separates:

- `implemented`: the route/runtime integration exists in this revision.
- `runtime`: `ready`, `not_ready` or `unknown`, describing observed technical
  prerequisites. It is not permission to execute a command or a guarantee that
  the next command will succeed. Command handlers still perform their checks.
- `reason`: a machine-readable explanation; clients should tolerate new values.
- `physicalVerification`: `unverified` or `not_applicable`. No hardware-qualified
  state is advertised until a real qualification record is implemented.

Device observations expire after 15 seconds; base observations after 10 seconds.
`observedAt` and `expiresAt` are UTC ISO timestamps, separate from response
`generatedAt`. Missing, nonfinite, fractional, nonpositive or future timestamps
never become fresh. Cached device reports invalidated by a write/disconnect
remain stale even if their timestamps are recent. Reading an old report does not
refresh it. The controller's clock is authoritative; clients must stop treating
a saved response as current after its expiry or loss of connection.

Whole-bed base movement remains the only supported scope. Stop remains a
separate capability when connected, including stale-position, busy and unknown
motion states. Keep Stop visible; never infer successful stopping or movement
from HTTP success. Temperature, base and vibration remain physically unverified
on this Core fork, even when their technical prerequisites are ready.

`nativeCompatibility` remains null and its feature remains unimplemented: the
legacy `/api/native/v1/` adapter has not shipped. Personal comfort production
integration, room context and music vibration also remain unavailable. MQTT
connection alone does not imply that room inputs are connected or qualified.
Clients should decode the compatibility prefix as a nullable string and receipt
and expiry support as booleans; their current null/false values are not permanent
schema constants. Only enable a feature when this controller reports it.

The contract explicitly reports that current controls lack durable command
receipts and expiry envelopes. Do not retry uncertain actuator requests or
replay saved requests after reconnect. A successful acknowledgment means the
command was accepted, never that a physical outcome was verified. Versioned
control/measurement envelopes are separate pending work.
