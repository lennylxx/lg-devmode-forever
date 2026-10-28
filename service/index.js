// Dev Mode Watchdog service. The TV counts real power-offs while Developer
// Mode is on as /var/luna/preferences/dc<N> and disables dev mode at dc10.
// Before resetting that counter with setDevMode(false)->setDevMode(true), save
// the current session token through the official Developer Mode service. Its
// signed start-devmode.sh moves download/sessionToken back into
// /var/luna/preferences/devmode_enabled on the reboot caused by the toggle.
// Plain ES5: must run on webOS 4's Node.js 0.12.
var fs = require('fs');

var SERVICE_ID = require('./services.json').id;
var PREFS_DIR = '/var/luna/preferences';
var DEVMODE_FLAG = PREFS_DIR + '/devmode_enabled';
var DEVMODE_SERVICE = 'luna://com.palmdts.devmode.service/';
var LIMIT = 10;
var THRESHOLD = 8;
var COOLDOWN_MS = 24 * 3600 * 1000;
var BACKUP_TIMEOUT_MS = 5000;
var VERIFY_TIMEOUT_MS = 15000;
var SESSION_STATUS_TIMEOUT_MS = 5000;
var SESSION_EXTEND_TIMEOUT_MS = 30000;
var AUTO_RENEW_THRESHOLD_MINUTES = 7 * 24 * 60;
var NETWORK_RETRY_DELAY_MS = 3 * 60 * 1000;
var OFF_TIMEOUT_MS = 1000;
var ON_TIMEOUT_MS = 5000;
var STARTED_AT = Date.now();
var pendingNetworkRetry = null;

// The install dir is read-only and /tmp is wiped on reboot.
var STATE_DIR = (function () {
  var dirs = ['/media/internal/devmodeforever', '/tmp/devmodeforever'];
  for (var i = 0; i < dirs.length; i++) {
    try { fs.mkdirSync(dirs[i]); } catch (e) { if (e.code !== 'EEXIST') continue; }
    try { fs.writeFileSync(dirs[i] + '/.probe', ''); return dirs[i]; } catch (e) { /* next */ }
  }
  return dirs[1];
})();
var STATE_FILE = STATE_DIR + '/state.json';
var LOG_FILE = STATE_DIR + '/service.log';

// The jail cannot read the system log, so also log to a rotated file.
function log() {
  var line = '[wdg] ' + Array.prototype.map.call(arguments, function (a) {
    return typeof a === 'string' ? a : JSON.stringify(a);
  }).join(' ');
  console.log(line);
  try {
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (e) { /* none */ }
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + process.pid + ' ' + line + '\n');
  } catch (e) { /* never break the service */ }
}

var state = {
  lastCheckAt: 0,
  lastBackupAt: 0,
  lastExtendAt: 0,
  lastToggleAt: 0,
  lastToggleCounter: 0,
  toggling: false,
  extending: false,
  armed: false,
  keepAlive: false
};

try {
  var saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state.lastBackupAt = saved.lastBackupAt || 0;
  state.lastExtendAt = saved.lastExtendAt || 0;
  state.lastToggleAt = saved.lastToggleAt || 0;
  state.lastToggleCounter = saved.lastToggleCounter || 0;
} catch (e) { /* first run */ }

