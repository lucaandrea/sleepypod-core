# Service restart contract

Device → Restart service uses authenticated `POST /api/health/restart-service`
with `{ "unit": "sleepypod.service" }`. It never invokes `/system/update`,
downloads a release, changes the selected version or reboots the operating system.
The existing three sensor-module targets remain supported. Other units and
command fragments are rejected before any process is started.

For Core, the server requests `sudo -n systemctl --no-block restart
sleepypod.service`. The non-blocking flag avoids waiting for the calling process
to terminate itself. The installer grants only this exact additional command,
with the two usual systemctl paths. Existing module commands are unchanged.

The response remains `{ ok: boolean, message: string }`:

- `ok: true` for Core means systemd accepted a queued request. It does not prove
  the service subsequently returned to health or that a hardware state changed.
- `ok: false` means the command failed, including missing permissions. HTTP
  success alone must not be presented as a successful restart.
- The connection can disappear during a restart. A lost response has an unknown
  outcome; clients should reconnect and read status before offering a retry.
  No automatic retry or fallback to the updater is permitted.

The web action requires confirmation, blocks duplicates while pending and shows
the returned outcome. After acceptance or an unknown outcome, the page requires
using Reconnect before another request. Demo responses explicitly identify simulated actions.
Router tests substitute the process runner; browser tests intercept mutations,
including the former updater route. They do not restart a real service.

## Isolated deployment qualification

The owner's retained Free Sleep controller continues running. Read-only inspection
on 25 October confirmed systemd supports `--no-block`, but the `dac` account is
not authorized for this restart command. The isolated Core service also retains
`NoNewPrivileges=true`, which prevents gaining privilege through sudo even if a
sudoers rule is added. The standard installer rule does not solve that isolated
runtime constraint.

Keep the restriction intact. A narrowly scoped supervisor mechanism and attended
restart/recovery qualification remain required before calling this action
operational on that deployment. The API reports failure rather than silently
running an update or claiming that the service restarted. No permission or Pod
service was changed by this source fix.
