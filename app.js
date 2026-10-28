/* Nedgame zoekmodel — live dashboard
   Leest uitsluitend geaggregeerde data via de afgeschermde Supabase-RPC's
   search_dashboard (elke 30 s) en search_dashboard_feed (elke 5 s). */
(function () {
  'use strict';

  var API = 'https://nizupsnwexcisgtnhtnu.supabase.co';
  var KEY = 'sb_publishable_D8zw_CTZO3B4qObfMXjOUg_uE75SRZm'; // publieke sleutel; data zit achter het dashboard-token
  var POLL_DASH = 30000;
  var POLL_FEED = 5000;
  var LEARN_EVERY = 5 * 60 * 1000;
  var TOKEN_KEY = 'ngs_dash_token';
  var THEME_KEY = 'ngs_dash_theme';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, root) { return (root || document).querySelector(s); };
  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ---------------- opmaak ---------------- */
  var nf = new Intl.NumberFormat('nl-NL');
  function fmtN(x) { return x == null || !isFinite(x) ? '–' : nf.format(Math.round(x)); }
  function fmtPct(x, d) {
    if (x == null || !isFinite(x)) return '–';
    d = d == null ? 0 : d;
    return (x * 100).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%';
  }
  function fmtDec(x, d) { return x == null || !isFinite(x) ? '–' : Number(x).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function compact(x) {
    if (x == null) return '–';
    if (Math.abs(x) >= 1000) return (x / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + 'K';
    return nf.format(Math.round(x));
  }
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' u';
    return Math.floor(s / 86400) + ' d';
  }
  function hhmm(ts) { return new Date(ts).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }); }
  function ratio(a, b) { return b > 0 ? a / b : null; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === 'class') e.className = attrs[k]; else if (k === 'style') e.style.cssText = attrs[k]; else e.setAttribute(k, attrs[k]); }
    if (text != null) e.textContent = text;
    return e;
  }
  function s(tag, attrs, text) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  /* ---------------- getal-animatie ---------------- */
  function tween(node, to, fmt, dur) {
    if (to == null || !isFinite(to)) { node.textContent = fmt(to); node._v = null; return; }
    var from = node._v == null ? 0 : node._v;
    node._v = to;
    if (reduceMotion || from === to) { node.textContent = fmt(to); return; }
    dur = dur || 900;
    var t0 = performance.now();
    (function step(now) {
      var p = Math.min(1, (now - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  /* ---------------- tooltip ---------------- */
  var tip = $('#tooltip');
  function showTip(evt, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    var x = evt.clientX, y = evt.clientY;
    var w = tip.offsetWidth;
    x = Math.max(w / 2 + 8, Math.min(window.innerWidth - w / 2 - 8, x));
    tip.style.left = x + 'px';
    tip.style.top = Math.max(tip.offsetHeight + 16, y) + 'px';
  }
  function hideTip() { tip.hidden = true; }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---------------- API ---------------- */
  var token = null;
  function rpc(fn, body) {
    return fetch(API + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': KEY },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.ok) return r.json();
      return r.json().catch(function () { return {}; }).then(function (j) {
        var err = new Error(j.message || ('HTTP ' + r.status));
        err.auth = r.status === 401 || r.status === 403 || j.code === '28000' || /unauthorized/i.test(j.message || '');
        throw err;
      });
    });
  }

  /* ---------------- thema ---------------- */
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (e) {}
  $('#theme-toggle').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var dark = cur ? cur === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    if (state.dash) renderAll(state.dash, true);
    buildLoop();
  });

  /* ---------------- toegang ---------------- */
  function readToken() {
    var m = location.hash.match(/(?:^#|&)t=([^&]+)/);
    if (m) {
      var t = decodeURIComponent(m[1]);
      try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
      history.replaceState(null, '', location.pathname + location.search);
      return t;
    }
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function showGate(err) {
    $('#app').hidden = true;
    $('#gate').hidden = false;
    $('#gate-error').hidden = !err;
    setTimeout(function () { $('#gate-token').focus(); }, 50);
  }
  $('#gate-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = $('#gate-token').value.trim();
    if (!t) return;
    var btn = $('#gate-form button');
    btn.disabled = true; btn.textContent = 'Controleren…';
    rpc('search_dashboard', { p_token: t }).then(function (d) {
      token = t;
      try { localStorage.setItem(TOKEN_KEY, t); } catch (er) {}
      $('#gate-token').value = '';
      start(d);
    }).catch(function () { showGate(true); }).then(function () { btn.disabled = false; btn.textContent = 'Openen'; });
  });
  $('#logout').addEventListener('click', function () {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  });

  /* ---------------- toestand ---------------- */
  var state = { dash: null, feedSince: null, seen: {}, lastLearnAt: null, queue: 0, timers: [], failures: 0 };

  function start(initial) {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    buildLoop();
    if (initial) onDash(initial, true);
    else refreshDash(true);
    refreshFeed(true);
    stopPolling();
    state.timers.push(setInterval(function () { if (!document.hidden) refreshDash(false); }, POLL_DASH));
    state.timers.push(setInterval(function () { if (!document.hidden) refreshFeed(false); }, POLL_FEED));
    state.timers.push(setInterval(tick, 1000));
  }
  function stopPolling() { state.timers.forEach(clearInterval); state.timers = []; }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && token) { refreshDash(false); refreshFeed(false); } });

  function refreshDash(first) {
    rpc('search_dashboard', { p_token: token }).then(function (d) { state.failures = 0; onDash(d, first); })
      .catch(function (e) { state.failures++; setLive(); });
  }
  function refreshFeed(first) {
    rpc('search_dashboard_feed', { p_token: token, p_since: state.feedSince }).then(function (f) { onFeed(f, first); })
      .catch(function (e) { state.failures++; });
  }

  function onDash(d, first) {
    state.dash = d;
    if (!state.lastLearnAt && d.status && d.status.last_learn) state.lastLearnAt = d.status.last_learn;
    renderAll(d, first);
    setLive();
  }

  /* ---------------- live-status + aftellen ---------------- */
  function setLive() {
    var dot = $('#live-dot'), txt = $('#live-text');
    var d = state.dash;
    if (state.failures > 2 || !d) { dot.className = 'live-dot off'; txt.textContent = 'Geen verbinding, opnieuw proberen…'; return; }
    var last = d.status && d.status.last_event;
    var age = last ? (Date.now() - new Date(last).getTime()) / 1000 : Infinity;
    dot.className = 'live-dot ' + (age < 180 ? 'on' : age < 1800 ? 'stale' : 'off');
    txt.textContent = (age < 180 ? 'Live' : 'Stil') + ' · laatste signaal ' + (last ? ago(last) + ' geleden' : 'onbekend');
  }
  function nextLearn() {
    var now = Date.now();
    return Math.ceil((now + 1000) / LEARN_EVERY) * LEARN_EVERY + 2000; // cron */5, paar seconden uitloop
  }
  function tick() {
    setLive();
    var left = Math.max(0, nextLearn() - Date.now());
    var m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
    var v = LOOP.refs.learnValue;
    if (v) v.textContent = m + ':' + (sec < 10 ? '0' : '') + sec;
    var ring = LOOP.refs.ring;
    if (ring) {
      var frac = 1 - left / LEARN_EVERY;
      ring.style.strokeDashoffset = String(LOOP.ringLen * (1 - frac));
    }
    // relatieve tijden in de feed bijwerken
    var items = document.querySelectorAll('#feed-list .t');
    for (var i = 0; i < items.length; i++) items[i].textContent = ago(items[i].getAttribute('data-at'));
  }

  /* =====================================================================
     LEERLUS — geanimeerd schema met echte signalen als deeltjes
     ===================================================================== */
  var LOOP = { refs: {}, segs: {}, particles: [], raf: null, ringLen: 0, layout: null };
  var KIND = {
    search: { label: 'Zoekopdracht', color: '--s1' },
    suggest: { label: 'Suggestie', color: '--s3' },
    click: { label: 'Klik', color: '--s2' },
    add_to_cart: { label: 'Winkelmand', color: '--s4' },
    purchase: { label: 'Aankoop', color: '--s4' },
    wishlist: { label: 'Verlanglijst', color: '--s4' },
    learn: { label: 'Leerstap', color: '--ink' }
  };

  function legendKeys(container, keys, shape) {
    clear(container);
    keys.forEach(function (k) {
      var span = el('span', { class: 'key' });
      var sw = el('span', { class: 'sw' + (k.shape || shape ? ' ' + (k.shape || shape) : '') });
      sw.style.background = cssVar(k.color);
      span.appendChild(sw);
      span.appendChild(document.createTextNode(k.label));
      container.appendChild(span);
    });
  }

  function buildLoop() {
    var svg = $('#loop-svg');
    clear(svg);
    LOOP.refs = {}; LOOP.segs = {};
    var w = svg.clientWidth || svg.parentNode.clientWidth || 800;
    var vertical = w < 640;
    var W = vertical ? 360 : 940, H = vertical ? 700 : 300;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    LOOP.layout = { W: W, H: H, vertical: vertical };

    var names = [
      { id: 'visitors', title: 'Bezoekers' },
      { id: 'signals', title: 'Signalen' },
      { id: 'learn', title: 'Leerstap' },
      { id: 'model', title: 'Model' },
      { id: 'serve', title: 'Zoeken' }
    ];
    var bw = vertical ? 250 : 164, bh = vertical ? 96 : 124;
    var pos = names.map(function (n, i) {
      if (vertical) return { x: 24, y: 18 + i * 132 };
      var gap = (W - 5 * bw) / 4;
      return { x: i * (bw + gap), y: 20 };
    });

    var gTracks = s('g'), gNodes = s('g'), gPart = s('g');
    svg.appendChild(gTracks); svg.appendChild(gPart); svg.appendChild(gNodes);

    // banen tussen de knopen
    for (var i = 0; i < 4; i++) {
      var a = pos[i], b = pos[i + 1], d;
      if (vertical) d = 'M' + (a.x + bw / 2) + ',' + (a.y + bh) + ' L' + (b.x + bw / 2) + ',' + b.y;
      else d = 'M' + (a.x + bw) + ',' + (a.y + bh / 2) + ' L' + b.x + ',' + (b.y + bh / 2);
      var p = s('path', { d: d, class: 'track' });
      gTracks.appendChild(p);
      LOOP.segs[names[i].id + '>' + names[i + 1].id] = p;
    }
    // terugweg: kennis gaat terug naar de bezoeker
    var last = pos[4], first = pos[0], dr;
    if (vertical) {
      var rx = last.x + bw + 30;
      dr = 'M' + (last.x + bw) + ',' + (last.y + bh / 2) + ' L' + (rx - 10) + ',' + (last.y + bh / 2) + ' Q' + rx + ',' + (last.y + bh / 2) + ' ' + rx + ',' + (last.y + bh / 2 - 10) +
           ' L' + rx + ',' + (first.y + bh / 2 + 10) + ' Q' + rx + ',' + (first.y + bh / 2) + ' ' + (rx - 10) + ',' + (first.y + bh / 2) + ' L' + (first.x + bw) + ',' + (first.y + bh / 2);
    } else {
      var ry = last.y + bh + 64;
      dr = 'M' + (last.x + bw / 2) + ',' + (last.y + bh) + ' L' + (last.x + bw / 2) + ',' + (ry - 12) + ' Q' + (last.x + bw / 2) + ',' + ry + ' ' + (last.x + bw / 2 - 12) + ',' + ry +
           ' L' + (first.x + bw / 2 + 12) + ',' + ry + ' Q' + (first.x + bw / 2) + ',' + ry + ' ' + (first.x + bw / 2) + ',' + (ry - 12) + ' L' + (first.x + bw / 2) + ',' + (first.y + bh);
      var lbl = s('text', { x: (first.x + last.x + bw) / 2, y: ry - 10, 'text-anchor': 'middle', class: 'node-sub' }, 'betere suggesties en volgorde, direct voor de volgende bezoeker');
      gTracks.appendChild(lbl);
    }
    var ret = s('path', { d: dr, class: 'track-return' });
    gTracks.appendChild(ret);
    LOOP.segs['serve>visitors'] = ret;

    // knopen
    names.forEach(function (n, i) {
      var g = s('g', { transform: 'translate(' + pos[i].x + ',' + pos[i].y + ')' });
      var box = s('rect', { width: bw, height: bh, rx: 6, class: 'node-box' });
      g.appendChild(box);
      var tx = n.id === 'learn' && !vertical ? 14 : 14;
      var title = s('text', { x: tx, y: 24, class: 'node-title' }, n.title);
      var value = s('text', { x: tx, y: vertical ? 56 : 64, class: 'node-value' }, '–');
      var sub1 = s('text', { x: tx, y: vertical ? 76 : 90, class: 'node-sub' }, '');
      var sub2 = s('text', { x: tx, y: vertical ? 90 : 107, class: 'node-sub' }, '');
      g.appendChild(title); g.appendChild(value); g.appendChild(sub1); g.appendChild(sub2);
      if (n.id === 'learn') {
        var cx = bw - 30, cy = vertical ? 48 : 56, r = 16;
        g.appendChild(s('circle', { cx: cx, cy: cy, r: r, class: 'ring-bg' }));
        var ring = s('circle', { cx: cx, cy: cy, r: r, class: 'ring-fg', transform: 'rotate(-90 ' + cx + ' ' + cy + ')' });
        LOOP.ringLen = 2 * Math.PI * r;
        ring.style.strokeDasharray = String(LOOP.ringLen);
        ring.style.strokeDashoffset = String(LOOP.ringLen);
        g.appendChild(ring);
        LOOP.refs.ring = ring;
        LOOP.refs.learnValue = value;
        LOOP.refs.learnG = g;
        LOOP.refs.learnCenter = { x: pos[i].x + cx, y: pos[i].y + cy };
      }
      gNodes.appendChild(g);
      LOOP.refs[n.id] = { g: g, box: box, value: value, sub1: sub1, sub2: sub2, x: pos[i].x, y: pos[i].y, w: bw, h: bh };
    });
    LOOP.gPart = gPart;
    LOOP.particles = [];
    if (state.dash) updateLoop(state.dash);
    tick();
    if (!LOOP.raf && !reduceMotion) LOOP.raf = requestAnimationFrame(animate);
    legendKeys($('#loop-legend'), [
      { label: 'Zoekopdracht', color: '--s1' }, { label: 'Klik', color: '--s2' },
      { label: 'Suggestie', color: '--s3' }, { label: 'Winkelmand of aankoop', color: '--s4' },
      { label: 'Kennis uit leerstap', color: '--ink' }
    ]);
  }

  function setNode(id, value, sub1, sub2, fmt) {
    var r = LOOP.refs[id];
    if (!r) return;
    if (typeof value === 'number') tween(r.value, value, fmt || fmtN, 700);
    else if (value != null) r.value.textContent = value;
    r.sub1.textContent = sub1 || '';
    r.sub2.textContent = sub2 || '';
  }

  function updateLoop(d) {
    var st = d.status || {}, m = d.model || {}, today = d.today || {};
    var runs = d.learn_runs || [];
    var lastRun = runs.length ? runs[runs.length - 1].r : null;
    var sug = sumSuggest(d.suggest_today);
    setNode('visitors', st.events_5m || 0, 'signalen in de laatste', '5 minuten');
    setNode('signals', state.queue, 'wachten op de', 'volgende leerstap');
    var learnSub = lastRun ? fmtN((lastRun.searches || 0) + (lastRun.interactions || 0) + (lastRun.suggests || 0)) + ' signalen' : 'nog geen';
    var r = LOOP.refs.learn;
    if (r) { r.sub1.textContent = 'tot de volgende stap'; r.sub2.textContent = 'vorige ' + (st.last_learn ? hhmm(st.last_learn) + ': ' : '') + learnSub; }
    setNode('model', m.learned_pairs || 0, 'geleerde koppelingen', '+ ' + fmtN(m.rewrites) + ' herschrijvingen');
    setNode('serve', sug.shown ? sug.used / sug.shown : null, 'suggesties gebruikt', fmtN(+st.explore_rate || 0) + '% exploratie', function (x) { return fmtPct(x); });
  }

  function addParticle(chain, color, opts) {
    if (reduceMotion || !LOOP.gPart) return;
    opts = opts || {};
    if (LOOP.particles.length > 140) return;
    var c = s('circle', { r: opts.r || 4, fill: color, class: 'marker' });
    c.style.opacity = '0';
    LOOP.gPart.appendChild(c);
    LOOP.particles.push({ c: c, chain: chain, idx: 0, t0: performance.now() + (opts.delay || 0), speed: opts.speed || 0.16, onEnd: opts.onEnd });
  }
  function animate(now) {
    LOOP.raf = requestAnimationFrame(animate);
    for (var i = LOOP.particles.length - 1; i >= 0; i--) {
      var p = LOOP.particles[i];
      if (now < p.t0) continue;
      var seg = LOOP.segs[p.chain[p.idx]];
      if (!seg) { remove(i); continue; }
      if (!p.len) p.len = seg.getTotalLength();
      var dist = (now - p.t0) * p.speed;
      if (dist >= p.len) {
        p.idx++; p.t0 = now; p.len = 0;
        if (p.idx >= p.chain.length) { if (p.onEnd) p.onEnd(); remove(i); continue; }
        if (p.chain[p.idx - 1].split('>')[1] !== 'signals') flash(p.chain[p.idx - 1].split('>')[1]);
        continue;
      }
      var pt = seg.getPointAtLength(dist);
      p.c.setAttribute('cx', pt.x); p.c.setAttribute('cy', pt.y);
      p.c.style.opacity = '1';
    }
    function remove(j) { var q = LOOP.particles[j]; if (q.c.parentNode) q.c.parentNode.removeChild(q.c); LOOP.particles.splice(j, 1); }
  }
  function flash(id) {
    var r = LOOP.refs[id];
    if (!r) return;
    r.box.classList.add('hot');
    clearTimeout(r._ft);
    r._ft = setTimeout(function () { r.box.classList.remove('hot'); }, 380);
  }
  function arrivedAtSignals() {
    state.queue++;
    var r = LOOP.refs.signals;
    if (r) { r.value._v = state.queue; r.value.textContent = fmtN(state.queue); }
    flash('signals');
  }

  function learnPulse(run) {
    var n = run ? Math.min(16, Math.max(5, Math.round(((run.searches || 0) + (run.interactions || 0) + (run.suggests || 0)) / 15))) : 8;
    var accent = cssVar('--ink');
    flash('learn');
    var c = LOOP.refs.learnCenter;
    if (c && !reduceMotion) {
      var ring = s('circle', { cx: c.x, cy: c.y, r: 18, class: 'pulse-ring' });
      LOOP.gPart.appendChild(ring);
      var t0 = performance.now();
      (function grow(now) {
        var p = Math.min(1, (now - t0) / 900);
        ring.setAttribute('r', 18 + p * 46);
        ring.style.opacity = String(1 - p);
        if (p < 1) requestAnimationFrame(grow); else ring.parentNode && ring.parentNode.removeChild(ring);
      })(t0);
    }
    // wachtrij leegt zich in de leerstap
    var q = state.queue;
    for (var i = 0; i < Math.min(q, 14); i++) addParticle(['signals>learn'], cssVar('--axis'), { delay: i * 60, speed: 0.22, r: 3 });
    state.queue = 0;
    var sr = LOOP.refs.signals;
    if (sr) tween(sr.value, 0, fmtN, 800);
    // nieuwe kennis stroomt naar het model en terug naar de bezoeker
    for (var k = 0; k < n; k++) {
      addParticle(['learn>model', 'model>serve', 'serve>visitors'], accent, { delay: 500 + k * 110, speed: 0.2, r: 4.5 });
    }
  }

  /* =====================================================================
     LIVE FEED
     ===================================================================== */
  function feedKey(it) { return it.k + '|' + it.at + '|' + (it.q || it.title || ''); }
  function describe(it) {
    var kind = KIND[it.k] ? KIND[it.k].label : it.k;
    var detail = '', flag = null;
    if (it.k === 'search') {
      detail = '‘' + (it.q || '') + '’ · ' + (it.n == null ? 'aantal onbekend' : fmtN(it.n) + ' resultaten');
      if (it.n === 0) flag = { t: '0 resultaten', c: 'crit' };
    } else if (it.k === 'suggest') {
      var src = it.src === 'native' ? 'Nedgame-dropdown' : 'slimme dropdown';
      if (it.pick === 'product') { kind = 'Suggestie gekozen'; detail = 'product ' + (it.pos || '?') + ' bij ‘' + it.q + '’ · ' + src; if (it.explore) flag = { t: 'exploratie', c: 'good' }; }
      else if (it.pick) { kind = 'Suggestie gekozen'; detail = 'doorzoeken vanaf ‘' + it.q + '’ · ' + src; }
      else { kind = 'Suggesties getoond'; detail = fmtN(it.n) + ' producten bij ‘' + it.q + '’ · ' + src; }
    } else if (it.k === 'click') {
      detail = (it.pos ? 'positie ' + it.pos + ' · ' : '') + (it.title || 'product');
    } else if (it.k === 'add_to_cart' || it.k === 'purchase' || it.k === 'wishlist') {
      detail = (it.title || 'product') + (it.linked ? ' · na zoeken' : '');
      if (it.linked) flag = { t: 'toegeschreven', c: 'good' };
    } else if (it.k === 'learn') {
      var r = it.r || {};
      kind = 'Leerstap';
      detail = fmtN((r.searches || 0) + (r.interactions || 0) + (r.suggests || 0)) + ' signalen verwerkt · ' + fmtN(r.pairs) + ' koppelingen bijgewerkt' + (r.rewrites ? ' · ' + r.rewrites + ' herschrijving' + (r.rewrites > 1 ? 'en' : '') : '');
    }
    return { kind: kind, detail: detail, flag: flag };
  }
  function feedItem(it, animateIn) {
    var li = el('li', { class: 'feed-item' + (it.k === 'learn' ? ' learn' : '') });
    if (!animateIn) li.style.animation = 'none';
    var dot = el('span', { class: 'dot', 'aria-hidden': 'true' });
    dot.style.background = cssVar(KIND[it.k] ? KIND[it.k].color : '--muted');
    var info = describe(it);
    var what = el('div', { class: 'what' });
    var k = el('span', { class: 'kind' }, info.kind);
    what.appendChild(k);
    if (info.flag) what.appendChild(el('span', { class: 'flag ' + info.flag.c }, info.flag.t));
    what.appendChild(el('div', { class: 'detail', title: info.detail }, info.detail));
    var t = el('span', { class: 't', 'data-at': it.at }, ago(it.at));
    li.appendChild(dot); li.appendChild(what); li.appendChild(t);
    return li;
  }

  function onFeed(f, first) {
    var items = (f.items || []).slice().sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    var list = $('#feed-list');
    var fresh = [];
    items.forEach(function (it) {
      var key = feedKey(it);
      if (state.seen[key]) return;
      state.seen[key] = 1;
      fresh.push(it);
    });
    if (!fresh.length) { $('#feed-rate').textContent = viewsText(f); return; }
    var newest = fresh[fresh.length - 1].at;
    if (!state.feedSince || new Date(newest) > new Date(state.feedSince)) state.feedSince = newest;

    if (first) {
      // eerste lading: vullen zonder animatie, wachtrij = signalen sinds laatste leerstap
      var lastLearn = state.lastLearnAt ? new Date(state.lastLearnAt) : null;
      fresh.slice(-50).forEach(function (it) { list.insertBefore(feedItem(it, false), list.firstChild); });
      state.queue = fresh.filter(function (it) { return it.k !== 'learn' && (!lastLearn || new Date(it.at) > lastLearn); }).length;
      var r = LOOP.refs.signals;
      if (r) tween(r.value, state.queue, fmtN, 700);
    } else {
      var span = POLL_FEED;
      var t0 = new Date(fresh[0].at).getTime();
      fresh.forEach(function (it) {
        var delay = Math.min(span - 300, Math.max(0, new Date(it.at).getTime() - t0));
        setTimeout(function () {
          list.insertBefore(feedItem(it, true), list.firstChild);
          while (list.children.length > 60) list.removeChild(list.lastChild);
          if (it.k === 'learn') {
            state.lastLearnAt = it.at;
            learnPulse(it.r);
            refreshDash(false);
          } else {
            addParticle(['visitors>signals'], cssVar(KIND[it.k] ? KIND[it.k].color : '--muted'),
              { speed: 0.18, onEnd: arrivedAtSignals });
            if (reduceMotion) arrivedAtSignals();
          }
        }, reduceMotion ? 0 : delay);
      });
    }
    $('#feed-rate').textContent = viewsText(f);
  }
  function viewsText(f) { return f && f.views_5m != null ? fmtN(f.views_5m) + ' productweergaven / 5 min' : ''; }

  /* =====================================================================
     KERNCIJFERS
     ===================================================================== */
  function sumSuggest(st) {
    var out = { shown: 0, used: 0, product: 0 };
    if (!st) return out;
    Object.keys(st).forEach(function (k) { out.shown += st[k].shown || 0; out.used += st[k].used || 0; out.product += st[k].product || 0; });
    return out;
  }

  function renderKpis(d) {
    var t = d.today || {}, y = d.yesterday || {};
    var ctr = ratio(t.with_click, t.searches), yctr = ratio(y.with_click, y.searches);
    tween($('#hero-ctr'), ctr, function (x) { return fmtPct(x, 1); });
    var hd = $('#hero-delta');
    clear(hd);
    if (yctr != null && ctr != null) {
      var diff = (ctr - yctr) * 100;
      var span = el('span', { class: diff >= 0 ? 'delta-up' : 'delta-down' }, (diff >= 0 ? '+' : '−') + fmtDec(Math.abs(diff), 1) + ' procentpunt');
      hd.appendChild(span);
      hd.appendChild(document.createTextNode(' t.o.v. gisteren tot dit tijdstip'));
    } else {
      hd.textContent = fmtN(t.with_click) + ' van ' + fmtN(t.searches) + ' zoekopdrachten · gisteren nog geen data';
    }
    renderSpark(d.hourly || []);

    var sug = sumSuggest(d.suggest_today);
    var tiles = [
      { label: 'Zoekopdrachten vandaag', value: t.searches, fmt: fmtN, note: y.searches ? 'gisteren tot nu: ' + fmtN(y.searches) : 'gemeten sinds vandaag' },
      { label: 'Zonder resultaat', value: ratio(t.zero, t.searches), fmt: function (x) { return fmtPct(x, 1); }, note: fmtN(t.zero) + ' zoekopdrachten' },
      { label: 'Positie van de eerste klik', value: t.avg_pos, fmt: function (x) { return fmtDec(x, 1); }, note: 'MRR ' + fmtDec(t.mrr, 3) + ' (hoger is beter)' },
      { label: 'Suggesties gebruikt', value: ratio(sug.used, sug.shown), fmt: function (x) { return fmtPct(x, 0); }, note: fmtN(sug.shown) + ' dropdowns · ' + fmtN(sug.product) + ' direct naar product' },
      { label: 'In winkelmand na zoeken', value: t.carts, fmt: fmtN, note: fmtN(t.purchases) + ' aankopen toegeschreven' },
      { label: 'Kliks op zoekresultaten', value: t.clicks, fmt: fmtN, note: 'gemiddeld ' + fmtDec(ratio(t.clicks, t.with_click), 1) + ' per zoekopdracht met klik' }
    ];
    var box = $('#tiles');
    if (box.children.length !== tiles.length) {
      clear(box);
      tiles.forEach(function () {
        var tile = el('div', { class: 'tile' });
        tile.appendChild(el('div', { class: 'tile-label' }));
        tile.appendChild(el('div', { class: 'tile-value' }, '–'));
        tile.appendChild(el('div', { class: 'tile-note' }));
        box.appendChild(tile);
      });
    }
    tiles.forEach(function (tl, i) {
      var tile = box.children[i];
      tile.children[0].textContent = tl.label;
      tween(tile.children[1], tl.value, tl.fmt);
      tile.children[2].textContent = tl.note;
    });
  }

  function renderSpark(hourly) {
    var svg = $('#hero-spark');
    clear(svg);
    var pts = hourly.slice(-24).map(function (h, i) { return { i: i, v: h.searches >= 3 ? h.with_click / h.searches : null, h: h }; });
    var vals = pts.filter(function (p) { return p.v != null; });
    if (vals.length < 2) return;
    var max = Math.max.apply(null, vals.map(function (p) { return p.v; })) || 1;
    var X = function (i) { return (i / 23) * 236 + 2; }, Y = function (v) { return 44 - (v / max) * 38; };
    var d = '';
    vals.forEach(function (p, k) { d += (k ? 'L' : 'M') + X(p.i).toFixed(1) + ',' + Y(p.v).toFixed(1); });
    var path = s('path', { d: d, class: 'line', stroke: cssVar('--axis') });
    svg.appendChild(path);
    var lp = vals[vals.length - 1];
    svg.appendChild(s('circle', { cx: X(lp.i), cy: Y(lp.v), r: 4, fill: cssVar('--accent'), class: 'marker' }));
  }

  /* =====================================================================
     LEERMODULES
     ===================================================================== */
  function renderModules(d) {
    var m = d.model || {}, st = d.status || {}, ex = d.explore || {};
    var pb1 = (d.position_bias || [])[0] || { impr: 0 };
    var calib = Math.min(1, (pb1.impr || 0) / 500);
    var mods = [
      { name: 'Klik- en conversieleren', state: m.learned_pairs > 0 ? 'active' : 'waiting', value: fmtN(m.learned_pairs) + ' koppelingen',
        desc: 'Welk product mensen kiezen bij een zoekterm, gecorrigeerd voor de plek in de lijst. Winkelmand telt 2×, aankoop 4×.' },
      { name: 'Positie-bias', state: calib >= 1 ? 'active' : 'learning', value: fmtPct(calib) + ' gekalibreerd', meter: calib,
        desc: 'Het model past de klikcurve per positie aan zodra plek 1 500 impressies heeft (nu ' + fmtN(pb1.impr) + ').' },
      { name: 'Zoeksuggesties-CTR', state: m.suggest_pairs > 0 ? 'active' : 'waiting', value: fmtN(m.suggest_pairs) + ' prefix-paren',
        desc: m.suggest_pairs > 0 ? 'Leert per getypt begin welke zoeksuggestie gekozen wordt.' : 'Start zodra de nieuwe VWO-variant live is; die logt welke suggesties getoond en gekozen worden.' },
      { name: 'Herschrijvingen', state: m.rewrites > 0 ? 'active' : 'waiting', value: fmtN(m.rewrites) + ' geleerd',
        desc: 'Zoekopdracht zonder succes, gevolgd door een vergelijkbare die wél werkt (typfout, extra woord).' },
      { name: 'Synoniemen', state: m.learned_synonyms > 0 ? 'active' : 'waiting', value: fmtN(m.learned_synonyms) + ' geleerd · ' + fmtN(m.curated_synonyms) + ' handmatig',
        desc: 'Elke nacht: herschrijvingen met 5× steun en 30% zekerheid worden een synoniem.' },
      { name: 'Personalisatie', state: st.profiles > 0 ? 'active' : 'waiting', value: fmtN(st.profiles) + ' profielen',
        desc: fmtN(st.persistent_profiles) + ' met toestemming (blijvend), de rest per sessie. Platform, categorie, smaak en nieuw/tweedehands.' },
      { name: 'Exploratie', state: ex.shown > 0 ? 'active' : 'waiting', value: fmtN(+st.explore_rate || 0) + '% van de dropdowns',
        desc: ex.shown > 0 ? fmtN(ex.shown) + ' keer een nieuw product getest in de laatste 14 dagen.' : 'Draait in de nieuwe VWO-variant; nog niet getoond.' },
      { name: 'Ranking-gewichten', state: st.last_weights ? 'active' : 'waiting', value: st.last_weights ? 'bijgewerkt ' + hhmm(st.last_weights.at) : 'niet actief',
        desc: 'Leert alleen van de eigen Supabase-zoekpagina. Nedgame’s resultatenpagina levert geen features, dus dit blijft stil tot die live is.' }
    ];
    var box = $('#modules');
    clear(box);
    mods.forEach(function (md) {
      var c = el('div', { class: 'module' });
      var head = el('div', { class: 'module-head' });
      head.appendChild(el('span', { class: 'module-name' }, md.name));
      head.appendChild(el('span', { class: 'state ' + md.state }, md.state === 'active' ? 'actief' : md.state === 'learning' ? 'leert' : 'wacht'));
      c.appendChild(head);
      c.appendChild(el('div', { class: 'module-value' }, md.value));
      if (md.meter != null) {
        var mt = el('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(md.meter * 100)) });
        var fill = el('span');
        mt.appendChild(fill);
        c.appendChild(mt);
        requestAnimationFrame(function () { fill.style.width = (md.meter * 100) + '%'; });
      }
      c.appendChild(el('div', { class: 'module-desc' }, md.desc));
      box.appendChild(c);
    });
  }

  /* =====================================================================
     GELEERDE KOPPELINGEN (divergerende balk)
     ===================================================================== */
  function renderPairs(d) {
    var box = $('#pairs');
    var rows = (d.top_pairs || []).concat(d.demoted_pairs || []);
    clear(box);
    if (!rows.length) { box.appendChild(emptyMsg('Nog geen koppelingen met genoeg signaal.', 'Ze verschijnen na de eerste kliks op zoekresultaten.')); return; }
    var lo = -0.5, hi = 1.5, zero = (0 - lo) / (hi - lo) * 100;
    var head = el('div', { class: 'row row-head' });
    head.appendChild(el('span', { class: 'q' }, 'Zoekterm'));
    head.appendChild(el('span', { class: 'sub' }, 'Product'));
    head.appendChild(el('span', { class: 'val' }, 'Effect op ranking'));
    box.appendChild(head);
    var wrap = el('div', { class: 'rows' });
    rows.forEach(function (p) {
      var r = el('div', { class: 'row' });
      r.appendChild(el('span', { class: 'q', title: p.q }, p.q));
      r.appendChild(el('span', { class: 'sub', title: p.title || '' }, p.title || '–'));
      var cell = el('div');
      var bar = el('div', { class: 'div-bar' });
      var ax = el('span', { class: 'axis0' }); ax.style.left = zero + '%';
      var b = el('span', { class: 'b ' + (p.score >= 0 ? 'p' : 'n') });
      var w = Math.abs(p.score) / (hi - lo) * 100;
      b.style.left = (p.score >= 0 ? zero : zero) + '%'; b.style.width = '0%';
      bar.appendChild(ax); bar.appendChild(b);
      cell.appendChild(bar);
      r.appendChild(cell);
      requestAnimationFrame(function () {
        if (p.score >= 0) { b.style.left = zero + '%'; b.style.width = w + '%'; }
        else { b.style.left = (zero - w) + '%'; b.style.width = w + '%'; }
      });
      var tipHtml = '<strong>' + esc(p.q) + '</strong> → ' + esc(p.title || '') + '<br>Score ' + fmtDec(p.score, 2) +
        '<br>' + fmtN(p.impr) + ' keer getoond · verwacht ' + fmtDec(p.exp, 1) + ' kliks<br>' + fmtN(p.clicks) + ' kliks · ' + fmtN(p.carts) + ' winkelmand · ' + fmtN(p.purchases) + ' aankoop';
      r.addEventListener('mousemove', function (e) { showTip(e, tipHtml); });
      r.addEventListener('mouseleave', hideTip);
      wrap.appendChild(r);
    });
    box.appendChild(wrap);
    var note = el('p', { class: 'muted', style: 'margin-top:10px;font-size:12.5px' },
      'Balk naar rechts: product wordt hoger getoond bij deze zoekterm. Naar links: lager. Schaal −0,5 tot +1,5.');
    box.appendChild(note);
  }

  function emptyMsg(a, b) {
    var p = el('p', { class: 'empty' });
    p.appendChild(el('strong', null, a));
    if (b) p.appendChild(document.createTextNode(' ' + b));
    return p;
  }

  function renderRewrites(d) {
    var box = $('#rewrites');
    clear(box);
    var m = d.model || {};
    var rows = d.rewrites || [];
    if (!rows.length) box.appendChild(emptyMsg('Nog geen herschrijvingen.', 'Die ontstaan als iemand na een mislukte zoekopdracht een vergelijkbare probeert die wél werkt.'));
    rows.forEach(function (r) {
      var row = el('div', { class: 'rw' });
      row.appendChild(el('span', { class: 'from', title: r.from }, r.from));
      row.appendChild(el('span', { class: 'arrow', 'aria-label': 'wordt' }, '→'));
      row.appendChild(el('span', { class: 'to', title: r.to }, r.to));
      var conf = el('div', { class: 'conf' });
      var mt = el('div', { class: 'meter' }); var f = el('span'); mt.appendChild(f);
      conf.appendChild(mt);
      conf.appendChild(el('span', null, fmtN(r.support) + '× · ' + fmtPct(r.conf)));
      row.appendChild(conf);
      requestAnimationFrame(function () { f.style.width = Math.min(100, (r.conf || 0) * 100) + '%'; });
      var tipHtml = '<strong>' + esc(r.from) + '</strong> → <strong>' + esc(r.to) + '</strong><br>' + fmtN(r.support) + ' keer gezien · zekerheid ' + fmtPct(r.conf) +
        '<br>' + (r.synonym ? 'Actief als synoniem' : 'Wordt synoniem bij 5× steun en 30% zekerheid');
      row.addEventListener('mousemove', function (e) { showTip(e, tipHtml); });
      row.addEventListener('mouseleave', hideTip);
      box.appendChild(row);
    });
    box.appendChild(el('p', { class: 'muted', style: 'margin-top:10px;font-size:12.5px' },
      fmtN(m.learned_synonyms) + ' geleerde synoniemen actief, naast ' + fmtN(m.curated_synonyms) + ' handmatige. ' +
      fmtN(m.learned_suggestions) + ' zoeksuggesties komen uit echt zoekgedrag.'));
  }

  /* =====================================================================
     GRAFIEK-HULP (SVG)
     ===================================================================== */
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  function frame(container, height) {
    clear(container);
    var W = Math.max(280, container.clientWidth || 600), H = height || 210;
    var m = { t: 12, r: 8, b: 26, l: 40 };
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img' });
    container.appendChild(svg);
    return { svg: svg, W: W, H: H, m: m, iw: W - m.l - m.r, ih: H - m.t - m.b };
  }
  function yAxis(f, max, fmt, ticks) {
    if (!ticks) {
      // kies een aantal stappen waarbij elke stap een rond getal is (1, 2, 2,5 of 5 × 10^n)
      ticks = 4;
      [4, 5, 2, 3].some(function (t) {
        var st = max / t, p = Math.pow(10, Math.floor(Math.log10(st) + 1e-9)), q = Math.round(st / p * 1000) / 1000;
        if ([1, 2, 2.5, 5].indexOf(q) !== -1) { ticks = t; return true; }
        return false;
      });
    }
    for (var i = 0; i <= ticks; i++) {
      var v = max * i / ticks, y = f.m.t + f.ih - (v / max) * f.ih;
      f.svg.appendChild(s('line', { x1: f.m.l, x2: f.W - f.m.r, y1: y, y2: y, class: i === 0 ? 'baseline' : 'gridline' }));
      f.svg.appendChild(s('text', { x: f.m.l - 6, y: y + 4, 'text-anchor': 'end', class: 'tick' }, fmt(v)));
    }
  }
  // kolommen, optioneel gestapeld (series: [{key,color}]); 2px gat tussen segmenten
  function columns(container, data, series, opts) {
    var f = frame(container, opts.height);
    var totals = data.map(function (d) { return series.reduce(function (a, s2) { return a + (d[s2.key] || 0); }, 0); });
    var max = niceMax(Math.max.apply(null, totals.concat([opts.minMax || 1])));
    yAxis(f, max, opts.yfmt || compact);
    var n = data.length, band = f.iw / n, bw = Math.min(24, Math.max(2, band * 0.62));
    data.forEach(function (d, i) {
      var x = f.m.l + i * band + (band - bw) / 2;
      var base = f.m.t + f.ih;
      series.forEach(function (sr, si) {
        var v = d[sr.key] || 0;
        if (v <= 0) return;
        var h = (v / max) * f.ih;
        var isTop = series.slice(si + 1).every(function (s3) { return !(d[s3.key] > 0); });
        var gap = si > 0 ? 2 : 0;
        var hh = Math.max(1, h - gap);
        var rect = roundedTop(x, base - h, bw, hh, isTop ? Math.min(4, bw / 2) : 0);
        rect.setAttribute('fill', cssVar(sr.color));
        rect.setAttribute('class', 'bar');
        if (!reduceMotion && opts.animate) {
          rect.style.transformOrigin = x + 'px ' + base + 'px';
          rect.style.transform = 'scaleY(0)';
          rect.style.transition = 'transform .8s cubic-bezier(.2,.7,.2,1) ' + (i * 8) + 'ms';
          requestAnimationFrame(function () { requestAnimationFrame(function () { rect.style.transform = 'scaleY(1)'; }); });
        }
        f.svg.appendChild(rect);
        base -= h;
      });
      var hit = s('rect', { x: f.m.l + i * band, y: f.m.t, width: band, height: f.ih, class: 'hit' });
      hit.addEventListener('mousemove', function (e) { showTip(e, opts.tip(d, i)); });
      hit.addEventListener('mouseleave', hideTip);
      f.svg.appendChild(hit);
    });
    xLabels(f, data, opts.xlabel, opts.xEvery || Math.ceil(n / 8), band);
    return f;
  }
  function roundedTop(x, y, w, h, r) {
    r = Math.min(r, h);
    var d = 'M' + x + ',' + (y + h) + ' L' + x + ',' + (y + r) + ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
            ' L' + (x + w - r) + ',' + y + ' Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + ' L' + (x + w) + ',' + (y + h) + ' Z';
    return s('path', { d: d });
  }
  function xLabels(f, data, labelFn, every, band) {
    data.forEach(function (d, i) {
      if (i % every !== 0 && i !== data.length - 1) return;
      if (i === data.length - 1 && i % every !== 0 && (i % every) < every * 0.6) return;
      f.svg.appendChild(s('text', { x: f.m.l + i * band + band / 2, y: f.H - 6, 'text-anchor': 'middle', class: 'tick' }, labelFn(d, i)));
    });
  }
  // lijnen (1 as); punten null = gat
  function lines(container, labels, series, opts) {
    var f = frame(container, opts.height);
    var all = [];
    series.forEach(function (sr) { sr.values.forEach(function (v) { if (v != null) all.push(v); }); });
    var max = opts.max || niceMax(Math.max.apply(null, all.concat([0.0001])));
    yAxis(f, max, opts.yfmt);
    var n = labels.length, band = f.iw / Math.max(1, n);
    var X = function (i) { return f.m.l + i * band + band / 2; };
    var Y = function (v) { return f.m.t + f.ih - (v / max) * f.ih; };
    series.forEach(function (sr) {
      var d = '', started = false, lastPt = null;
      sr.values.forEach(function (v, i) {
        if (v == null) { started = false; return; }
        d += (started ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1);
        started = true; lastPt = { x: X(i), y: Y(v), v: v };
      });
      if (!d) return;
      var p = s('path', { d: d, class: 'line', stroke: cssVar(sr.color) });
      f.svg.appendChild(p);
      if (!reduceMotion && opts.animate) {
        var len = p.getTotalLength();
        p.style.setProperty('--len', len);
        p.classList.add('draw');
      }
      (sr.dots ? sr.values : []).forEach(function (v, i) {
        if (v == null) return;
        f.svg.appendChild(s('circle', { cx: X(i), cy: Y(v), r: 4, fill: cssVar(sr.color), class: 'marker' }));
      });
      if (lastPt && opts.endLabel) {
        f.svg.appendChild(s('circle', { cx: lastPt.x, cy: lastPt.y, r: 4, fill: cssVar(sr.color), class: 'marker' }));
        f.svg.appendChild(s('text', { x: Math.min(lastPt.x + 8, f.W - 30), y: lastPt.y - 8, class: 'dlabel' }, opts.yfmt(lastPt.v)));
      }
    });
    var xh = s('line', { y1: f.m.t, y2: f.m.t + f.ih, class: 'xhair', visibility: 'hidden' });
    f.svg.appendChild(xh);
    labels.forEach(function (lb, i) {
      var hit = s('rect', { x: f.m.l + i * band, y: f.m.t, width: band, height: f.ih, class: 'hit' });
      hit.addEventListener('mousemove', function (e) { xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.setAttribute('visibility', 'visible'); showTip(e, opts.tip(i)); });
      hit.addEventListener('mouseleave', function () { xh.setAttribute('visibility', 'hidden'); hideTip(); });
      f.svg.appendChild(hit);
    });
    xLabels(f, labels, function (lb) { return lb; }, opts.xEvery || Math.ceil(n / 8), band);
    return { f: f, X: X, Y: Y, max: max, band: band };
  }

  /* =====================================================================
     POSITIE-BIAS
     ===================================================================== */
  function renderPositionBias(d, animateIn) {
    var pb = d.position_bias || [];
    var box = $('#pb-chart');
    if (!pb.length) { clear(box); return; }
    var ctr1 = pb[0].impr > 0 ? pb[0].clicks / pb[0].impr : 0;
    var rel = pb.map(function (p) { return p.impr >= 10 && ctr1 > 0 ? Math.min(1.5, (p.clicks / p.impr) / ctr1) : null; });
    legendKeys($('#pb-legend'), [{ label: 'Gemeten (t.o.v. plek 1)', color: '--s3', shape: 'bar' }, { label: 'Model', color: '--s1', shape: 'line' }]);
    var f = frame(box, 220);
    var max = 1.2;
    yAxis(f, max, function (v) { return fmtPct(v); }, 4);
    var n = pb.length, band = f.iw / n, bw = Math.min(24, band - 6);
    var X = function (i) { return f.m.l + i * band + band / 2; };
    var Y = function (v) { return f.m.t + f.ih - (v / max) * f.ih; };
    rel.forEach(function (v, i) {
      if (v == null) return;
      var h = (v / max) * f.ih;
      var r = roundedTop(X(i) - bw / 2, f.m.t + f.ih - h, bw, h, 4);
      r.setAttribute('fill', cssVar('--s3'));
      r.setAttribute('class', 'bar');
      if (animateIn && !reduceMotion) {
        r.style.transformOrigin = X(i) + 'px ' + (f.m.t + f.ih) + 'px';
        r.style.transform = 'scaleY(0)';
        r.style.transition = 'transform .8s cubic-bezier(.2,.7,.2,1) ' + (i * 40) + 'ms';
        requestAnimationFrame(function () { requestAnimationFrame(function () { r.style.transform = 'scaleY(1)'; }); });
      }
      f.svg.appendChild(r);
    });
    var dpath = '';
    pb.forEach(function (p, i) { dpath += (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(p.prob).toFixed(1); });
    var line = s('path', { d: dpath, class: 'line', stroke: cssVar('--s1') });
    f.svg.appendChild(line);
    if (animateIn && !reduceMotion) { line.style.setProperty('--len', line.getTotalLength()); line.classList.add('draw'); }
    pb.forEach(function (p, i) { f.svg.appendChild(s('circle', { cx: X(i), cy: Y(p.prob), r: 4, fill: cssVar('--s1'), class: 'marker' })); });
    pb.forEach(function (p, i) {
      f.svg.appendChild(s('text', { x: X(i), y: f.H - 6, 'text-anchor': 'middle', class: 'tick' }, String(p.pos)));
      var hit = s('rect', { x: f.m.l + i * band, y: f.m.t, width: band, height: f.ih, class: 'hit' });
      hit.addEventListener('mousemove', function (e) {
        showTip(e, '<strong>Plek ' + p.pos + '</strong><br>' + fmtN(p.impr) + ' keer getoond · ' + fmtN(p.clicks) + ' kliks<br>Gemeten: ' +
          (rel[i] == null ? 'te weinig data' : fmtPct(rel[i])) + ' van plek 1<br>Model: ' + fmtPct(p.prob));
      });
      hit.addEventListener('mouseleave', hideTip);
      f.svg.appendChild(hit);
    });
    f.svg.appendChild(s('text', { x: f.W / 2 + f.m.l / 2, y: f.H + 14, 'text-anchor': 'middle', class: 'tick' }, ''));
    var cal = $('#pb-calib');
    clear(cal);
    var frac = Math.min(1, (pb[0].impr || 0) / 500);
    cal.appendChild(el('span', null, frac >= 1 ? 'Gekalibreerd: het model past de curve nu elke leerstap bij met de gemeten waarden.'
      : 'Kalibratie: ' + fmtN(pb[0].impr) + ' van 500 impressies op plek 1. Tot die tijd gebruikt het model de startcurve.'));
    var mt = el('div', { class: 'meter' }); var fill = el('span'); mt.appendChild(fill); cal.appendChild(mt);
    requestAnimationFrame(function () { fill.style.width = (frac * 100) + '%'; });
  }

  /* =====================================================================
     LEERSTAPPEN
     ===================================================================== */
  function renderRuns(d, animateIn) {
    var runs = (d.learn_runs || []).map(function (r) {
      var x = r.r || {};
      return { at: r.at, searches: x.searches || 0, interactions: x.interactions || 0, suggests: x.suggests || 0, pairs: x.pairs || 0, rewrites: x.rewrites || 0 };
    });
    var box = $('#runs-chart');
    legendKeys($('#runs-legend'), [{ label: 'Zoekopdrachten', color: '--s1', shape: 'bar' }, { label: 'Interacties', color: '--s2', shape: 'bar' }, { label: 'Suggestie-dropdowns', color: '--s3', shape: 'bar' }]);
    if (!runs.length) { clear(box); box.appendChild(emptyMsg('Nog geen leerstappen.', 'De eerste draait binnen 5 minuten na het eerste signaal.')); return; }
    columns(box, runs, [{ key: 'searches', color: '--s1' }, { key: 'interactions', color: '--s2' }, { key: 'suggests', color: '--s3' }], {
      height: 230, animate: animateIn,
      xlabel: function (r) { return hhmm(r.at); }, xEvery: Math.max(1, Math.ceil(runs.length / 6)),
      tip: function (r) {
        return '<strong>Leerstap ' + hhmm(r.at) + '</strong><br>' +
          '<span class="tk" style="background:' + cssVar('--s1') + '"></span>' + fmtN(r.searches) + ' zoekopdrachten<br>' +
          '<span class="tk" style="background:' + cssVar('--s2') + '"></span>' + fmtN(r.interactions) + ' interacties<br>' +
          '<span class="tk" style="background:' + cssVar('--s3') + '"></span>' + fmtN(r.suggests) + ' suggestie-dropdowns<br>' +
          fmtN(r.pairs) + ' koppelingen bijgewerkt' + (r.rewrites ? ' · ' + r.rewrites + ' herschrijvingen' : '');
      }
    });
    state.runsTable = runs;
  }

  /* =====================================================================
     ACTIVITEIT
     ===================================================================== */
  function renderHourly(d, animateIn) {
    var h = d.hourly || [];
    // begin bij het eerste uur met data, zodat de grafiek niet voor de helft leeg is
    var firstIdx = h.findIndex(function (x) { return x.searches > 0 || x.suggest > 0; });
    if (firstIdx > 0) h = h.slice(Math.max(0, Math.min(firstIdx, h.length - 12)));
    state.hourlyTable = h;
    var hl = function (x) { return new Date(x.h).toLocaleTimeString('nl-NL', { hour: '2-digit' }) + 'u'; };
    columns($('#hourly-chart'), h, [{ key: 'searches', color: '--s1' }], {
      height: 200, animate: animateIn, xlabel: hl, xEvery: Math.max(1, Math.ceil(h.length / 8)),
      tip: function (x) {
        return '<strong>' + new Date(x.h).toLocaleString('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + '</strong><br>' +
          fmtN(x.searches) + ' zoekopdrachten · ' + fmtN(x.with_click) + ' met klik<br>' + fmtN(x.zero) + ' zonder resultaat<br>' +
          fmtN(x.suggest) + ' suggestie-dropdowns · ' + fmtN(x.suggest_used) + ' gebruikt';
      }
    });
    var ctr = h.map(function (x) { return x.searches >= 3 ? x.with_click / x.searches : null; });
    lines($('#ctr-chart'), h.map(hl), [{ color: '--s1', values: ctr }], {
      height: 200, animate: animateIn, endLabel: true, yfmt: function (v) { return fmtPct(v); },
      max: Math.max(0.2, niceMax(Math.max.apply(null, ctr.filter(function (v) { return v != null; }).concat([0.1])))),
      xEvery: Math.max(1, Math.ceil(h.length / 8)),
      tip: function (i) {
        var x = h[i];
        return '<strong>' + hl(x) + '</strong><br>' + (ctr[i] == null ? 'minder dan 3 zoekopdrachten' : fmtPct(ctr[i], 1) + ' met klik') + '<br>' + fmtN(x.searches) + ' zoekopdrachten';
      }
    });
  }

  /* =====================================================================
     EXPERIMENT
     ===================================================================== */
  function wilson(k, n) {
    if (!n) return [0, 0];
    var z = 1.96, p = k / n, den = 1 + z * z / n;
    var c = (p + z * z / (2 * n)) / den, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }
  function normCdf(x) { // Abramowitz-Stegun
    var t = 1 / (1 + 0.2316419 * Math.abs(x));
    var d = 0.3989423 * Math.exp(-x * x / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  var ARM = {
    variant: { name: 'Variant', sub: 'slimme dropdown', color: '--s1' },
    control: { name: 'Controle', sub: 'Nedgame-dropdown', color: '--s2' },
    none: { name: 'Buiten experiment', sub: 'of niet gemarkeerd', color: '--s3' }
  };
  function renderArms(d) {
    var box = $('#arms');
    clear(box);
    var arms = (d.arms || []).filter(function (a) { return ARM[a.arm]; })
      .sort(function (a, b) { return ['variant', 'control', 'none'].indexOf(a.arm) - ['variant', 'control', 'none'].indexOf(b.arm); });
    if (!arms.length) { box.appendChild(emptyMsg('Nog geen zoekopdrachten.', '')); return; }
    var stats = arms.map(function (a) {
      var ci = wilson(a.with_click, a.searches);
      return { a: a, p: ratio(a.with_click, a.searches), ci: ci };
    });
    var hi = niceMax(Math.max.apply(null, stats.map(function (x) { return x.ci[1]; })) * 1.1);
    var list = el('div', { class: 'arms' });
    stats.forEach(function (st) {
      var meta = ARM[st.a.arm];
      var row = el('div', { class: 'arm' });
      var nm = el('div', { class: 'arm-name' });
      var sw = el('span', { class: 'sw' }); sw.style.background = cssVar(meta.color);
      var txt = el('span', null, meta.name);
      txt.appendChild(el('small', null, fmtN(st.a.searches) + ' zoekopdrachten'));
      nm.appendChild(sw); nm.appendChild(txt);
      var ci = el('div', { class: 'ci' });
      [0.2, 0.4, 0.6, 0.8].forEach(function (g) { var gl = el('span', { class: 'grid-l' }); gl.style.left = (g * 100) + '%'; ci.appendChild(gl); });
      var rng = el('span', { class: 'rng' });
      rng.style.left = (st.ci[0] / hi * 100) + '%'; rng.style.width = ((st.ci[1] - st.ci[0]) / hi * 100) + '%'; rng.style.background = cssVar(meta.color);
      var pt = el('span', { class: 'pt' }); pt.style.background = cssVar(meta.color); pt.style.left = '0%';
      var lbl = el('span', { class: 'lbl' }, fmtPct(st.p, 1));
      lbl.style.left = Math.min(80, st.ci[1] / hi * 100) + '%';
      ci.appendChild(rng); ci.appendChild(pt); ci.appendChild(lbl);
      requestAnimationFrame(function () { pt.style.left = ((st.p || 0) / hi * 100) + '%'; });
      ci.addEventListener('mousemove', function (e) {
        showTip(e, '<strong>' + meta.name + '</strong><br>' + fmtPct(st.p, 1) + ' met klik (' + fmtN(st.a.with_click) + '/' + fmtN(st.a.searches) + ')<br>95%-interval ' + fmtPct(st.ci[0], 1) + ' – ' + fmtPct(st.ci[1], 1));
      });
      ci.addEventListener('mouseleave', hideTip);
      row.appendChild(nm); row.appendChild(ci);
      list.appendChild(row);
    });
    var axis = el('div', { class: 'ci-axis' });
    axis.appendChild(el('span'));
    var ticks = el('div', { class: 'ticks' });
    [0, 0.2, 0.4, 0.6, 0.8, 1].forEach(function (g) { var t = el('span', null, fmtPct(g * hi)); t.style.left = (g * 100) + '%'; ticks.appendChild(t); });
    axis.appendChild(ticks);
    list.appendChild(axis);
    box.appendChild(list);

    var v = stats.filter(function (x) { return x.a.arm === 'variant'; })[0];
    var c = stats.filter(function (x) { return x.a.arm === 'control'; })[0];
    var verdict = el('div', { class: 'verdict' });
    if (v && c && v.a.searches >= 30 && c.a.searches >= 30) {
      var p1 = v.p, p2 = c.p, n1 = v.a.searches, n2 = c.a.searches;
      var pp = (v.a.with_click + c.a.with_click) / (n1 + n2);
      var se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
      var z = se > 0 ? (p1 - p2) / se : 0;
      var pval = 2 * (1 - normCdf(Math.abs(z)));
      var diff = (p1 - p2) * 100;
      verdict.appendChild(el('strong', null, 'Variant ' + (diff >= 0 ? '+' : '−') + fmtDec(Math.abs(diff), 1) + ' procentpunt'));
      verdict.appendChild(document.createTextNode(' tegenover controle (p = ' + fmtDec(pval, 3) + '). ' +
        (pval < 0.05 ? 'Dit verschil is statistisch significant, maar kijk ook naar looptijd en conversie voordat je concludeert.' :
          'Nog geen significant verschil. Laat de test doorlopen tot een vooraf bepaalde steekproef.')));
    } else if (!c) {
      verdict.appendChild(el('strong', null, 'Controle nog niet gemarkeerd.'));
      verdict.appendChild(document.createTextNode(' Zet het controle-snippet in VWO zodat zoekgedrag van de controlegroep apart zichtbaar wordt. Tot dan valt die groep onder ‘buiten experiment’.'));
    } else {
      verdict.appendChild(el('strong', null, 'Nog te weinig data.'));
      verdict.appendChild(document.createTextNode(' Variant ' + fmtN(v ? v.a.searches : 0) + ', controle ' + fmtN(c.a.searches) + ' zoekopdrachten. Vergelijken vanaf 30 per groep; conclusies pas bij de vooraf bepaalde steekproef.'));
    }
    box.appendChild(verdict);

    var tbl = el('table', { class: 'arm-table' });
    var thead = el('tr');
    ['Groep', 'Zoekopdr.', 'Met klik', 'MRR', '0 result.', 'Winkelmand', 'Sugg. gebruikt'].forEach(function (h) { thead.appendChild(el('th', null, h)); });
    tbl.appendChild(thead);
    arms.forEach(function (a) {
      var tr = el('tr');
      [ARM[a.arm].name, fmtN(a.searches), fmtPct(ratio(a.with_click, a.searches), 1), fmtDec(a.mrr, 3), fmtPct(ratio(a.zero, a.searches), 1),
        fmtPct(ratio(a.with_cart, a.searches), 1), a.suggest_shown ? fmtPct(ratio(a.suggest_used, a.suggest_shown), 0) : '–'].forEach(function (c2) { tr.appendChild(el('td', null, c2)); });
      tbl.appendChild(tr);
    });
    var tw = el('div', { class: 'table-scroll' }); tw.appendChild(tbl); box.appendChild(tw);
  }

  /* =====================================================================
     EXPLORATIE
     ===================================================================== */
  function renderExplore(d) {
    var box = $('#explore');
    clear(box);
    var ex = d.explore || {};
    var cmp = el('div', { class: 'ex-compare' });
    var a = el('div'); a.appendChild(el('div', { class: 'tile-label' }, 'Exploratieproduct gekozen'));
    var av = el('div', { class: 'tile-value' }, '–'); a.appendChild(av);
    a.appendChild(el('div', { class: 'tile-note' }, fmtN(ex.clicked) + ' van ' + fmtN(ex.shown) + ' keer getoond'));
    var b = el('div'); b.appendChild(el('div', { class: 'tile-label' }, 'Normaal product gekozen'));
    var bv = el('div', { class: 'tile-value' }, '–'); b.appendChild(bv);
    b.appendChild(el('div', { class: 'tile-note' }, fmtN(ex.normal_clicked) + ' van ' + fmtN(ex.normal_shown) + ' dropdowns'));
    cmp.appendChild(a); cmp.appendChild(b);
    box.appendChild(cmp);
    tween(av, ratio(ex.clicked, ex.shown), function (x) { return fmtPct(x, 1); });
    tween(bv, ratio(ex.normal_clicked, ex.normal_shown), function (x) { return fmtPct(x, 1); });
    var rec = ex.recent || [];
    if (!rec.length) {
      box.appendChild(emptyMsg('Nog geen exploratie getoond.', 'Dit draait alleen in de slimme dropdown van de nieuwe VWO-variant, bij ' + fmtN(+(d.status || {}).explore_rate || 0) + '% van de dropdowns.'));
      return;
    }
    box.appendChild(el('h3', { class: 'chart-title', style: 'margin-top:4px' }, 'Laatst geteste producten'));
    rec.forEach(function (r) {
      var row = el('div', { class: 'qrow' });
      row.appendChild(el('span', { class: 'q', title: r.title || '' }, (r.title || 'product') + ' · bij ‘' + r.prefix + '’'));
      row.appendChild(el('span', { class: 'n' }, hhmm(r.at)));
      row.appendChild(el('span', { class: r.clicked ? 'flag good' : 'muted', style: 'justify-self:end' }, r.clicked ? 'gekozen' : 'niet gekozen'));
      box.appendChild(row);
    });
    box.appendChild(el('p', { class: 'muted', style: 'margin-top:10px;font-size:12.5px' },
      'Een exploratieproduct staat altijd op de laatste plek, dus een lager keuzepercentage is normaal. Het gaat erom dat goede producten ontdekt worden.'));
  }

  /* =====================================================================
     ZOEKTERMEN
     ===================================================================== */
  function renderQueries(d) {
    var tq = $('#top-queries'), zq = $('#zero-queries');
    clear(tq); clear(zq);
    var top = d.top_queries || [];
    if (!top.length) tq.appendChild(emptyMsg('Nog geen zoekopdrachten.', ''));
    top.forEach(function (q) {
      var row = el('div', { class: 'qrow' });
      row.appendChild(el('span', { class: 'q', title: q.q }, q.q));
      row.appendChild(el('span', { class: 'n' }, fmtN(q.n) + '×'));
      var hb = el('div', { class: 'hbar' });
      var tr = el('div', { class: 'track-h' }); var fl = el('div', { class: 'fill' }); tr.appendChild(fl);
      hb.appendChild(tr); hb.appendChild(el('span', null, fmtPct(q.ctr)));
      row.appendChild(hb);
      requestAnimationFrame(function () { fl.style.width = ((q.ctr || 0) * 100) + '%'; });
      var tipHtml = '<strong>' + esc(q.q) + '</strong><br>' + fmtN(q.n) + ' keer gezocht · ' + fmtPct(q.ctr) + ' met klik<br>' + (q.results == null ? '' : fmtN(q.results) + ' resultaten');
      row.addEventListener('mousemove', function (e) { showTip(e, tipHtml); });
      row.addEventListener('mouseleave', hideTip);
      tq.appendChild(row);
    });
    var zero = d.zero_queries || [];
    if (!zero.length) zq.appendChild(emptyMsg('Geen zoekopdrachten zonder resultaat.', 'Mooi.'));
    var zmax = Math.max.apply(null, zero.map(function (z) { return z.n; }).concat([1]));
    zero.forEach(function (q) {
      var row = el('div', { class: 'qrow' });
      row.appendChild(el('span', { class: 'q', title: q.q }, q.q));
      row.appendChild(el('span', { class: 'n' }, fmtN(q.n) + '×'));
      var hb = el('div', { class: 'hbar' });
      var tr = el('div', { class: 'track-h' }); var fl = el('div', { class: 'fill alt' }); tr.appendChild(fl);
      hb.appendChild(tr); hb.appendChild(el('span'));
      row.appendChild(hb);
      requestAnimationFrame(function () { fl.style.width = (q.n / zmax * 100) + '%'; });
      zq.appendChild(row);
    });
  }

  /* =====================================================================
     TABELWEERGAVE
     ===================================================================== */
  function openTable(kind) {
    var d = state.dash;
    if (!d) return;
    var title = '', head = [], rows = [];
    if (kind === 'pb') {
      title = 'Positie-bias';
      head = ['Plek', 'Getoond', 'Kliks', 'CTR', 'Model'];
      rows = (d.position_bias || []).map(function (p) { return [p.pos, fmtN(p.impr), fmtN(p.clicks), fmtPct(ratio(p.clicks, p.impr), 1), fmtPct(p.prob, 1)]; });
    } else if (kind === 'runs') {
      title = 'Leerstappen';
      head = ['Tijd', 'Zoekopdr.', 'Interacties', 'Dropdowns', 'Koppelingen', 'Herschr.'];
      rows = (state.runsTable || []).slice().reverse().map(function (r) { return [hhmm(r.at), fmtN(r.searches), fmtN(r.interactions), fmtN(r.suggests), fmtN(r.pairs), fmtN(r.rewrites)]; });
    } else if (kind === 'hourly') {
      title = 'Activiteit per uur';
      head = ['Uur', 'Zoekopdr.', 'Met klik', '0 result.', 'Dropdowns', 'Gebruikt'];
      rows = (state.hourlyTable || []).slice().reverse().map(function (x) {
        return [new Date(x.h).toLocaleString('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' }), fmtN(x.searches), fmtN(x.with_click), fmtN(x.zero), fmtN(x.suggest), fmtN(x.suggest_used)];
      });
    }
    $('#table-title').textContent = title;
    var body = clear($('#table-body'));
    var wrap = el('div', { class: 'scroll' });
    var t = el('table');
    var tr = el('tr'); head.forEach(function (h) { tr.appendChild(el('th', null, h)); }); t.appendChild(tr);
    rows.forEach(function (r) { var row = el('tr'); r.forEach(function (c) { row.appendChild(el('td', null, String(c))); }); t.appendChild(row); });
    wrap.appendChild(t); body.appendChild(wrap);
    $('#table-dialog').showModal();
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-table]');
    if (b) openTable(b.getAttribute('data-table'));
  });

  /* =====================================================================
     ALLES
     ===================================================================== */
  function renderGrowth(d, animateIn) {
    var runs = d.learn_runs || [];
    var box = $('#growth-chart');
    if (!box) return;
    if (runs.length < 2) { clear(box); box.appendChild(emptyMsg('Groei verschijnt na twee leerstappen.', '')); return; }
    var acc = 0, accR = 0, labels = [], pairs = [], rw = [];
    runs.forEach(function (r) { acc += (r.r && r.r.pairs) || 0; accR += (r.r && r.r.rewrites) || 0; labels.push(hhmm(r.at)); pairs.push(acc); rw.push(accR); });
    legendKeys($('#growth-legend'), [{ label: 'Koppelingen bijgewerkt', color: '--s1', shape: 'line' }, { label: 'Herschrijvingen geleerd', color: '--s2', shape: 'line' }]);
    lines(box, labels, [{ color: '--s1', values: pairs }, { color: '--s2', values: rw }], {
      height: 150, animate: animateIn, endLabel: true, yfmt: compact, xEvery: Math.max(1, Math.ceil(labels.length / 6)),
      tip: function (i) { return '<strong>Na leerstap ' + labels[i] + '</strong><br>' + fmtN(pairs[i]) + ' koppelingen bijgewerkt<br>' + fmtN(rw[i]) + ' herschrijvingen'; }
    });
  }

  function renderAll(d, animateIn) {
    renderKpis(d);
    updateLoop(d);
    renderGrowth(d, animateIn);
    renderModules(d);
    renderPairs(d);
    renderRewrites(d);
    renderPositionBias(d, animateIn);
    renderRuns(d, animateIn);
    renderHourly(d, animateIn);
    renderArms(d);
    renderExplore(d);
    renderQueries(d);
    var st = d.status || {};
    $('#foot-meta').textContent = 'Bijgewerkt ' + new Date(d.generated_at).toLocaleTimeString('nl-NL') + ' · database ' + fmtN(st.db_mb) + ' van 500 MB · ' + fmtN(st.products) + ' producten in de index';
  }

  var rz = null, lastW = window.innerWidth;
  window.addEventListener('resize', function () {
    clearTimeout(rz);
    rz = setTimeout(function () {
      if (Math.abs(window.innerWidth - lastW) < 20) return;
      lastW = window.innerWidth;
      buildLoop();
      if (state.dash) renderAll(state.dash, false);
    }, 200);
  });

  /* ---------------- start ---------------- */
  // Geen token meer nodig: de dashboard-functies in Supabase zijn openbaar leesbaar.
  token = 'public';
  start(null);

  // alleen voor lokale tests (fixture), nooit in productie gebruikt
  window.__ngsDash = { onDash: onDash, onFeed: onFeed, start: start, state: state };
})();