function readCounter() {
  var max = 0;
  try {
    fs.readdirSync(PREFS_DIR).forEach(function (name) {
      var m = /^dc([0-9]+)$/.exec(name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
  } catch (e) { /* no counter on this firmware */ }
  return max;
}

function devModeOn() {
  return fs.existsSync(DEVMODE_FLAG);
}

function tokenBytes() {
  try {
    return fs.statSync(DEVMODE_FLAG).size;
  } catch (e) {
    return 0;
  }
}

function readSessionToken() {
  var token;
  try {
    token = fs.readFileSync(DEVMODE_FLAG, 'utf8');
  } catch (e) {
    return { ok: false, error: 'token-read-failed', detail: String(e) };
  }
  if (Buffer.byteLength(token, 'utf8') !== 64 || !/^[\x21-\x7e]{64}$/.test(token)) {
    return { ok: false, error: 'invalid-token', bytes: Buffer.byteLength(token, 'utf8') };
  }
  return { ok: true, token: token, bytes: 64 };
}

// palmbus needs pmloglib, which some runtimes (the jail) lack: an in-memory
// stub satisfies it. Only installed when palmbus fails to load - the real
// pmloglib must stay in place for webos-service.
function loadPalmbus() {
  try { return require('palmbus'); } catch (e) { /* stub pmloglib below */ }
  var Module = require('module');
  var originalLoad = Module._load;
  var noop = function () {};
  var logger = function () { return { log: noop, info: noop, warn: noop, warning: noop, error: noop }; };
  var pmloglib = { log: noop, info: noop, warning: noop, error: noop, Console: logger, Context: logger };
  Module._load = function (request) {
    if (request === 'pmloglib') return pmloglib;
    return originalLoad.apply(this, arguments);
  };
  return require('palmbus');
}

// false selects the private bus. The official Developer Mode service exposes
// these methods to "all", but explicitly choosing the private bus also reaches
// private-only system APIs on current firmware.
function openHandle() {
  var pb = loadPalmbus();
  try {
    return new pb.Handle('', false);
  } catch (twoArgumentError) {
    try {
      return new pb.Handle('');
    } catch (singleArgumentError) {
      throw new Error('Unable to create palmbus Handle; private: ' +
        twoArgumentError.message + '; default: ' + singleArgumentError.message);
    }
  }
}

function callLuna(handle, uri, payload, timeoutMs, cb) {
  var t0 = Date.now();
  var done = false;
  var timer;
  var finish = function (kind, raw) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    var parsed = null;
    if (kind === 'response') {
      try { parsed = JSON.parse(raw); } catch (e) { /* reported below */ }
    }
    var errorCode = parsed && parsed.errorCode;
    var ok = kind === 'response' && parsed &&
      parsed.returnValue !== false &&
      !(typeof errorCode === 'number' && errorCode !== 0) &&
      !(typeof errorCode === 'string' && errorCode !== '' && errorCode !== '0');
    cb({
      ok: ok,
      kind: kind,
      response: parsed,
      error: kind === 'response' ? (!parsed ? 'invalid-json' : null) : raw,
      ms: Date.now() - t0
    });
  };
  var call;
  try {
    call = handle.call(uri, JSON.stringify(payload || {}));
  } catch (e) {
    finish('error', String(e && e.message || e));
    return;
  }
  call.on('response', function (message) { finish('response', message.payload()); });
  call.on('error', function (err) { finish('error', String(err && err.message || err)); });
  timer = setTimeout(function () { finish('timeout', null); }, timeoutMs);
}

function backupSessionToken(handle, token, cb) {
  callLuna(handle, DEVMODE_SERVICE + 'download', {
    fileName: 'sessionToken',
    data: token
  }, BACKUP_TIMEOUT_MS, function (saved) {
    if (!saved.ok) {
      cb({ ok: false, step: 'write', call: saved });
      return;
    }
    callLuna(handle, DEVMODE_SERVICE + 'loginStatus', {}, VERIFY_TIMEOUT_MS, function (verified) {
      var loginStatus = verified.response && verified.response.loginStatus === true;
      if (!verified.ok || !loginStatus) {
        cb({ ok: false, step: 'verify', call: verified });
        return;
      }
      state.lastBackupAt = Date.now();
      cb({ ok: true, bytes: 64, writeMs: saved.ms, verifyMs: verified.ms });
    });
  });
}

function setDevMode(handle, enabled, timeoutMs, cb) {
  callLuna(handle, 'luna://com.palm.service.devmode/setDevMode', {
    enabled: enabled
  }, timeoutMs, cb);
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastBackupAt: state.lastBackupAt,
      lastExtendAt: state.lastExtendAt,
      lastToggleAt: state.lastToggleAt,
      lastToggleCounter: state.lastToggleCounter
    }));
    return true;
  } catch (e) {
    log('state.save.failed', String(e));
    return false;
  }
}

