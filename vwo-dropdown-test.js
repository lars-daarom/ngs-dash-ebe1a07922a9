(function () {
  'use strict';

  /* ==========================================================================
     Nedgame — VWO variant: slimme zoeksuggesties v2 (Supabase nedgame-search)

     UX op basis van Coolblue, bol, MediaMarkt, Amazon en IKEA + Baymard:
     - Pagina gedimd achter de dropdown, wisknop in het zoekveld
     - Desktop: breed paneel met twee kolommen (zoeksuggesties | producten),
       mobiel: één kolom over de volle hoogte, grote tapdoelen
     - Icoon per type: loep (zoekterm), klok (recent), trend (populair),
       pijl (scope), miniatuur (product)
     - Voorspelde deel vet; "aanvullen"-knop zet een suggestie in het veld
       zonder te zoeken (verfijnen)
     - Producten: cover, titel (2 regels), platform, nieuw/tweedehands,
       voorraadstatus, prijs met oude prijs
     - Leeg veld: recent gezocht (los te verwijderen), populair, recent bekeken
     - Volledig met toetsenbord te bedienen, screenreader-meldingen
     Leren: elke getoonde dropdown + keuze → search_log_suggest via window.ngs
     (GTM-tag). Exploratie: het model test af en toe een product op de laatste plek.
     ========================================================================== */

  var GUARD_ID = 'vwo-ngs-ac-v1';
  var API = 'https://nizupsnwexcisgtnhtnu.supabase.co';
  var KEY = 'sb_publishable_D8zw_CTZO3B4qObfMXjOUg_uE75SRZm'; // publieke sleutel, mag in de browser
  var DESKTOP = { queries: 6, products: 4, scopes: 3 };
  var MOBILE = { queries: 4, products: 3, scopes: 2 };
  var PANEL_MAX_W = 780;
  var TWO_COL_MIN_W = 640;
  var DEBOUNCE_MS = 90;
  var SETTLE_MS = 1000;
  var HIDE_KEY = 'ngs_hidden_recent';

  var PLATFORM_SLUGS = {
    'playstation-5': 'PlayStation 5', 'playstation-4': 'PlayStation 4', 'playstation-3': 'PlayStation 3',
    'playstation-2': 'PlayStation 2', 'playstation-1': 'PlayStation 1', 'sony-psp': 'Sony PSP', 'ps-vita': 'PS Vita',
    'nintendo-switch-2': 'Nintendo Switch 2', 'nintendo-switch': 'Nintendo Switch', 'nintendo-wii-u': 'Nintendo Wii U',
    'nintendo-wii': 'Nintendo Wii', 'nintendo-3ds': 'Nintendo 3DS', 'nintendo-ds': 'Nintendo DS', 'gamecube': 'GameCube',
    'nintendo-64': 'Nintendo 64', 'super-nintendo': 'Super Nintendo', 'nintendo--nes-': 'Nintendo (NES)',
    'gameboy-advance': 'GameBoy Advance', 'gameboy-color': 'Gameboy Color', 'gameboy': 'Gameboy',
    'xbox-series-x': 'Xbox Series X', 'xbox-one': 'Xbox One', 'xbox-360': 'Xbox 360', 'xbox': 'Xbox',
    'pc-gaming': 'PC Gaming', 'sega-megadrive': 'Sega MegaDrive', 'dreamcast': 'Dreamcast', 'evercade': 'Evercade'
  };

  try { sessionStorage.setItem('ngs_arm', 'variant'); } catch (e) {}

  /* ---------------- gedeelde tracker (GTM-tag) met fallback ---------------- */
  var fallbackSid = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  function ngs() { return window.ngs && window.ngs.__v ? window.ngs : null; }
  function visitorId() { var n = ngs(); return n ? n.vid() : fallbackSid; }
  function logSuggest(o) { var n = ngs(); if (!n) return; o.source = 'suggest'; n.logSuggest(o); }

  function rpc(fn, body, opts) {
    opts = opts || {};
    return fetch(API + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': KEY },
      body: JSON.stringify(body),
      signal: opts.signal
    }).then(function (r) { if (!r.ok) throw new Error(fn + ' ' + r.status); return r.json(); });
  }

  function pagePlatform() { return PLATFORM_SLUGS[location.pathname.split('/')[1] || ''] || null; }

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function searchUrl(q, slug) {
    var term = norm(q).replace(/[^a-z0-9]+/g, '+').replace(/^\++|\++$/g, '');
    return '/zoek/' + (slug ? 'systeem:' + slug + '/' : '') + 'zoek:' + term + '/';
  }
  function price(v) {
    if (v == null) return '';
    var n = Number(v);
    return n % 1 === 0 ? n.toFixed(0) + ',-' : n.toFixed(2).replace('.', ',');
  }
  function isMobile() { return window.matchMedia('(max-width: 767px)').matches; }
  function reduceMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function hiddenRecent() { try { return JSON.parse(localStorage.getItem(HIDE_KEY) || '[]'); } catch (e) { return []; } }
  function hideRecent(q) {
    try {
      var list = hiddenRecent(); if (list.indexOf(norm(q)) === -1) list.push(norm(q));
      localStorage.setItem(HIDE_KEY, JSON.stringify(list.slice(-50)));
    } catch (e) {}
  }

  // Baymard: het voorspelde (niet-getypte) deel vet, het getypte deel normaal
  function highlight(suggestion, typed) {
    var tokens = norm(typed).split(/\s+/).filter(Boolean);
    return suggestion.split(/(\s+)/).map(function (w) {
      if (/^\s+$/.test(w)) return w;
      var nw = norm(w);
      for (var i = 0; i < tokens.length; i++) {
        if (tokens[i] && nw.indexOf(tokens[i]) === 0) return esc(w.slice(0, tokens[i].length)) + '<b>' + esc(w.slice(tokens[i].length)) + '</b>';
      }
      return '<b>' + esc(w) + '</b>';
    }).join('');
  }

  // Lichte cover: /{platform}/{slug}/{id}/ → /{platform}/{slug}.{id}.cover.small.{ext}
  function thumb(link, ext) {
    var m = String(link || '').match(/^\/([^/]+)\/([^/]+)\/(\d{6,})\/?(?:[?#].*)?$/);
    return m ? '/' + m[1] + '/' + m[2] + '.' + m[3] + '.cover.small.' + ext : null;
  }
  function productImg(p) {
    var full = p.image || '', webp = thumb(p.link, 'webp'), jpg = thumb(p.link, 'jpg');
    if (!webp) return full ? '<img src="' + esc(full) + '" alt="" width="48" height="60" loading="lazy" decoding="async">' : '';
    return '<picture><source type="image/webp" srcset="' + esc(webp) + '">' +
      '<img src="' + esc(jpg) + '" data-full="' + esc(full) + '" alt="" width="48" height="60" loading="lazy" decoding="async"></picture>';
  }

  /* ---------------- iconen (functioneel, 18px, currentColor) ---------------- */
  var ICON = {
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.8"/></svg>',
    trend: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16l5-5 4 4 7-7"/><path d="M15 8h5v5"/></svg>',
    scope: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v7a3 3 0 0 0 3 3h9"/><path d="m14 11 4 4-4 4"/></svg>',
    fill: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 17 7 7"/><path d="M7 15V7h8"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13"/><path d="m13 6 6 6-6 6"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
  };

  /* ---------------- styling (huisstijl Nedgame) ---------------- */
  function injectCss() {
    if (document.getElementById(GUARD_ID + '-css')) return;
    var B = 'rgb(0, 102, 155)';
    var css = [
      '#QuickSearchResult{display:none !important;}',
      /* dim-laag achter de dropdown */
      '#ngs-dim{position:fixed;inset:0;background:rgba(17,17,17,.42);z-index:10;opacity:0;pointer-events:none;transition:opacity .16s ease;}',
      '#ngs-dim.ngs-on{opacity:1;pointer-events:auto;}',
      /* wisknop in het zoekveld */
      '#ngs-clear{position:absolute;top:50%;transform:translateY(-50%);width:32px;height:32px;display:none;align-items:center;justify-content:center;border:0;background:transparent;color:#666;cursor:pointer;border-radius:50%;padding:0;z-index:2;}',
      '#ngs-clear:hover{background:#eef3f7;color:#333;}',
      '#ngs-clear svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;}',
      '#ngs-clear.ngs-show{display:flex;}',
      /* paneel */
      '#ngs-ac{position:absolute;left:0;top:calc(100% + 6px);z-index:30;background:#fff;border:1px solid #d9dcdf;border-radius:6px;',
      '  font-family:Roboto,sans-serif,Arial,Helvetica;font-size:14.4px;color:#333;text-align:left;overflow:hidden;display:none;',
      '  box-shadow:0 8px 24px rgba(0,0,0,.14);}',
      '#ngs-ac.ngs-open{display:flex;flex-direction:column;}',
      '#ngs-ac.ngs-anim{animation:ngs-in .14s ease-out both;}',
      '@keyframes ngs-in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:none;}}',
      '#ngs-ac .ngs-load{position:absolute;left:0;top:0;height:2px;width:30%;background:' + B + ';opacity:0;}',
      '#ngs-ac.ngs-loading .ngs-load{opacity:1;animation:ngs-bar 1s ease-in-out infinite;}',
      '@keyframes ngs-bar{0%{left:-30%;}100%{left:100%;}}',
      '#ngs-ac .ngs-body{display:grid;grid-template-columns:1fr;overflow-y:auto;min-height:0;}',
      '#ngs-ac.ngs-two .ngs-body{grid-template-columns:minmax(0,310px) minmax(0,1fr);}',
      '#ngs-ac .ngs-col{padding:8px 0;min-width:0;}',
      '#ngs-ac.ngs-two .ngs-col + .ngs-col{border-left:1px solid #eceef0;}',
      '#ngs-ac:not(.ngs-two) .ngs-col + .ngs-col{border-top:1px solid #eceef0;}',
      '#ngs-ac .ngs-head{display:flex;justify-content:space-between;align-items:center;padding:6px 16px 4px;color:#666;font-size:13px;font-weight:500;}',
      '#ngs-ac .ngs-head button{background:none;border:0;padding:4px 0;color:' + B + ';font-size:13px;cursor:pointer;font-family:inherit;}',
      '#ngs-ac .ngs-head button:hover{text-decoration:underline;}',
      /* rijen */
      '#ngs-ac .ngs-opt{position:relative;display:flex;align-items:center;gap:12px;min-height:40px;padding:0 8px 0 16px;color:#333;text-decoration:none;cursor:pointer;line-height:1.3;}',
      '#ngs-ac .ngs-opt.ngs-active,#ngs-ac .ngs-opt:hover{background:#eef3f7;}',
      '#ngs-ac .ngs-opt.ngs-active{box-shadow:inset 2px 0 0 ' + B + ';}',
      '#ngs-ac .ngs-ico{flex:0 0 18px;width:18px;height:18px;color:#8a8f94;display:flex;}',
      '#ngs-ac .ngs-ico svg,#ngs-ac .ngs-fill svg,#ngs-ac .ngs-del svg,#ngs-ac .ngs-go svg,#ngs-ac .ngs-stock svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
      '#ngs-ac .ngs-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:9px 0;}',
      '#ngs-ac .ngs-txt b{font-weight:700;}',
      '#ngs-ac .ngs-fill,#ngs-ac .ngs-del{flex:0 0 32px;width:32px;height:32px;padding:7px;border:0;background:transparent;color:#8a8f94;border-radius:50%;cursor:pointer;display:flex;opacity:0;}',
      '#ngs-ac .ngs-opt:hover .ngs-fill,#ngs-ac .ngs-opt.ngs-active .ngs-fill,#ngs-ac .ngs-opt:hover .ngs-del,#ngs-ac .ngs-opt.ngs-active .ngs-del{opacity:1;}',
      '#ngs-ac .ngs-fill:hover,#ngs-ac .ngs-del:hover{background:#dde6ee;color:#333;}',
      '#ngs-ac .ngs-scope{min-height:34px;padding-left:46px;color:#525252;font-size:13.6px;}',
      '#ngs-ac .ngs-scope .ngs-ico{flex-basis:16px;width:16px;height:16px;}',
      '#ngs-ac .ngs-scope strong{color:' + B + ';font-weight:500;}',
      '#ngs-ac .ngs-scope .ngs-n{color:#8a8f94;margin-left:4px;}',
      '#ngs-ac .ngs-note{color:#666;font-size:13px;padding:6px 16px 2px;}',
      /* producten */
      '#ngs-ac .ngs-product{align-items:flex-start;gap:14px;padding:8px 16px;min-height:76px;}',
      '#ngs-ac .ngs-pimg{flex:0 0 48px;width:48px;height:60px;display:flex;align-items:center;justify-content:center;}',
      '#ngs-ac .ngs-pimg picture{display:block;width:48px;height:60px;}',
      '#ngs-ac .ngs-pimg img{width:48px !important;height:60px !important;max-width:none !important;object-fit:contain;margin:0;display:block;}',
      '#ngs-ac .ngs-pt{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '#ngs-ac .ngs-title{font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.3;}',
      '#ngs-ac .ngs-meta{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;color:#666;font-size:12.8px;}',
      '#ngs-ac .ngs-tag{display:inline-block;padding:0 6px;border:1px solid #d9dcdf;border-radius:3px;font-size:12px;line-height:18px;color:#525252;}',
      '#ngs-ac .ngs-stock{display:inline-flex;align-items:center;gap:3px;color:#007a52;}',
      '#ngs-ac .ngs-stock svg{width:14px;height:14px;}',
      '#ngs-ac .ngs-price{flex:0 0 auto;text-align:right;font-weight:700;color:#333;white-space:nowrap;padding-top:1px;font-size:15.2px;}',
      '#ngs-ac .ngs-price s{display:block;font-weight:400;color:#8a8f94;font-size:12.8px;}',
      /* voettekst */
      '#ngs-ac .ngs-foot{border-top:1px solid #eceef0;}',
      '#ngs-ac .ngs-all{min-height:46px;color:' + B + ';font-weight:500;justify-content:space-between;padding-right:16px;}',
      '#ngs-ac .ngs-go{width:18px;height:18px;flex:0 0 18px;display:flex;}',
      '#ngs-ac .ngs-empty{padding:14px 16px;color:#525252;}',
      '.ngs-sr{position:absolute !important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;margin:-1px;padding:0;border:0;}',
      '@media (max-width:767px){',
      '  #ngs-ac{position:fixed;left:0 !important;right:0;width:auto !important;border-radius:0;border-left:0;border-right:0;border-bottom:0;box-shadow:none;}',
      '  #ngs-ac .ngs-opt{min-height:48px;}',
      '  #ngs-ac .ngs-fill,#ngs-ac .ngs-del{opacity:1;flex-basis:40px;width:40px;height:40px;padding:10px;}',
      '  #ngs-ac .ngs-scope{min-height:44px;}',
      '}',
      '@media (prefers-reduced-motion:reduce){#ngs-ac.ngs-anim{animation:none;}#ngs-dim{transition:none;}#ngs-ac.ngs-loading .ngs-load{animation:none;width:100%;opacity:.4;}}'
    ].join('\n');
    var style = document.createElement('style');
    style.id = GUARD_ID + '-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------------- autocomplete ---------------- */
  function initAutocomplete() {
    if (document.getElementById(GUARD_ID)) return true;
    var oldInput = document.getElementById('quicksearch');
    var form = document.getElementById('zoekform');
    var wrap = document.getElementById('zoek');
    if (!oldInput || !form || !wrap) return false;

    var guard = document.createElement('div');
    guard.id = GUARD_ID;
    guard.style.display = 'none';
    document.body.appendChild(guard);
    injectCss();

    // Nieuwe input zonder de oude quicksearch-listeners (naam/id gelijk → formulier werkt als voorheen)
    var hadFocus = document.activeElement === oldInput;
    var input = oldInput.cloneNode(true);
    input.value = oldInput.value;
    oldInput.parentNode.replaceChild(input, oldInput);
    if (hadFocus) { input.focus(); try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {} }
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', 'ngs-ac');
    input.setAttribute('enterkeyhint', 'search');

    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

    // dim-laag: binnen de sticky header (onder de zoekbalk, boven de rest van de pagina)
    var dim = document.createElement('div');
    dim.id = 'ngs-dim';
    var header = document.getElementById('header');
    (header || document.body).insertBefore(dim, (header || document.body).firstChild);
    dim.addEventListener('mousedown', function (e) { e.preventDefault(); input.blur(); close(); });

    // wisknop
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.id = 'ngs-clear';
    clearBtn.setAttribute('aria-label', 'Zoekveld leegmaken');
    clearBtn.innerHTML = ICON.close;
    wrap.appendChild(clearBtn);
    function placeClear() {
      var ir = input.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
      clearBtn.style.left = Math.round(ir.right - wr.left - 38) + 'px';
      clearBtn.style.top = Math.round(ir.top - wr.top + ir.height / 2) + 'px';
      // corrigeer voor padding/rand van de wrapper: midden van de knop = midden van het veld
      var cr = clearBtn.getBoundingClientRect();
      if (cr.height) {
        var dy = (ir.top + ir.height / 2) - (cr.top + cr.height / 2);
        var dx = (ir.right - 38) - cr.left;
        clearBtn.style.top = Math.round(parseFloat(clearBtn.style.top) + dy) + 'px';
        clearBtn.style.left = Math.round(parseFloat(clearBtn.style.left) + dx) + 'px';
      }
      input.style.paddingRight = '40px';
    }
    function syncClear() { var was = clearBtn.classList.contains('ngs-show'); clearBtn.classList.toggle('ngs-show', !!input.value); if (!was && input.value) placeClear(); }
    clearBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    clearBtn.addEventListener('click', function () {
      input.value = ''; typed = ''; syncClear(); input.focus(); fetchSuggest('');
    });

    var box = document.createElement('div');
    box.id = 'ngs-ac';
    box.setAttribute('role', 'listbox');
    box.setAttribute('aria-label', 'Zoeksuggesties');
    wrap.appendChild(box);
    var live = document.createElement('div');
    live.className = 'ngs-sr';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(live);

    var cache = {}, controller = null, timer = null, settleTimer = null, loadTimer = null;
    var typed = '', items = [], active = -1, lastData = null, shown = null, loggedSig = '';

    function open() {
      var ir = input.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
      if (isMobile()) {
        var top = Math.round(ir.bottom + 6);
        box.style.top = top + 'px';
        box.style.maxHeight = 'calc(100vh - ' + top + 'px)';
        box.style.height = 'calc(100vh - ' + top + 'px)';
        box.classList.remove('ngs-two');
      } else {
        var avail = window.innerWidth - ir.left - 16;
        var w = Math.max(wr.width, Math.min(PANEL_MAX_W, avail));
        box.style.width = Math.round(w) + 'px';
        box.style.left = Math.round(ir.left - wr.left) + 'px';
        box.style.top = '';
        box.style.height = '';
        box.style.maxHeight = 'calc(100vh - ' + Math.round(ir.bottom + 24) + 'px)';
        box.classList.toggle('ngs-two', w >= TWO_COL_MIN_W && box.querySelectorAll('.ngs-col').length > 1);
      }
      if (!box.classList.contains('ngs-open')) {
        box.classList.add('ngs-open');
        if (!reduceMotion()) { box.classList.remove('ngs-anim'); void box.offsetWidth; box.classList.add('ngs-anim'); }
      }
      dim.classList.add('ngs-on');
      input.setAttribute('aria-expanded', 'true');
    }
    function close() {
      box.classList.remove('ngs-open', 'ngs-anim');
      dim.classList.remove('ngs-on');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
      clearTimeout(settleTimer);
    }

    function scheduleSettle() {
      clearTimeout(settleTimer);
      if (!shown || !shown.prefix) return;
      settleTimer = setTimeout(function () {
        if (!box.classList.contains('ngs-open') || !shown) return;
        var sig = norm(shown.prefix) + '|' + shown.products.join(',') + '|' + shown.queries.join(',');
        if (sig === loggedSig) return;
        loggedSig = sig;
        logSuggest({ prefix: shown.prefix, queries: shown.queries, products: shown.products, explore: shown.explore });
      }, SETTLE_MS);
    }

    function setActive(i, fillInput) {
      items.forEach(function (it) { it.el.classList.remove('ngs-active'); it.el.setAttribute('aria-selected', 'false'); });
      active = i;
      if (i < 0 || !items[i]) { input.removeAttribute('aria-activedescendant'); if (fillInput) input.value = typed; return; }
      var it = items[i];
      it.el.classList.add('ngs-active');
      it.el.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', it.el.id);
      it.el.scrollIntoView({ block: 'nearest' });
      if (fillInput) input.value = it.type === 'query' ? it.q : typed;   // Baymard: suggestie in het veld tonen
    }

    function go(it) {
      if (!it) return;
      clearTimeout(settleTimer);
      if (shown && shown.prefix) {
        var o = { prefix: shown.prefix, queries: shown.queries, products: shown.products, explore: shown.explore };
        if (it.type === 'product') { o.chosenType = 'product'; o.chosen = it.productId; o.chosenPos = it.position; }
        else if (it.type === 'query') { o.chosenType = 'query'; o.chosen = it.q; o.chosenPos = it.qpos; }
        else { o.chosenType = it.type; o.chosen = it.q || typed; }
        logSuggest(o);
      }
      location.href = it.url || searchUrl(it.q || typed);
    }

    // suggestie in het veld zetten en verder verfijnen (zonder te zoeken)
    function refine(q) {
      input.value = q + ' ';
      typed = input.value.trim();
      syncClear();
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
      fetchSuggest(typed);
    }

    /* ---------- opbouw ---------- */
    function render(data) {
      lastData = data;
      items = []; active = -1; shown = null;
      var mobile = isMobile(), lim = mobile ? MOBILE : DESKTOP, n = 0;
      var left = [], right = [], foot = [];

      function opt(type, inner, extra, cls, tag) {
        var id = 'ngs-opt-' + (n++);
        items.push(Object.assign({ type: type, id: id }, extra));
        tag = tag || 'a';
        var attrs = ' id="' + id + '" role="option" aria-selected="false" class="ngs-opt ngs-' + type + (cls ? ' ' + cls : '') + '"';
        if (tag === 'a') attrs += ' href="' + esc(extra.url || '#') + '"';
        return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
      }
      function queryRow(q, html, icon, extra, withFill, withDel) {
        var inner = '<span class="ngs-ico">' + ICON[icon] + '</span><span class="ngs-txt">' + html + '</span>';
        if (withDel) inner += '<button type="button" class="ngs-del" data-del="' + esc(q) + '" tabindex="-1" aria-label="Verwijder ‘' + esc(q) + '’ uit recent gezocht">' + ICON.close + '</button>';
        else if (withFill) inner += '<button type="button" class="ngs-fill" data-fill="' + esc(q) + '" tabindex="-1" aria-label="Zet ‘' + esc(q) + '’ in het zoekveld">' + ICON.fill + '</button>';
        return opt('query', inner, extra, null, 'div');
      }
      function productRow(p, i, meta) {
        var cond = p.condition === 'used' ? 'Tweedehands' : null;
        var stock = p.availability === 'in_stock' ? '<span class="ngs-stock">' + ICON.check + 'Op voorraad</span>'
          : p.availability === 'preorder' ? '<span>Pre-order</span>' : '';
        var was = (p.regular_price && p.price && Number(p.regular_price) > Number(p.price)) ? '<s>' + price(p.regular_price) + '</s>' : '';
        var pid = p.id || p.base_id;
        var inner = '<span class="ngs-pimg">' + productImg(p) + '</span>' +
          '<span class="ngs-pt"><span class="ngs-title">' + esc(p.title) + '</span>' +
          '<span class="ngs-meta">' + (p.platform ? '<span class="ngs-tag">' + esc(p.platform) + '</span>' : '') +
          (cond ? '<span>' + cond + '</span>' : '') + (meta ? '' : stock) + '</span></span>' +
          '<span class="ngs-price">' + was + price(p.price) + '</span>';
        return opt('product', inner, { url: p.link, productId: pid, position: i + 1 });
      }

      if (!typed) {
        // Leeg veld: recent gezocht, populair, recent bekeken
        var hide = hiddenRecent();
        var recent = (data.recent || []).filter(function (q) { return hide.indexOf(norm(q)) === -1; }).slice(0, 5);
        if (recent.length) {
          left.push('<div class="ngs-head"><span>Recent gezocht</span><button type="button" data-ngs-clear="1">Alles wissen</button></div>');
          recent.forEach(function (q) { left.push(queryRow(q, esc(q), 'clock', { q: q, url: searchUrl(q) }, false, true)); });
        }
        var trending = (data.trending || []).slice(0, recent.length ? 4 : 6);
        if (trending.length) {
          left.push('<div class="ngs-head"><span>Populair bij Nedgame</span></div>');
          trending.forEach(function (q) { left.push(queryRow(q, esc(q), 'trend', { q: q, url: searchUrl(q) }, true, false)); });
        }
        var rp = (data.recent_products || []).slice(0, lim.products);
        if (rp.length) {
          right.push('<div class="ngs-head"><span>Recent bekeken</span></div>');
          rp.forEach(function (p, i) { right.push(productRow(p, i)); });
        }
        if (!left.length && !right.length) { box.innerHTML = ''; close(); return; }
        paint(left, right, foot);
        live.textContent = 'Recente en populaire zoekopdrachten beschikbaar';
        return;
      }

      // zoeksuggesties: kort en onderscheidend (geen volledige producttitels met edities)
      var seenQ = {};
      var queries = (data.queries || []).map(function (q) {
        return { q: String(q.q).replace(/\s+(Nintendo Switch 2 Edition|- .*)$/i, '').trim(), type: q.type };
      }).filter(function (q) {
        var k = norm(q.q);
        if (seenQ[k] || q.q.length > 48 || k === norm(typed)) return false;
        seenQ[k] = 1; return true;
      }).slice(0, lim.queries);
      var corrected = queries.filter(function (q) { return q.type === 'corrected'; });
      var normal = queries.filter(function (q) { return q.type !== 'corrected'; });
      var shownQueries = [typed], qpos = 1;

      // bovenste rij = wat er getypt is, met scopes eronder (Baymard)
      left.push(queryRow(typed, '<span>' + esc(typed) + '</span>', 'search', { q: typed, url: searchUrl(typed), qpos: 1 }, false, false));
      (data.scopes || []).slice(0, lim.scopes).forEach(function (s) {
        left.push(opt('scope', '<span class="ngs-ico">' + ICON.scope + '</span><span class="ngs-txt">in <strong>' + esc(s.platform) + '</strong><span class="ngs-n">' + s.count + '</span></span>',
          { q: typed, url: searchUrl(typed, s.slug) }));
      });
      normal.forEach(function (q) {
        qpos++; shownQueries.push(q.q);
        left.push(queryRow(q.q, highlight(q.q, typed), q.type === 'recent' ? 'clock' : 'search', { q: q.q, url: searchUrl(q.q), qpos: qpos }, true, false));
      });
      if (corrected.length && !normal.length) {
        left.push('<div class="ngs-note">Bedoelde je:</div>');
        corrected.forEach(function (q) {
          qpos++; shownQueries.push(q.q);
          left.push(queryRow(q.q, '<b>' + esc(q.q) + '</b>', 'search', { q: q.q, url: searchUrl(q.q), qpos: qpos }, true, false));
        });
      }

      var products = (data.products || []).slice(0, lim.products);
      var shownProducts = [], shownExplore = [];
      if (products.length) {
        right.push('<div class="ngs-head"><span>Producten</span></div>');
        products.forEach(function (p, i) {
          var bid = String(p.base_id || p.id);
          shownProducts.push(bid);
          if (p.explore) shownExplore.push(bid);
          right.push(productRow(p, i));
        });
      } else if (typed.length >= 3) {
        right.push('<div class="ngs-empty">Geen directe productsuggesties voor ‘' + esc(typed) + '’. Bekijk alle zoekresultaten of probeer een andere schrijfwijze.</div>');
      }

      foot.push(opt('all', '<span class="ngs-txt">Toon alle resultaten voor ‘' + esc(typed) + '’</span><span class="ngs-go">' + ICON.arrow + '</span>', { q: typed, url: searchUrl(typed) }));

      paint(left, right, foot);
      shown = { prefix: typed, queries: shownQueries, products: shownProducts, explore: shownExplore };
      live.textContent = (shownQueries.length) + ' zoeksuggesties en ' + products.length + ' producten. Gebruik de pijltjestoetsen om te kiezen.';
      scheduleSettle();
    }

    function paint(left, right, foot) {
      var html = '<div class="ngs-load" aria-hidden="true"></div><div class="ngs-body">';
      if (left.length) html += '<div class="ngs-col ngs-left">' + left.join('') + '</div>';
      if (right.length) html += '<div class="ngs-col ngs-right">' + right.join('') + '</div>';
      html += '</div>';
      if (foot.length) html += '<div class="ngs-foot">' + foot.join('') + '</div>';
      box.innerHTML = html;
      bindItems();
      open();
    }

    function bindImages() {
      box.querySelectorAll('.ngs-product img').forEach(function (img) {
        img.addEventListener('error', function () {
          var pic = img.parentNode && img.parentNode.tagName === 'PICTURE' ? img.parentNode : null;
          if (pic) pic.querySelectorAll('source').forEach(function (s) { s.remove(); });
          var full = img.getAttribute('data-full');
          if (full && img.getAttribute('src') !== full) img.setAttribute('src', full);
          else img.style.visibility = 'hidden';
        });
      });
    }

    function bindItems() {
      items.forEach(function (it, i) {
        it.el = document.getElementById(it.id);
        it.el.addEventListener('mousedown', function (e) { e.preventDefault(); });   // focus in het zoekveld houden
        it.el.addEventListener('click', function (e) {
          var t = e.target;
          var fill = t.closest && t.closest('[data-fill]');
          var del = t.closest && t.closest('[data-del]');
          e.preventDefault();
          if (fill) { refine(fill.getAttribute('data-fill')); return; }
          if (del) {
            hideRecent(del.getAttribute('data-del'));
            render(lastData || {});
            return;
          }
          if ((e.ctrlKey || e.metaKey) && it.type === 'product') { window.open(it.url, '_blank'); return; }
          go(it);
        });
        it.el.addEventListener('mousemove', function () { if (active !== i) setActive(i, false); });
      });
      bindImages();
      var clearAll = box.querySelector('[data-ngs-clear]');
      if (clearAll) {
        clearAll.addEventListener('mousedown', function (e) { e.preventDefault(); });
        clearAll.addEventListener('click', function () {
          (lastData && lastData.recent || []).forEach(hideRecent);
          render(lastData || {});
        });
      }
    }

    function fetchSuggest(q) {
      var mobile = isMobile();
      var key = norm(q).trim() + (mobile ? '|m' : '|d');
      if (cache[key]) { render(cache[key]); return; }
      if (controller) controller.abort();
      controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      clearTimeout(loadTimer);
      loadTimer = setTimeout(function () { box.classList.add('ngs-loading'); }, 150);
      var lim = mobile ? MOBILE : DESKTOP;
      rpc('search_suggest', {
        p_prefix: q,
        p_visitor_id: visitorId(),
        p_context: { page_platform: pagePlatform(), explore: true },
        p_max_queries: 8,
        p_max_products: lim.products
      }, { signal: controller && controller.signal }).then(function (data) {
        cache[key] = data;
        clearTimeout(loadTimer); box.classList.remove('ngs-loading');
        if (norm(input.value).trim() === norm(q).trim() || (!q && !input.value.trim())) render(data);
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        clearTimeout(loadTimer); box.classList.remove('ngs-loading');
      });
    }

    /* ---------- events ---------- */
    input.addEventListener('input', function () {
      typed = input.value.trim();
      syncClear();
      clearTimeout(timer);
      timer = setTimeout(function () { fetchSuggest(typed); }, typed ? DEBOUNCE_MS : 0);
    });
    input.addEventListener('focus', function () {
      placeClear();
      typed = input.value.trim();
      fetchSuggest(typed);
    });
    input.addEventListener('keydown', function (e) {
      var isOpen = box.classList.contains('ngs-open');
      if (e.key === 'ArrowDown') {
        if (!isOpen) { fetchSuggest(input.value.trim()); return; }
        e.preventDefault();
        setActive(active + 1 >= items.length ? -1 : active + 1, true);
      } else if (e.key === 'ArrowUp') {
        if (!isOpen) return;
        e.preventDefault();
        setActive(active - 1 < -1 ? items.length - 1 : active - 1, true);
      } else if (e.key === 'ArrowRight' && isOpen && active >= 0 && items[active] && items[active].type === 'query' &&
                 input.selectionStart === input.value.length) {
        e.preventDefault();
        refine(items[active].q);                       // → vult de suggestie aan (zoals Google/MediaMarkt)
      } else if (e.key === 'Escape') {
        if (active >= 0) setActive(-1, true); else { close(); }
      } else if (e.key === 'Enter') {
        if (isOpen && active >= 0 && items[active]) { e.preventDefault(); go(items[active]); }
        else if (isOpen && shown && shown.prefix) {
          logSuggest({ prefix: shown.prefix, queries: shown.queries, products: shown.products, explore: shown.explore,
                       chosenType: 'all', chosen: input.value.trim() });
        }
      }
    });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
    window.addEventListener('resize', function () { placeClear(); if (box.classList.contains('ngs-open')) open(); });
    window.addEventListener('scroll', function () { if (isMobile() && box.classList.contains('ngs-open')) open(); }, { passive: true });

    placeClear();
    syncClear();
    if (hadFocus) { typed = input.value.trim(); fetchSuggest(typed); }
    return true;
  }

  var attempts = 0;
  var interval = setInterval(function () {
    attempts++;
    if (initAutocomplete() || attempts >= 50) clearInterval(interval);
  }, 100);
})();
