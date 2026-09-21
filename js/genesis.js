/* =====================================================================
   genesis.js — Shared data layer for "The Genesis" Innovation Council Hub
   ---------------------------------------------------------------------
   Persistence : LocalStorage (swap the read/write helpers for Supabase
                 row ops to go multi-device — see README.md)
   Clock       : All business logic runs on IST (Asia/Kolkata, UTC+5:30).
                 We keep a fixed +05:30 offset (IST has no DST), so the
                 7:00 PM auto check-out is correct on any device timezone.
   ===================================================================== */
window.Genesis = (function () {
  'use strict';

  var LS = { logs: 'genesis.logs.v1', reg: 'genesis.registry.v1' };
  var IST = 19800000; // +05:30 in milliseconds
  var SECRET = 'GENESIS::QUIC::kiosk::v1'; // kiosk token salt
  var SLOT_MS = 120000; // kiosk QR rotates every 2 minutes

  var PURPOSES = ['Research Lab', 'Project Work', 'Startup / Incubation',
    'Mentorship Session', 'Workshop / Event', 'Meeting', 'Tour / Visit', 'Other'];
  var ROLES = ['Student', 'Faculty', 'Founder', 'Guest'];
  var OPEN_HM = '08:00', CLOSE_HM = '19:00';

  /* ---------------- storage helpers ---------------- */
  function read(k, fallback) {
    try { var v = JSON.parse(localStorage.getItem(k)); return (v === null || v === undefined) ? fallback : v; }
    catch (e) { return fallback; }
  }
  function write(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  /* cross-tab live sync (admin + kiosk + portal refresh instantly) */
  var bc = null;
  try { if ('BroadcastChannel' in window) bc = new BroadcastChannel('genesis-bus'); } catch (e) { }
  function broadcast() { try { if (bc) bc.postMessage('genesis:update'); } catch (e) { } }
  function onUpdate(fn) {
    if (bc) bc.onmessage = function () { fn(); };
    window.addEventListener('storage', function (e) {
      if (!e || e.key === null || e.key.indexOf('genesis.') === 0) fn();
    });
  }

  /* ---------------- IST clock helpers ---------------- */
  function wall(ts) { return new Date((ts == null ? Date.now() : ts) + IST); }
  function iso(ts) { return wall(ts).toISOString(); }          // IST wall clock via UTC fields
  function dateStr(ts) { return iso(ts).slice(0, 10); }        // YYYY-MM-DD (IST)
  function timeStr(ts) { return iso(ts).slice(11, 16); }       // HH:MM (IST)
  function hourOf(ts) { return +iso(ts).slice(11, 13); }
  function epochIST(ymd, hm) { return Date.parse(ymd + 'T' + hm + ':00.000Z') - IST; }
  function openEpoch(d) { return epochIST(d || dateStr(), OPEN_HM); }
  function closeEpoch(d) { return epochIST(d || dateStr(), CLOSE_HM); }
  function pretty(ts) {
    var s = timeStr(ts), h = +s.slice(0, 2), m = s.slice(3);
    var ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return h + ':' + m + ' ' + ap;
  }
  function rel(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000) | 0;
    if (s < 60) return s + 's ago';
    var m = (s / 60) | 0; if (m < 60) return m + 'm ago';
    var h = (m / 60) | 0; if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
    return ((h / 24) | 0) + 'd ago';
  }

  /* ---------------- core store ---------------- */
  function getLogs() { return read(LS.logs, []); }
  function saveLogs(l) { write(LS.logs, l); broadcast(); }
  function active() { return getLogs().filter(function (l) { return !l.checkOut; }); }
  function countActive() { return active().length; }

  /* ============ 7:00 PM IST AUTO CHECK-OUT (background logic) ============
     Runs (a) on every page load, (b) every 30s while any page is open,
     and (c) before every check-in — so stale sessions are always closed,
     even after days of closed laptops. Sets autoCheckout = true.        */
  function sweep() {
    var logs = getLogs(), now = Date.now(), n = 0;
    for (var i = 0; i < logs.length; i++) {
      var l = logs[i];
      if (l.checkOut) continue;
      var co = closeEpoch(dateStr(l.checkIn)); // 7:00 PM IST on the day they checked in
      if (now >= co) {
        l.checkOut = co >= l.checkIn ? co : l.checkIn; // clamp edge cases
        l.autoCheckout = true;
        n++;
      }
    }
    if (n) saveLogs(logs);
    return n;
  }
  function startSweep(intervalMs) {
    sweep();
    return setInterval(sweep, intervalMs || 30000);
  }

  /* ---------------- unique ids ---------------- */
  function genGuestId() {
    var a = Date.now().toString(36).toUpperCase().slice(-4);
    var b = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    return 'GST-' + a + b; // e.g. GST-K7Q2M4XT
  }
  function validUid(uid) { return /^[A-Za-z0-9][A-Za-z0-9._\/-]{1,23}$/.test(uid); }

  /* ---------------- check-in / check-out ---------------- */
  function checkIn(opts) {
    sweep();
    opts = opts || {};
    var uid = (opts.uid || '').trim().toUpperCase().replace(/\s+/g, '');
    var name = (opts.name || '').trim();
    var role = ROLES.indexOf(opts.role) >= 0 ? opts.role : 'Guest';
    var purpose = (opts.purpose || 'Other').trim();
    if (!uid) uid = genGuestId();                       // guests get an auto Unique ID
    if (name.length < 2) return { ok: false, msg: 'Please enter your full name.' };
    if (!validUid(uid)) return { ok: false, msg: 'Unique ID must be 2–24 chars (letters, digits, - . _ /).' };
    var now = Date.now(), d = dateStr(now);
    if (now < openEpoch(d)) return { ok: false, msg: 'The hub opens at ' + pretty(openEpoch(d)) + ' IST.' };
    if (now >= closeEpoch(d)) return { ok: false, msg: 'The hub is closed — last check-in 7:00 PM IST. See you tomorrow ' + pretty(openEpoch(d)) + '.' };
    var dup = getLogs().find(function (l) { return !l.checkOut && l.uid === uid; });
    if (dup) return { ok: false, code: 'duplicate', msg: 'This Unique ID is already checked in.', active: dup };
    var entry = {
      id: 'LOG-' + d.replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
      uid: uid, name: name, role: role, purpose: purpose,
      checkIn: now, checkOut: null, autoCheckout: false, forced: false,
      src: opts.src || 'web', date: d
    };
    var logs = getLogs(); logs.unshift(entry); saveLogs(logs);
    var reg = read(LS.reg, {}); reg[uid] = { name: name, role: role, purpose: purpose, lastSeen: now }; write(LS.reg, reg);
    return { ok: true, entry: entry };
  }

  function checkOut(uid, opts) {
    uid = (uid || '').trim().toUpperCase();
    var logs = getLogs();
    var l = logs.find(function (x) { return x.uid === uid && !x.checkOut; });
    if (!l) return { ok: false, msg: 'No active session found for ' + (uid || '—') + '.' };
    l.checkOut = Date.now(); l.forced = !!(opts && opts.force);
    saveLogs(logs);
    return { ok: true, entry: l };
  }
  function forceCheckoutEntry(id) { // admin override by entry id
    var logs = getLogs();
    var l = logs.find(function (x) { return x.id === id && !x.checkOut; });
    if (!l) return { ok: false, msg: 'Entry not found or already closed.' };
    l.checkOut = Date.now(); l.forced = true;
    saveLogs(logs);
    return { ok: true, entry: l };
  }
  function checkoutAll() {
    var logs = getLogs(), now = Date.now(), n = 0;
    logs.forEach(function (l) { if (!l.checkOut) { l.checkOut = now; l.forced = true; n++; } });
    if (n) saveLogs(logs);
    return n;
  }
  function deleteLog(id) {
    var logs = getLogs(), i = logs.findIndex(function (x) { return x.id === id; });
    if (i < 0) return false; logs.splice(i, 1); saveLogs(logs); return true;
  }
  function clearAll() { saveLogs([]); }
  function lookup(uid) {
    var reg = read(LS.reg, {});
    return reg[(uid || '').trim().toUpperCase()] || null;
  }

  /* ---------------- touchless kiosk tokens ---------------- */
  function fnv(s) {
    var h = 0x811c9dc5 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(36)).slice(-7);
  }
  function slotOf(ts) { return Math.floor((ts == null ? Date.now() : ts) / SLOT_MS); }
  function kioskToken(ts) { var s = slotOf(ts); return s.toString(36) + '.' + fnv(SECRET + ':' + s); }
  function kioskValid(tok) {
    if (typeof tok !== 'string' || !/^[0-9a-z]+\.[0-9a-z]+$/.test(tok)) return false;
    var parts = tok.split('.'), slot = parseInt(parts[0], 36);
    if (fnv(SECRET + ':' + slot) !== parts[1]) return false;
    return Math.abs(slotOf() - slot) <= 1; // ~2–4 minute acceptance window
  }

  /* ---------------- analytics ---------------- */
  function durationMin(l) { var e = l.checkOut || Date.now(); return Math.max(1, Math.round((e - l.checkIn) / 60000)); }
  function fmtDur(min) {
    if (min < 60) return min + 'm';
    return ((min / 60) | 0) + 'h ' + String(min % 60).padStart(2, '0') + 'm';
  }
  function purposeBreakdown(logs) { var m = {}; logs.forEach(function (l) { m[l.purpose] = (m[l.purpose] || 0) + 1; }); return m; }
  function roleBreakdown(logs) { var m = {}; logs.forEach(function (l) { m[l.role] = (m[l.role] || 0) + 1; }); return m; }
  function hourHistogram(logs) { var a = new Array(24).fill(0); logs.forEach(function (l) { a[hourOf(l.checkIn)]++; }); return a; }

  /* ---------------- CSV export ---------------- */
  function toCSV(logs) {
    function esc(v) { v = (v === null || v === undefined) ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var rows = [['Entry ID', 'Unique ID', 'Name', 'Role', 'Purpose', 'Date (IST)', 'Check-In (IST)',
      'Check-Out (IST)', 'Duration (min)', 'Auto Check-Out', 'Forced Check-Out', 'Source', 'Status'].join(',')];
    logs.forEach(function (l) {
      rows.push([l.id, l.uid, esc(l.name), l.role, esc(l.purpose), l.date, timeStr(l.checkIn),
      l.checkOut ? timeStr(l.checkOut) : '', durationMin(l),
      l.autoCheckout ? 'TRUE' : 'FALSE', l.forced ? 'TRUE' : 'FALSE', l.src || 'web',
      l.checkOut ? 'Checked Out' : 'Active'].join(','));
    });
    return rows.join('\r\n');
  }
  function downloadCSV(logs, fname) {
    var blob = new Blob(['﻿' + toCSV(logs)], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname || ('genesis-hub-logs-' + dateStr() + '.csv');
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  /* ---------------- demo data ---------------- */
  var DEMO_PEOPLE = [
    ['QU-CS-23-1042', 'Aarav Sharma', 'Student', 'Project Work'],
    ['QU-EC-22-0877', 'Ananya Gupta', 'Student', 'Research Lab'],
    ['QU-ME-23-0809', 'Kabir Singh', 'Student', 'Workshop / Event'],
    ['QU-CS-24-1190', 'Ishita Rao', 'Student', 'Mentorship Session'],
    ['EMP-2011-034', 'Dr. Meera Iyer', 'Faculty', 'Research Lab'],
    ['EMP-2017-112', 'Prof. Vikram Nair', 'Faculty', 'Meeting'],
    ['FND-QAI-07', 'Rohan Verma', 'Founder', 'Startup / Incubation'],
    ['FND-NXT-03', 'Sanya Malhotra', 'Founder', 'Startup / Incubation'],
    ['GST-9XK2Q1AB', 'Col. R. Bhandari', 'Guest', 'Tour / Visit'],
    ['GST-4MD7Z8QP', 'Nidhi Kapoor', 'Guest', 'Meeting'],
    ['QU-CS-22-0761', 'Dev Patel', 'Student', 'Project Work'],
    ['EMP-2015-058', 'Dr. Farhan Ali', 'Faculty', 'Mentorship Session']
  ];
  function seedDemo() {
    var logs = getLogs(), added = 0, now = Date.now();
    function mk(p, ci, co, auto) {
      logs.push({
        id: 'LOG-' + dateStr(ci).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
        uid: p[0], name: p[1], role: p[2], purpose: p[3],
        checkIn: ci, checkOut: co, autoCheckout: !!auto, forced: false,
        src: Math.random() < 0.5 ? 'kiosk' : 'web', date: dateStr(ci)
      }); added++;
    }
    function pastVisit(p, dayOffset) {
      var d = new Date(now - dayOffset * 86400000);
      var open = openEpoch(dateStr(d.getTime()));
      var ci = open + (1 + Math.random() * 9) * 3600000 + Math.random() * 1800000; // 9 AM – 6:30 PM IST
      if (ci >= now - 3600000) ci = now - (2 + Math.random() * 4) * 3600000;
      var stay = (30 + Math.random() * 220) * 60000;
      var co = ci + stay, auto = false;
      var close = closeEpoch(dateStr(ci));
      if (co > close) { co = close; auto = true; }
      mk(p, ci, co, auto);
    }
    for (var d = 6; d >= 1; d--) {
      var n = 5 + Math.floor(Math.random() * 6);
      var order = DEMO_PEOPLE.slice().sort(function () { return Math.random() - 0.5; });
      for (var i = 0; i < n && i < order.length; i++) pastVisit(order[Math.floor(Math.random() * order.length)], d);
    }
    // today: some completed + some currently inside
    if (now > openEpoch() + 3 * 3600000 && now < closeEpoch()) {
      var todayPpl = DEMO_PEOPLE.slice().sort(function () { return Math.random() - 0.5; });
      var p;
      for (var t = 0; t < 4; t++) {
        p = todayPpl[t + 4];
        var cip = Math.max(openEpoch() + 300000, now - (1 + t) * (45 + Math.random() * 60) * 60000);
        var cop = Math.min(now - 10 * 60000, cip + (40 + Math.random() * 120) * 60000);
        if (cop > cip) mk(p, cip, cop, false);
      }
      for (var a = 0; a < 4; a++) {
        p = todayPpl[a];
        var cia = Math.max(openEpoch() + 120000, now - (8 + Math.random() * 110) * 60000);
        mk(p, cia, null, false);
      }
    }
    logs.sort(function (x, y) { return y.checkIn - x.checkIn; });
    saveLogs(logs);
    return added;
  }

  /* ---------------- public API ---------------- */
  return {
    PURPOSES: PURPOSES, ROLES: ROLES, OPEN_HM: OPEN_HM, CLOSE_HM: CLOSE_HM,
    getLogs: getLogs, active: active, countActive: countActive,
    sweep: sweep, startSweep: startSweep,
    checkIn: checkIn, checkOut: checkOut, forceCheckoutEntry: forceCheckoutEntry,
    checkoutAll: checkoutAll, deleteLog: deleteLog, clearAll: clearAll,
    lookup: lookup, genGuestId: genGuestId,
    kioskToken: kioskToken, kioskValid: kioskValid,
    dateStr: dateStr, timeStr: timeStr, hourOf: hourOf, pretty: pretty, rel: rel,
    openEpoch: openEpoch, closeEpoch: closeEpoch,
    durationMin: durationMin, fmtDur: fmtDur,
    purposeBreakdown: purposeBreakdown, roleBreakdown: roleBreakdown, hourHistogram: hourHistogram,
    toCSV: toCSV, downloadCSV: downloadCSV, seedDemo: seedDemo, onUpdate: onUpdate
  };
})();
