<div align="center">
  <img src="assets/icon.svg" alt="LG Dev Mode Forever icon">
  <h1>LG Dev Mode Forever — No root required</h1>
  <p>LG Dev Mode Forever is a standalone webOS IPK that automatically resets the
  power-off counter with a controlled reboot and renews the official session —
  <strong>no root required</strong>.</p>
</div>

## Why this project exists

Your LG TV silently turns **Developer Mode** off after **11 real power-offs**
(reboots and standby do not count). Normally, the official startup script
clears this counter after successful online session validation. But **if
Wi-Fi is not ready at boot, that check is skipped**, so the counter can
accumulate even with a valid session. When that limit is reached, Developer
Mode is disabled, and the next boot removes all dev-installed apps.

## Contents

1. [Build & install](#build--install)
2. [Use & verify](#use--verify)
3. [Operational notes & limitations](#operational-notes--limitations)
4. [Failure modes](#failure-modes)
5. [How the firmware auto-disables dev mode (4 ways)](#how-the-firmware-auto-disables-dev-mode-4-ways)
6. [How this app works](#how-this-app-works)
7. [Appendix: clearing the counter with root](#appendix-clearing-the-counter-with-root)

## Build & install

Before installing:

1. Enable Developer Mode through LG's official Developer Mode app, and keep
   that app installed.
2. Have Node.js and the webOS CLI (`@webos-tools/cli`) available on your
   computer.
3. Configure the TV as a device in the webOS CLI so `ares-install` and
   `ares-launch` can connect to it.

```bash
./build.sh                   # node --check + ares-package -> IPK + Homebrew manifest
./build.sh --install [tv]   # + ares-install, then opens the app once
```

Replace `[tv]` with your configured device name, or omit it to use the
CLI's default device.

### Homebrew Channel

Install the community
[webOS Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel),
then open **Settings > Add repository** and enter:

```text
https://raw.githubusercontent.com/lennylxx/webos-homebrew/main/repository.json
```

Confirm **Add repository** on the TV. Return to the app list, select
**Dev Mode Forever**, and choose **Install**. Homebrew Channel can then
detect updates from later GitHub releases.

To prefill the repository URL from a computer configured with the webOS CLI,
run:

```bash
ares-launch --device tv org.webosbrew.hbchannel -p '{"launchMode":"addRepository","url":"https://raw.githubusercontent.com/lennylxx/webos-homebrew/main/repository.json"}'
```

> [!TIP]
> After installation, the watchdog runs automatically at every boot.
> You do not need to keep the app open.

## Use & verify

Open the app to see Developer Mode, Session token, Session remaining,
Power-off counter, Protection, and recent check/backup/extension/reset
times. A banner appears once the power-off counter reaches 8.

> [!WARNING]
> A counter reset **reboots the TV** — expect one controlled reboot per
> ~8 real power-offs. **Force toggle** can reboot it in seconds.
> The app normally triggers a reset at a counter of 8, with a persisted
> 24-hour cooldown between toggles.

| Action | What it does |
|---|---|
| **Check now** | Runs an immediate protection check; may trigger a counter reset if the threshold is reached and protection checks pass |
| **Extend session** | Renews the official Developer Mode session |
| **Force toggle** | Runs the counter reset; the TV reboots in seconds |

Opening the app also runs a check. For normal use, no manual action is
needed: the watchdog checks at every boot.

After a counter reset and reboot, confirm that Developer Mode is still on,
dev-installed apps survive, the session token is still 64 bytes, and the
counter is `dc0`.

## Operational notes & limitations

> [!IMPORTANT]
> **Keep the official Developer Mode app installed.** With its
> `start-devmode.sh` missing, the first real power-off disables Developer Mode.
> **Never modify** `start-devmode.sh`, `start-devmode.sig`, or `pub.pem`.

- The counter advances on **real power-offs only**: keep Quick Start+ on and
  use the standby button. Long-press power / Quick Start+ off counts.
  Reboots — including those triggered by a counter reset — never count.
- The 1000 h session countdown is independent of the shutdown counter. Dev
  Mode Forever displays the remaining time and renews the session on demand,
  at service startup when fewer than 7 days remain, and before every manual
  or threshold-triggered counter reset. There is no separate periodic timer.
- A valid official session token and network connection are required for
  renewal and the pre-toggle protection checks. No account password is
  stored or sent by Dev Mode Forever.

> [!NOTE]
> The official startup script compares its saved login version with the
> installed Developer Mode app version before restoring `sessionToken`.
> Behavior across an automatic official app update still needs verification.

## Failure modes

- **Token missing or invalid** — the app reports the error and does not
  toggle.
- **Official session renewal fails** — the app reports the error and does not
  toggle. For a startup network race, see [Session time](#session-time).
- **Official backup or login validation fails** — the app reports the error
  and does not toggle.
- **Enable fails after disable was processed** — dev mode may be off with a
  reboot already under way. This is logged as `toggle.done ok=false`; the
  persisted 24-hour cooldown prevents an automatic retry loop.
- **Developer Mode is already off** — the app skips the toggle. Recover by
  re-enabling it through the official Developer Mode app.

Read the service log from the TV's shell:

```bash
cat /media/internal/devmodeforever/service.log
```

The log falls back to `/tmp/devmodeforever/service.log`.

## How the firmware auto-disables dev mode (4 ways)

### State model

Dev mode state = a set of files under `/var/luna/preferences/` (`/var` is
bind-mounted from emmc's `/mnt/lg/cmn_data/var`, persistent across reboots
and power cycles):

| File | Meaning |
|---|---|
| `devmode_enabled` | the flag and official 64-byte session token. `setDevMode(true)` recreates it as an empty file unless the token is restored |
| `dc0` … `dc10` | power-off counter. `dc0` written at enable time; each **real power-off** renames `dcN` → `dcN+1`; at `dc10` the counter and flag are deleted together (auto-disable) |

The dev-mode SSH jail **cannot write** to this directory
(`etc/jail_native_devmode.conf` only mounts `/var/tmp` and
`/var/run/luna-service2` rw) — the "prisoner" shell can't touch the flag or
the counter; only a real root shell can.

### A. Power-off counter — `shutdown.sh` POWEROFF branch (what this project targets)

`shutdown.service` is a oneshot whose `ExecStop` runs `shutdown.sh` (REBOOT vs
POWEROFF detected via `systemctl list-jobs`). The POWEROFF branch runs only
when systemd takes `poweroff.target` (a real power-off); the logic
(paraphrased — the firmware source is not redistributable):

- `devmode_enabled` exists and the Developer Mode app is installed (its
  `start-devmode.sh` present under
  `/media/cryptofs/apps/usr/palm/services/com.palmdts.devmode.service/`) →
  counter `dcN` with `N ≥ 10`: delete counter + flag (**auto-disable**);
  otherwise rename `dcN` → `dcN+1`; no counter file: `touch dc0`.
- `start-devmode.sh` missing (Developer Mode app uninstalled) → counter +
  flag deleted at the **first** power-off (auto-disable).

Consequences:

- Enable writes `dc0`; the **11th real power-off** after enabling finds `dc10`
  → dev mode off.
- **Reboots do not count** — the logic exists only in the POWEROFF branch.
- **Standby does not count either** (with Quick Start+ on): `sleepd`
  (decompiled) has two exits — `MachineSleep` → `nyx_system_suspend()` (kernel
  suspend; no `poweroff.target`, counter untouched) and
  `MachineForceShutdown` → `nyx_system_shutdown()` (real shutdown → counter
  +1). So with Quick Start+ on, the standby button never accumulates;
  long-press power / Quick Start+ off does count.

### B. Boot-time signature check — `devmode.sh`

At every boot while the flag exists, the Developer Mode app's
`start-devmode.sh` is sha512-verified against `start-devmode.sig` using
`pub.pem`:

- Missing or verification failure → flag + `dc*` + `devSessionTime` deleted,
  SSH jail torn down.
- `pub.pem` is verify-only (the private key is not on the device) → a modified
  script cannot be re-signed. **Never touch these three files
  (`start-devmode.sh` / `.sig` / `pub.pem`).**

### C. Session timer — the official 1000 h countdown

LG's docs say "dev mode is disabled after 50 h", but the test TV (33.31.69)
Developer Mode app UI shows a **1000 h countdown**. The rootfs contains no
such timer: the only `devSessionTime` references in the rootfs are `rm` lines
in the disable cleanup — the firmware only deletes that file, never reads it.
The countdown is maintained by the Content Store app
`com.palmdts.devmode(.service)` under `/media/cryptofs/apps/`.

The official service exposes `devSessionTimeStatus` for local countdown
queries and `resetSession` for renewal, as described in
[Session time](#session-time).

In the analyzed official package, the local status method returns zero when
the countdown expires, and the app's countdown callback only updates the
display; neither path disables Developer Mode. At boot, the official startup
script separately checks the existing token with LG's server. An explicit
`result: "fail"` removes the Developer Mode flag, counter, and saved session
time; an empty response does not trigger that cleanup.

### D. `setDevMode` reboots by itself (the foundation of this project)

OSE source (`com.palm.service.devmode`): both enable and disable end with
`exec("reboot")`. That reboot is **asynchronous**: after a disable, systemd
runs the REBOOT branch — log tar + backup (~4 s of explicit waits), USB
unmount, read-only remount, an external-micom-mediated hardware power cycle —
before the machine actually restarts. The shutdown takes seconds, not
milliseconds; there is no delay constant anywhere in the service code — the
window is the shutdown sequence itself.

### Aftermath: the next boot with dev mode off wipes the dev apps

At any boot where the flag is missing, `devmode.sh` runs
`rm -rf /media/developer`; dev-installed apps (including this app) live
under `/media/developer/apps/`. That is this app's goal: **make sure a
boot with the flag missing never happens.**

## How this app works

### Autostart & check timing

The counter only advances on a **real power-off** (the POWEROFF branch of
`shutdown.sh`); reboots and standby (Quick Start+) never touch it, and every
power-off is followed by a boot. While the TV is on the counter cannot change,
so there is **no periodic background check** — waking up every few minutes
would only re-read the same value.

- **At every boot** — `appinfo.json`'s `previewMetadata.targetEndpoint`
  points at the service's `autostart` method. The system calls it early in
  boot, starting the service without opening the app (measured: process up
  ~23 s after a reboot). Every service start runs a `boot` check.
- **When you open the app** — the app page calls `watchdogArm`, which runs
  an `arm` check.
- **On demand** — **Check now** runs an immediate check.

### Check logic

- **Read** — counter = the highest `dc<N>` in `/var/luna/preferences` (0 if
  none); dev mode is considered on while `devmode_enabled` exists.
- **Decide** — skip while a toggle is in progress, within 24 h of the last
  toggle (cooldown), or dev mode is off. Otherwise toggle once the counter
  reaches `THRESHOLD` (8 — two power-offs of headroom under the disable
  limit).
- **Protect** — require exactly 64 printable token bytes, renew the official
  session, save the token through the Developer Mode service's `download`
  method, then require `loginStatus: true`. Any failure aborts before
  Developer Mode is disabled.
- **Toggle** — on the same anonymous private handle:
  `setDevMode(false)` (wait ≤ 1 s) → unconditionally `setDevMode(true)`
  (≤ 5 s). In-order delivery makes the enable either the rescue or a harmless
  no-op. The toggle timestamp is persisted to `state.json` **before** the
  toggle so the cooldown survives the reboot. After the calls, the service
  verifies that the flag exists and the counter is `dc0`.

### Session time

- **Query** — `devSessionTimeStatus` reads the official locally maintained
  countdown without contacting LG's server.
- **Extend** — `resetSession` sends the current token to LG's official
  `ResetDevModeSession.dev` endpoint, verifies it with
  `CheckDevModeSession.dev`, and refreshes the local `devSessionTime` file.
- The app requires the exact official success result
  `statusCode: "recreated"`; a valid 64-byte token and network connection are
  required.
- **Startup renewal** — every service start queries the remaining time. If it
  is below 168 hours (7 days), the service renews it before running the
  shutdown-counter check. At or above 168 hours, no server renewal request is
  made.
- **Network startup race** — if that renewal fails because networking is not
  ready, the service subscribes to
  `com.palm.connectionmanager/getstatus`. It retries immediately when
  `isInternetConnectionAvailable` becomes true, with one additional fallback
  retry when the service has been running for 3 minutes. This uses no periodic
  Activity Manager task.

### Resetting the counter without root

- The jail cannot write `/var/luna/preferences` → no direct `rm dc*` /
  `touch dc0`.
- No root shell.
- `setDevMode` sits in the non-public `system.devmode` LS2 permission group:
  per the on-device ACL files only the Content Store devmode app and
  `com.palm.service.devmode.test` hold it; the jail's `luna-send` is a
  root-only binary, and `luna-send-pub`'s public identity is ACL-blocked.

#### Reaching the service

1. **The anonymous private palmbus Handle** (proven by [lg-geolock-bypass](https://github.com/lennylxx/lg-geolock-bypass)) — `new pb.Handle('', false)` (with
   `pmloglib` stubbed in memory if needed) opens the private bus without
   registering a service identity. This bypasses the usual luna-service2
   identity check for the APIs used here.
   Individual services can still enforce their own sender or payload checks;
   this is not a claim that every LS2 API is universally callable.
2. **`devmode_service.js` has no internal ACL** — the `message.sender` check
   only guards the `--testmode` path.
3. So `setDevMode` is reachable from the anonymous handle.

#### The reset itself: an off→on toggle

`setDevMode(true)` writes `devmode_enabled` + a fresh `dc0` by itself — the
counter reset is free. The only issue is ordering: on→on directly is a no-op,
so a full disable→enable cycle is needed, and both calls must land before the
reboot actually completes:

1. `setDevMode(false)` — the service unlinks flag + `dc*` and schedules
   `exec("reboot")`. The reboot is asynchronous; the shutdown sequence takes
   seconds (see [D. `setDevMode` reboots by itself](#d-setdevmode-reboots-by-itself-the-foundation-of-this-project)).
2. `setDevMode(true)` — sent on the **same handle**; LS2 delivers in order; it
   arrives before the reboot completes and rewrites flag + `dc0`.

Before toggling, the app first renews the official session through
`resetSession`. It then reads the current 64-byte token, asks the official
Developer Mode service to save it as `download/sessionToken`, and calls
`loginStatus`, requiring `loginStatus: true`. If renewing, reading, writing,
or validating the token fails, the toggle is not attempted.

Result: the TV comes back **dev mode ON** — counter at `dc0`, the official
startup script restores the saved token to `devmode_enabled`, and
`/media/developer` remains untouched. The off→on calls use the same private
handle so LS2 preserves their order.

The counter reset itself does not extend the official session:
`setDevMode` never changes `devSessionTime`. The app renews the session
separately through the official service before toggling.

#### Why token protection matters

The official startup script checks whether a network interface already has
carrier before attempting online session validation:

- If networking is ready and the session token is valid, the online session
  check succeeds and the script removes `dc*`.
- If Wi-Fi is not ready yet, the online check is skipped and `dc*` remains.
- If the request times out or returns no content, `dc*` also remains.
- Each later real power-off can therefore advance the surviving counter.
- If a later boot reaches the server with an empty or invalid token, the
  server returns `fail` and the script removes the Developer Mode flag,
  counter, and saved session time.

Why the original implementation failed later: `setDevMode(true)` writes an
empty `devmode_enabled` file. The shutdown logic only checks whether the file
exists, so the empty flag survived while early-boot Wi-Fi was unavailable.
Once networking was ready during a later boot, the official session check
rejected the empty token and removed Developer Mode. The current backup gate
exists specifically to prevent that state.

### Service keep-alive

webos-service has a ~5 s idle timer by default: `process.exit(0)` once the
last activity completes. The service keeps itself alive with two things:

1. An internal `wdg-keepalive` activity — creating an activity with a string
   spec makes webos-service create an internal activity; the idle timer only
   runs while no activities remain, so this holds the process.
2. `setInterval(fn, 60000)` — on this TV the palmbus handle does not keep
   Node's event loop alive: without a pending timer the process exits right
   after start and the jailer relaunches it every ~0.5 s in a loop.

The service stays resident while the TV is on (it survives standby/resume
inside the CRIU image). It is (re)started by autostart on every boot, and the
app's luna calls (status / check / toggle) reach it directly while resident.

## Appendix: clearing the counter with root

This is an alternative for rooted TVs, not part of this app's installation.
With a real root shell, the toggle can be avoided entirely: the counter is
just a set of files under `/var/luna/preferences` (on emmc), and root simply
deletes them.

### The Homebrew Channel approach

HBC's [services/startup.sh](https://github.com/webosbrew/webos-homebrew-channel/blob/main/services/startup.sh)
is designed to be copied over the Developer Mode app's `start-devmode.sh` —
the script the devmode app runs at **every dev-mode-ON boot** in the
**system context** (full privileges) to start the SSH jail.

The counter cleanup is a single line (it runs unconditionally — the script
itself only runs on dev-mode-ON boots, so it is inherently gated):

```bash
# Reset devmode reboot counter
rm -f /var/luna/preferences/dc*
```

Why this is sufficient: once deleted, the next real power-off takes
`shutdown.sh`'s POWEROFF branch through "no counter file → `touch dc0`" — the
counter oscillates between "absent" and `dc0` and never reaches `dc10`, so
dev mode can never be auto-disabled by the power-off count. No reboots
involved; the token and the 1000 h session are unaffected.