function saveToggleState(counter) {
  state.lastToggleAt = Date.now();
  state.lastToggleCounter = counter;
  saveState();
}

function sessionStatus(handle, cb) {
  callLuna(handle, DEVMODE_SERVICE + 'devSessionTimeStatus', {},
    SESSION_STATUS_TIMEOUT_MS, function (result) {
      var remainSession = result.response && result.response.remainSession;
      if (!result.ok || typeof remainSession !== 'string' || remainSession === '--:--') {
        cb({ ok: false, error: 'session-status-failed', call: result });
        return;
      }
      cb({ ok: true, remainSession: remainSession, ms: result.ms });
    });
}

function parseSessionMinutes(remainSession) {
  var match = /^([0-9]{1,4})h:([0-5][0-9])m$/.exec(remainSession);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function extendSessionWithHandle(handle, cb) {
  callLuna(handle, DEVMODE_SERVICE + 'resetSession', {},
    SESSION_EXTEND_TIMEOUT_MS, function (reset) {
      var statusCode = reset.response && reset.response.statusCode;
      if (!reset.ok || statusCode !== 'recreated') {
        cb({ ok: false, error: 'session-extend-failed', statusCode: statusCode, call: reset });
        return;
      }
      sessionStatus(handle, function (status) {
        if (!status.ok) {
          cb({ ok: false, error: 'session-extended-status-failed', status: status });
          return;
        }
        state.lastExtendAt = Date.now();
        saveState();
        log('session.extended', 'remain=' + status.remainSession,
          'resetMs=' + reset.ms, 'statusMs=' + status.ms);
        cb({
          ok: true,
          action: 'extended',
          remainSession: status.remainSession,
          resetMs: reset.ms,
          statusMs: status.ms
        });
      });
    });
}

function extensionMayNeedNetworkRetry(extension) {
  var call = extension && extension.call;
  return extension && extension.error === 'session-extend-failed' &&
    (extension.statusCode === 'reset api failed' ||
      !call || call.kind === 'timeout' || call.kind === 'error');
}

function scheduleNetworkRenewalRetry() {
  if (pendingNetworkRetry) return;
  var handle;
  try {
    handle = openHandle();
  } catch (e) {
    log('session.network-watch.failed', String(e));
    return;
  }
  var call;
  try {
    call = handle.call('luna://com.palm.connectionmanager/getstatus',
      JSON.stringify({ subscribe: true }));
  } catch (e) {
    log('session.network-watch.failed', String(e));
    return;
  }
  var delay = Math.max(0, NETWORK_RETRY_DELAY_MS - (Date.now() - STARTED_AT));
  pendingNetworkRetry = {
    call: call,
    timer: setTimeout(function () { runRetry('boot-delay'); }, delay)
  };

  function cleanup() {
    var pending = pendingNetworkRetry;
    pendingNetworkRetry = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    try {
      if (pending.call && typeof pending.call.cancel === 'function') pending.call.cancel();
    } catch (e) { /* call may already be closed */ }
  }

  function runRetry(trigger) {
    if (!pendingNetworkRetry) return;
    if (state.toggling || state.extending) {
      clearTimeout(pendingNetworkRetry.timer);
      pendingNetworkRetry.timer = setTimeout(function () { runRetry(trigger); }, 5000);
      return;
    }
    cleanup();
    log('session.retry', 'trigger=' + trigger);
    autoRenewSession(trigger, function (result) {
      log('session.retry.done', 'trigger=' + trigger, result);
    });
  }

  call.on('response', function (message) {
    var response;
    try { response = JSON.parse(message.payload()); } catch (e) { return; }
    if (response && response.isInternetConnectionAvailable === true) {
      runRetry('network-online');
    }
  });
  call.on('error', function (error) {
    log('session.network-watch.error', String(error && error.message || error));
  });
  log('session.network-watch', 'fallbackMs=' + delay);
}

function autoRenewSession(trigger, cb) {
  var ownsExtension = false;
  var finish = function (result) {
    if (ownsExtension) state.extending = false;
    log('session.auto-check', 'trigger=' + trigger, result);
    cb(result);
  };
  if (state.toggling) return cb({ ok: true, skipped: 'toggle-in-progress' });
  if (state.extending) return cb({ ok: true, skipped: 'extend-in-progress' });
  if (!devModeOn()) return cb({ ok: true, skipped: 'devmode-disabled' });
  var token = readSessionToken();
  if (!token.ok) return cb({ ok: false, error: 'token-unavailable', token: token });
  var handle;
  try {
    handle = openHandle();
  } catch (e) {
    return cb({ ok: false, error: 'palmbus-open-failed', detail: String(e) });
  }
  sessionStatus(handle, function (status) {
    if (!status.ok) return finish(status);
    var remainingMinutes = parseSessionMinutes(status.remainSession);
    if (remainingMinutes === null) {
      return finish({ ok: false, error: 'invalid-session-time', status: status });
    }
    if (remainingMinutes >= AUTO_RENEW_THRESHOLD_MINUTES) {
      return finish({
        ok: true,
        action: 'none',
        remainSession: status.remainSession,
        thresholdMinutes: AUTO_RENEW_THRESHOLD_MINUTES
      });
    }
    if (state.toggling) {
      return finish({ ok: true, skipped: 'toggle-in-progress', status: status });
    }
    if (state.extending) {
      return finish({ ok: true, skipped: 'extend-in-progress', status: status });
    }
    state.extending = true;
    ownsExtension = true;
    extendSessionWithHandle(handle, function (extension) {
      var retryWhenOnline = trigger === 'boot' && extensionMayNeedNetworkRetry(extension);
      finish({
        ok: extension.ok,
        action: extension.ok ? 'extended' : 'failed',
        previousRemainSession: status.remainSession,
        extension: extension
      });
      if (retryWhenOnline) scheduleNetworkRenewalRetry();
    });
  });
}

function extendSession(cb) {
  var token = readSessionToken();
  if (!token.ok) {
    cb({ ok: false, error: 'token-unavailable', token: token });
    return;
  }
  var handle;
  try {
    handle = openHandle();
  } catch (e) {
    cb({ ok: false, error: 'palmbus-open-failed', detail: String(e) });
    return;
  }
  extendSessionWithHandle(handle, cb);
}

// The enable follows unconditionally: calls on one handle arrive in order, so
// it rescues dev mode even if the disable response races the reboot.
function toggle(trigger, counter, cb) {
  state.toggling = true;
  log('toggle.prepare', 'trigger=' + trigger, 'counter=' + counter);
  var finish = function (ok, result) {
    state.toggling = false;
    log('toggle.done', 'ok=' + ok, result);
    cb({
      ok: ok,
      trigger: trigger,
      counter: counter,
      action: ok ? 'toggled' : 'skipped',
      result: result
    });
  };
  var token = readSessionToken();
  if (!token.ok) {
    finish(false, { error: 'token-unavailable', token: token });
    return;
  }
  var handle;
  try {
    handle = openHandle();
  } catch (e) {
    finish(false, { error: 'palmbus-open-failed', detail: String(e) });
    return;
  }
  extendSessionWithHandle(handle, function (extension) {
    if (!extension.ok) {
      finish(false, { error: 'session-extend-failed', extension: extension });
      return;
    }
    backupSessionToken(handle, token.token, function (backup) {
      if (!backup.ok) {
        finish(false, { error: 'token-backup-failed', extension: extension, backup: backup });
        return;
      }
      log('token.backup.verified', 'bytes=' + backup.bytes,
        'writeMs=' + backup.writeMs, 'verifyMs=' + backup.verifyMs);
      saveToggleState(counter);
      log('toggle.start', 'trigger=' + trigger, 'counter=' + counter);
      setDevMode(handle, false, OFF_TIMEOUT_MS, function (off) {
        setDevMode(handle, true, ON_TIMEOUT_MS, function (on) {
          var finalCounter = readCounter();
          var finalFlag = devModeOn();
          var ok = on.ok && finalFlag && finalCounter === 0;
          finish(ok, {
            extension: extension,
            backup: backup,
            off: off,
            on: on,
            finalCounter: finalCounter,
            finalFlag: finalFlag
          });
        });
      });
    });
  });
}

function check(trigger, cb) {
  var counter = readCounter();
  var skip = state.toggling ? 'toggle-in-progress'
    : Date.now() - state.lastToggleAt < COOLDOWN_MS ? 'cooldown'
    : !devModeOn() ? 'devmode-disabled' : null;
  log('check', 'trigger=' + trigger, 'counter=' + counter, skip ? 'skipped=' + skip : '');
  if (skip) return cb({ skipped: skip, trigger: trigger, counter: counter });
  state.lastCheckAt = Date.now();
  if (counter < THRESHOLD) return cb({ ok: true, trigger: trigger, counter: counter, action: 'none' });
  toggle(trigger, counter, cb);
}

function arm(service, cb) {
  // An internal keepAlive activity stops webos-service's ~5s idle exit.
  if (!state.keepAlive) {
    state.keepAlive = true;
    service.activityManager.create('wdg-keepalive', function () { log('keepalive', 'held'); });
  }
  state.armed = true;
  if (cb) cb();
}

var Service;
try {
  Service = require('webos-service');
} catch (e) {
  console.log('[wdg] webos-service not available — nothing to do off webOS');
  process.exit(0);
}

process.on('uncaughtException', function (err) {
  log('uncaughtException', String(err && err.stack || err));
  process.exit(1);
});

var service = new Service(SERVICE_ID);
log('starting', 'pid=' + process.pid);

service.register('watchdogStatus', function (msg) {
  msg.respond({
    devmode: devModeOn(),
    counter: readCounter(),
    limit: LIMIT,
    threshold: THRESHOLD,
    armed: state.armed,
    toggling: state.toggling,
    extending: state.extending,
    tokenBytes: tokenBytes(),
    protection: 'official-token-backup',
    lastCheckAt: state.lastCheckAt || null,
    lastBackupAt: state.lastBackupAt || null,
    lastExtendAt: state.lastExtendAt || null,
    lastToggleAt: state.lastToggleAt || null,
    lastToggleCounter: state.lastToggleCounter || null
  });
});

service.register('watchdogCheck', function (msg) {
  var p = msg.payload || {};
  check(p.trigger ? String(p.trigger) : 'luna', function (result) { msg.respond(result); });
});

service.register('watchdogToggle', function (msg) {
  if (state.toggling) return msg.respond({ ok: false, skipped: 'toggle-in-progress' });
  if (!devModeOn()) return msg.respond({ ok: false, skipped: 'devmode-disabled' });
  toggle('manual', readCounter(), function (result) { msg.respond(result); });
});

service.register('devSessionStatus', function (msg) {
  var handle;
  try {
    handle = openHandle();
  } catch (e) {
    msg.respond({ ok: false, error: 'palmbus-open-failed', detail: String(e) });
    return;
  }
  sessionStatus(handle, function (result) { msg.respond(result); });
});

service.register('extendDevSession', function (msg) {
  if (state.toggling) return msg.respond({ ok: false, skipped: 'toggle-in-progress' });
  if (state.extending) return msg.respond({ ok: false, skipped: 'extend-in-progress' });
  if (!devModeOn()) return msg.respond({ ok: false, skipped: 'devmode-disabled' });
  state.extending = true;
  extendSession(function (result) {
    state.extending = false;
    msg.respond(result);
  });
});

// appinfo.json previewMetadata.targetEndpoint: the system calls this early in
// every boot, which starts the process (and thus arm + check below).
service.register('autostart', function (msg) {
  msg.respond({ returnValue: true });
});

// The app calls this on load: holds keep-alive and runs an arm check.
service.register('watchdogArm', function (msg) {
  arm(service, function () { check('arm', function (result) { msg.respond(result); }); });
});

arm(service);
autoRenewSession('boot', function () {
  check('boot', function () {});
});
// Without a pending timer the process exits right after start-up and the
// jailer relaunches it every ~0.5s, so hold a no-op timer to stay resident.
setInterval(function () {}, 60000);
