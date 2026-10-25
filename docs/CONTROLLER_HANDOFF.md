# Controlled first-installation handoff

The unified installation keeps Free Sleep's code, data, Python environment,
Node runtime, service definitions and dedicated SSH in place. The upstream
installer and purge are not part of this path. Core uses separate directories
under `/persistent/sleepypod-unified/` and its pinned private Node runtime.

```mermaid
flowchart LR
  Plan[Review exact paths and generated services] --> Install[Install absent units only]
  Install --> Legacy[Free Sleep remains active and boot default]
  Legacy --> Stop[Stop both legacy writers and verify exit]
  Stop --> Trial[Start Core and check authenticated fresh telemetry]
  Trial --> Restore[Stop Core and its sensor processes]
  Restore --> Return[Restart retained Free Sleep]
```

## Prepare before any service action

1. Complete the [offline runtime and dependency probes](OFFLINE_POD_STAGING.md).
   Verify every release file against its bundle manifest after transfer. Keep
   the exact source archive and source commit with the release. The service
   tool does not repeat full bundle verification.
2. Before stopping writers, run the importer's `--check-timezone` for the source
   settings timezone in its locked migration environment (see
   [offline migration](FREE_SLEEP_MIGRATION.md)). Then take the reviewed quiesced
   migration backup and import it into a new data
   directory. Review routines, current temporary overrides and alarm behavior.
   Keep Core's adaptive comfort Off or Preview and house/base automations off.
   Imported calibration remains pending actual empty/occupied qualification.
3. Put the already-probed Python modules and environments in their own directory.
   Ensure their project/lock/source identities match the reviewed release.
   These templates are specifically for a **verified NATS installation**. They
   run the four NATS-capable processors. The RAW-only cover-buttons observer is
   not started or claimed to work on that feed.
4. Give `dac` read/execute access to the release and Python directories and
   ownership of the separate data directory. Preserve root ownership of code;
   do not recursively change the retained Free Sleep installation. Keep the
   owner environment root-owned, mode 0600, outside the data/source directories.
5. Record the working Free Sleep authenticated status, service identities,
   filesystem permissions and private recovery artifacts. Keep a second SSH
   session available for the attended trial. Review the exact services first.

The services run as the existing `dac` user. Sensor writers can write only the
new data directory; the controller also needs its inspected DAC directory.
System maintenance, firewall changes and privileged self-updates are not granted
by these templates. Those operations need their own reviewed integration.
The Python services do not receive the controller's credential environment.

Example configuration (replace revision and paths with the verified artifacts):

```json
{
  "release": "/persistent/sleepypod-unified/releases/REVIEWED_REVISION",
  "modules": "/persistent/sleepypod-unified/sensors/REVIEWED_REVISION/modules",
  "data": "/persistent/sleepypod-unified/data",
  "environment": "/persistent/sleepypod-unified/controller.env",
  "dacSocket": "/persistent/deviceinfo/dac.sock",
  "rawData": "/persistent"
}
```

`controller.env` contains an unquoted, securely random URL-safe
`SLEEPYPOD_AUTH_TOKEN` of at least 32 characters and the reviewed host/HTTPS
settings from [owner access](OWNER_ACCESS.md). Never put the key in the plan,
command line, source, report or screenshots. The service manager loads it for
the controller; the handoff tool reads it only for a loopback HTTP request.

## Render and install without starting

```sh
python3 scripts/deployment/service_plan.py \
  --config /private/reviewed-paths.json --output /private/new-service-plan
```

This command only writes a new private plan directory. It validates canonical
paths and separates source, modules, data and credentials. Review its five unit
files and transfer the plan privately to the Pod. As root on the Pod:

```sh
python3 handoff.py install --plan /private/new-service-plan
```

Installation refuses existing units, unit aliases and a previous journal. It
records original unit/drop-in hashes and enablement, writes only absent Core
units and reloads systemd. It **does not start or enable anything**. A partial
installation leaves a journal and never silently overwrites or deletes files;
inspect its recorded creations before recovery. Keep `handoff.py`,
`service_plan.py` and `prepare_offline.py` together, from the reviewed commit.

## Replace an inactive release plan

For a newer verified release after a stopped trial, render a **new** plan with
the same data, credential, socket and RAW paths, then replace only the managed
unit files:

```sh
python3 scripts/deployment/replace_plan.py \
  --previous-plan /private/previous-service-plan --plan /private/new-service-plan
```

Both plans are locked against concurrent handoffs. Core must be stopped and
disabled and Free Sleep active and enabled. Original unit hashes and settings
are checked before replacement. A partial write failure restores the previous
unit files; unrelated edits require review. Neither installation is started or
enabled by this command. Keep both plans and immutable release directories.

## Bounded attended trial and rollback

```sh
python3 handoff.py trial --plan /private/new-service-plan --seconds 120
```

The trial requires both original services active/enabled and every Core service
stopped/disabled. It verifies the installed templates and rejects new drop-ins
or changed legacy units. It stops the original writers, confirms their main
processes exited, then starts Core. Conflicts and ordering also enforce ownership
inside systemd; stopping Core stops its related sensor services.

The tool waits **up to** the deadline for authenticated capabilities to identify
the exact staged build and a fresh device report. It then stops all Core units
and restores Free Sleep, including on startup failure, stale telemetry or an
ordinary interruption. It never changes boot enablement. A machine power loss
therefore still boots the original enabled services. A process kill that cannot
be caught, changed unit definitions or an OS/service-manager failure can still
require manual recovery; the durable journal records the last completed phase.

```sh
python3 handoff.py status --plan /private/new-service-plan
python3 handoff.py rollback --plan /private/new-service-plan
```

Rollback stops verified Core units before starting the unchanged original
services. It refuses to operate on an unrelated replacement unit. If original
configuration changed, it stops the verified Core processes and leaves a clear
error instead of overwriting that change. No databases are copied over active
writers. Follow recovery with authenticated Free Sleep status and the attended
physical checks; an active process alone does not prove restored thermal control.

`handoff.json` distinguishes trial success, restoration and physical verification.
It contains no owner key or health measurements. A trial establishes neither
permanent migration nor seven Preview nights. Final activation, private proxy,
sensor calibration, base/Stop, vibration/cancellation and overnight acceptance
remain separate work.

## Validation

The deployment test suite exercises unsafe paths, altered/rehashed plans,
existing units, service-stop and startup failures, stale observations,
interruptions, secret-file permissions, changed units and journal recovery.
It verifies that no outgoing process can remain when the other controller
starts and that trials never change boot selection. Run:

```sh
python3 -m unittest discover -s scripts/deployment -p 'test_*.py' -v
```

On 25 October 2026, a separate live sensor-only probe used fresh isolated
databases and the four NATS processors for 90 seconds. All four remained alive
and exited cleanly; both databases passed integrity checks and the original
Free Sleep/stream/firmware process IDs stayed unchanged. Sensor rows were
produced, but occupancy labels and vital accuracy were not independently
verified. This sensor evidence does not substitute for the controller trial.
