// Dev Mode Forever status page. Arms the service on load and shows the
// counter. Plain ES5 (webOS 4 web view).
(function () {
  'use strict';

  var SERVICE = 'luna://com.lennylxx.devmodeforever.service/';

  // PalmServiceBridge is the app-page Luna bridge on this platform.
  function request(method, params, cb) {
    var bridge;
    try { bridge = new window.PalmServiceBridge(); } catch (e) { return cb({ errorText: String(e) }); }
    bridge.onservicecallback = function (message) {
      bridge.onservicecallback = null;
      var res = null;
      try { res = JSON.parse(message); } catch (e) { /* bad payload */ }
      var failed = !res || res.returnValue === false || res.ok === false ||
        (typeof res.errorCode === 'number' && res.errorCode !== 0);
      cb(failed ? (res || { errorText: 'bad payload' }) : null, res);
    };
    bridge.call(SERVICE + method, JSON.stringify(params || {}));
  }

  function el(id) { return document.getElementById(id); }

  function fmtTime(ms) {
    if (!ms) return 'Never';
    var d = new Date(ms);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function refresh() {
    request('watchdogStatus', {}, function (err, p) {
      if (err) { el('log').textContent = 'service unreachable: ' + JSON.stringify(err); return; }
      var hot = p.counter >= p.threshold;
      el('devmode').textContent = p.devmode ? 'on' : 'OFF';
      el('counter').textContent = p.counter + ' / ' + p.limit;
      el('counter').className = hot ? 'hot' : '';
      el('token').textContent = p.tokenBytes >= 64
        ? 'Valid (' + p.tokenBytes + ' bytes)'
        : p.devmode ? 'Missing — do not power off' : 'Not available';
      el('token').className = p.devmode && p.tokenBytes < 64 ? 'hot' : '';
      el('armed').textContent = p.armed
        ? 'Active — checks at boot and app launch'
        : 'Inactive — reopen this app';
      el('checkAt').textContent = fmtTime(p.lastCheckAt);
      el('backupAt').textContent = fmtTime(p.lastBackupAt);
      el('extendAt').textContent = fmtTime(p.lastExtendAt);
      el('toggleAt').textContent = fmtTime(p.lastToggleAt);
      el('extendBtn').disabled = !!p.extending || !p.devmode || p.tokenBytes !== 64;
      var tokenMissing = p.devmode && p.tokenBytes < 64;
      el('banner').hidden = !hot && !tokenMissing;
      el('banner').textContent = tokenMissing
        ? 'The Developer Mode session token is missing. Do not fully power off the TV; the next real power-off may disable Developer Mode and remove developer apps.'
        : 'Shutdown counter reached ' + p.counter + '/' + p.limit +
          '. Before toggling, the watchdog saves the current token through the official Developer Mode service and verifies it. If backup fails, it will not toggle.';
    });
    request('devSessionStatus', {}, function (err, p) {
      el('sessionTime').textContent = err ? 'Unavailable' : p.remainSession;
      el('sessionTime').className = err ? 'hot' : '';
    });
  }

  function show(label) {
    return function (err, p) {
      el('log').textContent = label + (err ? ' failed: ' + JSON.stringify(err) : ': ' + JSON.stringify(p));
      refresh();
    };
  }

  el('checkBtn').addEventListener('click', function () {
    el('log').textContent = 'checking…';
    request('watchdogCheck', { trigger: 'app' }, show('check'));
  });

  var extendBtn = el('extendBtn');
  extendBtn.addEventListener('click', function () {
    extendBtn.disabled = true;
    extendBtn.textContent = 'Extending…';
    el('log').textContent = 'extending the official Developer Mode session…';
    request('extendDevSession', {}, function (err, p) {
      extendBtn.textContent = 'Extend session';
      el('log').textContent = err
        ? 'extend failed: ' + JSON.stringify(err)
        : 'session extended: ' + p.remainSession + ' remaining';
      refresh();
    });
  });

  // WAM does not show window.confirm() dialogs, so confirm in-page: a second
  // press within 5s starts the protected toggle.
  var toggleBtn = el('toggleBtn');
  var confirmTimer = null;
  function resetToggle() {
    clearTimeout(confirmTimer);
    confirmTimer = null;
    toggleBtn.className = '';
    toggleBtn.textContent = 'Force toggle';
  }
  toggleBtn.addEventListener('click', function () {
    if (!confirmTimer) {
      toggleBtn.className = 'confirm';
      toggleBtn.textContent = 'Press again to confirm';
      el('log').textContent = 'The official session will be extended, then the current 64-byte token ' +
        'will be saved and verified. If either step fails, Developer Mode will not be toggled.';
      confirmTimer = setTimeout(resetToggle, 5000);
      return;
    }
    resetToggle();
    el('log').textContent = 'extending session, backing up token, then toggling…';
    request('watchdogToggle', {}, show('toggle'));
  });

  var buttons = [el('checkBtn'), extendBtn, toggleBtn];
  buttons.forEach(function (btn) {
    btn.addEventListener('mouseover', function () { btn.focus(); });
  });
  document.addEventListener('keydown', function (e) {
    var i = buttons.indexOf(document.activeElement);
    if (e.keyCode === 37) i = i <= 0 ? 0 : i - 1;
    else if (e.keyCode === 39) i = i < 0 ? 0 : Math.min(buttons.length - 1, i + 1);
    else if ((e.keyCode === 38 || e.keyCode === 40) && i < 0) i = 0;
    else return;
    buttons[i].focus();
    e.preventDefault();
  });
  buttons[0].focus();

  request('watchdogArm', {}, function () {
    el('log').textContent = '';
    refresh();
    setInterval(refresh, 30000);
  });
})();
