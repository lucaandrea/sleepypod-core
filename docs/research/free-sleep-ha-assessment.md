# Free Sleep HA compatibility review

Reviewed 2026-10-30 against
[`DaSonOfPoseidon/free-sleep-ha` at b390441b](https://github.com/DaSonOfPoseidon/free-sleep-ha/tree/b390441b3e27483b17598ec12c0950e7d891ca58)
and this fork's Core API, MQTT discovery and native HomeKit bridge. The upstream
component declares version 0.1.0 and is MIT licensed.

## Decision

Keep Core's native MQTT integration and add a dedicated Home Assistant dashboard.
The upstream project is useful for installations running the original Free Sleep
API, but it is not a drop-in integration for this authenticated Sleepypod Core
fork. No upstream code is copied or installed by this change. Its per-side
dashboard and history organization informed an independently authored layout
using built-in Home Assistant cards.

| Area | Upstream evidence | Core integration decision |
| --- | --- | --- |
| Connection | `api.py` constructs HTTP from host/port; `config_flow.py` has no connection-key field; requests do not add Bearer authentication. | Preserve Core authentication; use the existing MQTT connection. |
| Device API | Calls legacy `/api/deviceStatus`, settings, schedules and metrics paths. | Do not add a broad legacy compatibility surface just to support a second client. |
| Dashboard | Separate side controls, presence/vitals/history and a custom web card. | Add Tonight and Signals views over existing MQTT entities, with authenticated app links for controls. |
| Routines | Legacy schedule service payloads write the Free Sleep weekday schema. | Keep Core's overnight day ownership and concurrency checks; open Core's routine editor. |
| System services | Includes priming, alarm tests, service changes, jobs and raw execute. | Keep those out of the household dashboard; preserve scoped commands and attended qualification. |
| Homebridge | This repository is a Home Assistant custom component, not a Homebridge plugin. | Use native Core HomeKit alongside existing Homebridge, plus the bedroom sensor publisher. |
| Learning and remote access | No new Autopilot model or remote relay is provided by this component. | These remain separate Core/native-app workstreams. |

Primary reviewed sources:

- [API client](https://github.com/DaSonOfPoseidon/free-sleep-ha/blob/b390441b3e27483b17598ec12c0950e7d891ca58/custom_components/free_sleep_local/api.py)
- [Configuration flow](https://github.com/DaSonOfPoseidon/free-sleep-ha/blob/b390441b3e27483b17598ec12c0950e7d891ca58/custom_components/free_sleep_local/config_flow.py)
- [Service definitions](https://github.com/DaSonOfPoseidon/free-sleep-ha/blob/b390441b3e27483b17598ec12c0950e7d891ca58/custom_components/free_sleep_local/services.yaml)
- [Custom card](https://github.com/DaSonOfPoseidon/free-sleep-ha/blob/b390441b3e27483b17598ec12c0950e7d891ca58/frontend/free-sleep-card.js)

## Delivered surface

[Dashboard installation and connection directions](../../integrations/home-assistant/dashboards/README.md)
document entity mapping, existing authentication, signal meanings and rollback.
The dashboard monitors existing data and does not expand actuator access. It
works without a Pod service restart or a Home Assistant custom-component restart.

Deployment evidence must separately establish MQTT connection/discovery, resolved
entity IDs, current Homebridge source readings and native HomeKit pairing. A
paired bridge does not establish a successful physical command. Missing HomePod
exports, unavailable vitals, remote access and MQTT actuator qualification must
remain explicit rather than being marked complete by installing the dashboard.
