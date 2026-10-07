/* WhatToEat frontend — Phase 1: households, onboarding, live stock. */
(function () {
  'use strict';

  var LS_KEY = 'wte_session_v1';
  var EMOJIS = ['😀','😎','🥳','😇','🤠','👩','👨','👵','👴','👧','👦',
                '🍳','🥘','🍕','🥗','🍎','🥛','🧀','🍗','🥚','🍞','🧅','🥔','🌶️'];
  var LOC_META = {
    kitchen: { icon: '🍳', label: 'Kitchen' },
    fridge:  { icon: '🧊', label: 'Fridge' },
    freezer: { icon: '❄️', label: 'Freezer' },
  };

  var S = {
    code: null, member: null, household: null,
    stock: [], presence: [],
    socket: null,
    avatar: '😀', avatarKind: 'emoji',
    onboardCode: null,
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  function saveSession() {
    localStorage.setItem(LS_KEY, JSON.stringify({ code: S.code, memberId: S.member && S.member.id }));
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; }
  }
  function clearSession() { localStorage.removeItem(LS_KEY); }

  function avatarHTML(m, cls) {
    cls = cls || 'avatar-chip';
    if (m.avatar_kind === 'photo' && m.avatar) {
      return '<span class="' + cls + '" title="' + esc(m.name) + '"><img src="' + m.avatar + '" alt=""></span>';
    }
    return '<span class="' + cls + '" title="' + esc(m.name) + '">' + esc(m.avatar || '🍳') + '</span>';
  }

  function toast(text, avatar, avatarKind) {
    var box = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast';
    var av = avatarKind === 'photo' && avatar
      ? '<span class="t-avatar"><img src="' + avatar + '" alt=""></span>'
      : '<span class="t-avatar">' + esc(avatar || '🍽️') + '</span>';
    el.innerHTML = av + '<span>' + esc(text) + '</span>';
    box.appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 350); }, 3500);
    while (box.children.length > 3) box.firstChild.remove();
  }

  function show(view) {
    ['landing', 'onboard', 'home'].forEach(function (v) { $('view-' + v).classList.toggle('hidden', v !== view); });
    $('appHeader').classList.toggle('hidden', view !== 'home');
    $('fab').classList.toggle('hidden', view !== 'home');
    window.scrollTo(0, 0);
  }

  // ---------- landing ----------
  $('btnCreate').addEventListener('click', async function () {
    var name = $('createName').value.trim();
    if (!name) { toast('Give your household a name first 🏠'); return; }
    try {
      var hh = await api('/api/households', { method: 'POST', body: JSON.stringify({ name: name }) });
      S.household = hh; S.onboardCode = hh.join_code;
      buildOnboard();
      show('onboard');
    } catch (e) { toast('Hmm, that didn\'t work: ' + e.message); }
  });

  $('btnJoin').addEventListener('click', async function () {
    var code = $('joinCode').value.trim().toUpperCase();
    if (code.length !== 6) { toast('Codes are 6 letters — check with your family 🔑'); return; }
    try {
      var hh = await api('/api/households/' + encodeURIComponent(code));
      S.household = hh; S.onboardCode = hh.join_code;
      buildOnboard();
      show('onboard');
    } catch (e) { toast('Couldn\'t find that household 😕'); }
  });
  $('btnBackLanding').addEventListener('click', function () { show('landing'); });

  // ---------- onboarding ----------
  function buildOnboard() {
    $('memberName').value = '';
    S.avatar = '😀'; S.avatarKind = 'emoji';
    renderEmojiGrid();
    $('tabEmoji').classList.add('active'); $('tabPhoto').classList.remove('active');
    $('emojiPane').classList.remove('hidden'); $('photoPane').classList.add('hidden');
    $('photoPreview').classList.add('hidden'); $('photoPreview').src = '';
  }
  function renderEmojiGrid() {
    var g = $('emojiGrid'); g.innerHTML = '';
    EMOJIS.forEach(function (e) {
      var d = document.createElement('div');
      d.className = 'emoji-pick' + (S.avatarKind === 'emoji' && S.avatar === e ? ' active' : '');
      d.textContent = e;
      d.addEventListener('click', function () { S.avatar = e; S.avatarKind = 'emoji'; renderEmojiGrid(); });
      g.appendChild(d);
    });
  }
  $('tabEmoji').addEventListener('click', function () {
    S.avatarKind = 'emoji'; if (!S.avatar || S.avatar.indexOf('data:') === 0) S.avatar = '😀';
    $('tabEmoji').classList.add('active'); $('tabPhoto').classList.remove('active');
    $('emojiPane').classList.remove('hidden'); $('photoPane').classList.add('hidden');
    renderEmojiGrid();
  });
  $('tabPhoto').addEventListener('click', function () {
    $('tabPhoto').classList.add('active'); $('tabEmoji').classList.remove('active');
    $('photoPane').classList.remove('hidden'); $('emojiPane').classList.add('hidden');
  });
  $('photoInput').addEventListener('change', function (ev) {
    var f = ev.target.files && ev.target.files[0];
    if (!f) return;
    downscalePhoto(f).then(function (url) {
      S.avatar = url; S.avatarKind = 'photo';
      var p = $('photoPreview'); p.src = url; p.classList.remove('hidden');
      toast('Looking good! 📸');
    }).catch(function () { toast('Couldn\'t read that photo 😕'); });
  });
  function downscalePhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var max = 256, sc = Math.min(1, max / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * sc));
          c.height = Math.max(1, Math.round(img.height * sc));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/jpeg', 0.82));
        } catch (e) { reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('load')); };
      img.src = url;
    });
  }

  $('btnOnboard').addEventListener('click', async function () {
    var name = $('memberName').value.trim();
    if (!name) { toast('Tell us your name first 👋'); return; }
    try {
      var m = await api('/api/households/' + encodeURIComponent(S.onboardCode) + '/members', {
        method: 'POST',
        body: JSON.stringify({ name: name, avatar: S.avatar, avatar_kind: S.avatarKind }),
      });
      S.member = m; S.code = S.onboardCode;
      saveSession();
      enterHome();
      toast('Welcome to the kitchen, ' + name + '! 🎉', m.avatar, m.avatar_kind);
    } catch (e) { toast('Hmm: ' + e.message); }
  });

  // ---------- home ----------
  function enterHome() {
    $('hhName').textContent = S.household.name;
    var chip = $('codeChip');
    chip.textContent = 'CODE: ' + S.code;
    chip.onclick = function () {
      var done = function () { toast('Invite code copied — send it to the family! 📋'); };
      if (navigator.clipboard) navigator.clipboard.writeText(S.code).then(done, done);
      else done();
    };
    show('home');
    connectSocket();
    refreshStock();
  }

  function refreshStock() {
    api('/api/households/' + encodeURIComponent(S.code) + '/stock')
      .then(function (d) { S.stock = d.items; renderStock(); })
      .catch(function () { toast('Couldn\'t load stock 😕'); });
  }

  function fmtQty(q) { return Number.isInteger(q) ? String(q) : String(Number(q.toFixed(2))); }

  function renderStock() {
    var box = $('stockSections'); box.innerHTML = '';
    var total = 0;
    ['kitchen', 'fridge', 'freezer'].forEach(function (loc) {
      var items = S.stock.filter(function (i) { return i.location === loc; });
      total += items.length;
      var sec = document.createElement('div');
      sec.className = 'loc-section';
      var meta = LOC_META[loc];
      var html = '<h2 class="loc-title">' + meta.icon + ' ' + meta.label +
        ' <span class="count">' + items.length + '</span></h2>';
      if (!items.length) {
        html += '<div class="empty-note">Nothing here yet — tap + to stock up 🛒</div>';
      } else {
        items.forEach(function (it) {
          var zero = it.qty <= 0 ? ' zero' : '';
          html += '<div class="stock-item" data-id="' + it.id + '">' +
            '<div class="stock-info"><div class="stock-name">' + esc(it.name) + '</div>' +
            '<div class="stock-qty' + zero + '">' + fmtQty(it.qty) + ' ' + esc(it.unit) +
            (it.qty <= 0 ? ' · all gone!' : '') + '</div></div>' +
            '<div class="stepper">' +
            '<button class="step-btn minus" data-act="dec" title="Use one">−</button>' +
            '<button class="step-btn" data-act="inc" title="Add one">+</button>' +
            '<button class="icon-btn" data-act="edit" title="Edit">✏️</button>' +
            '</div></div>';
        });
      }
      sec.innerHTML = html;
      box.appendChild(sec);
    });
    box.querySelectorAll('.stock-item').forEach(function (el) {
      var id = el.getAttribute('data-id');
      el.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () { return onItemAction(id, btn.getAttribute('data-act')); });
      });
    });
  }

  function onItemAction(id, act) {
    if (act === 'inc') return adjustItem(id, 1);
    if (act === 'dec') return adjustItem(id, -1);
    if (act === 'edit') return openModal(id);
  }

  function adjustItem(id, delta) {
    api('/api/households/' + encodeURIComponent(S.code) + '/stock/' + id + '/adjust', {
      method: 'POST', body: JSON.stringify({ delta: delta, member_id: S.member.id }),
    }).catch(function (e) { toast('Hmm: ' + e.message); refreshStock(); });
    // UI updates when the socket broadcast arrives — that's the realtime magic ✨
  }

  function upsertItem(item) {
    var i = S.stock.findIndex(function (x) { return x.id === item.id; });
    if (i >= 0) S.stock[i] = item; else S.stock.unshift(item);
  }

  // ---------- socket ----------
  function connectSocket() {
    if (S.socket) S.socket.disconnect();
    var socket = io();
    S.socket = socket;
    socket.on('connect', function () {
      socket.emit('join', { code: S.code, memberId: S.member.id });
    });
    socket.on('join:error', function () {
      toast('Lost your seat — rejoining… 🔄');
      clearSession(); setTimeout(function () { location.reload(); }, 1200);
    });
    socket.on('stock:changed', function (p) {
      if (p.action === 'removed') {
        S.stock = S.stock.filter(function (x) { return x.id !== p.item.id; });
      } else {
        upsertItem(p.item);
      }
      renderStock();
    });
    socket.on('activity', function (a) { toast(a.text, a.avatar, a.avatar_kind); });
    socket.on('presence', function (p) { S.presence = p.members; renderPresence(); });
    // auto-reconnect is built into socket.io; rejoin on reconnect
    socket.io.on('reconnect', function () { socket.emit('join', { code: S.code, memberId: S.member.id }); });
  }

  function renderPresence() {
    var row = $('onlineRow');
    if (!S.presence.length) { row.innerHTML = '<span class="online-label">no one online right now</span>'; return; }
    var html = '<span class="online-label">in the kitchen:</span>';
    S.presence.slice(0, 8).forEach(function (m) { html += avatarHTML(m); });
    if (S.presence.length > 8) html += '<span class="online-label">+' + (S.presence.length - 8) + '</span>';
    row.innerHTML = html;
  }

  // ---------- modal (add / edit) ----------
  function setLocSeg(loc) {
    $('fLoc').querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-loc') === loc);
    });
  }
  $('fLoc').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (b) setLocSeg(b.getAttribute('data-loc'));
  });

  $('fab').addEventListener('click', function () { openModal(null); });
  $('btnCloseModal').addEventListener('click', closeModal);
  $('modalBack').addEventListener('click', function (e) { if (e.target === $('modalBack')) closeModal(); });

  function openModal(id) {
    resetVoice();
    $('editId').value = id || '';
    var it = id ? S.stock.find(function (x) { return x.id === id; }) : null;
    $('modalTitle').textContent = it ? 'Edit item' : 'Add to stock';
    $('fName').value = it ? it.name : '';
    $('fQty').value = it ? it.qty : 1;
    $('fUnit').value = it ? it.unit : 'pcs';
    setLocSeg(it ? it.location : 'kitchen');
    $('editDanger').classList.toggle('hidden', !it);
    $('modalBack').classList.remove('hidden');
    setTimeout(function () { $('fName').focus(); }, 60);
  }
  function closeModal() { $('modalBack').classList.add('hidden'); }

  $('btnSaveItem').addEventListener('click', async function () {
    var id = $('editId').value;
    var locBtn = $('fLoc').querySelector('button.active');
    var body = {
      name: $('fName').value.trim(),
      qty: Number($('fQty').value) || 0,
      unit: $('fUnit').value,
      location: locBtn ? locBtn.getAttribute('data-loc') : 'kitchen',
      member_id: S.member.id,
    };
    if (!body.name) { toast('Name the item first 🏷️'); return; }
    try {
      if (id) {
        await api('/api/households/' + encodeURIComponent(S.code) + '/stock/' + id, {
          method: 'PATCH', body: JSON.stringify(body),
        });
      } else {
        await api('/api/households/' + encodeURIComponent(S.code) + '/stock', {
          method: 'POST', body: JSON.stringify(body),
        });
      }
      closeModal();
    } catch (e) { toast('Hmm: ' + e.message); }
  });

  $('btnUseUp').addEventListener('click', async function () {
    var id = $('editId').value;
    var it = S.stock.find(function (x) { return x.id === id; });
    if (!it) return;
    closeModal();
    await adjustItem(id, -it.qty); // zeroes it, server tags it "used-up" ✨
  });

  $('btnDelete').addEventListener('click', async function () {
    var id = $('editId').value;
    if (!id || !confirm('Remove this item for everyone?')) return;
    closeModal();
    try {
      await api('/api/households/' + encodeURIComponent(S.code) + '/stock/' + id + '?member_id=' + S.member.id, { method: 'DELETE' });
    } catch (e) { toast('Hmm: ' + e.message); }
  });

  // ---------- voice input (Web Speech API, no keys needed) ----------
  var VOICE_UNITS = ['pcs', 'g', 'kg', 'ml', 'L', 'cups', 'tbsp', 'tsp', 'packets', 'bunches'];
  var voiceChips = []; // {name, qty, unit} — user confirms before anything is added
  var voiceRec = null, voiceListening = false;
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  function voiceSupported() { return !!SpeechRec && !!(window.WhatToEatVoice); }

  function resetVoice() {
    stopVoice();
    voiceChips = [];
    $('voicePane').classList.add('hidden');
    $('voiceTranscript').classList.add('hidden');
    $('voiceTranscript').textContent = '';
    $('voiceChips').innerHTML = '';
    $('btnVoiceAdd').classList.add('hidden');
    var st = $('voiceStatus');
    st.textContent = 'Tap the mic and speak your list — e.g. “two kilos of atta, a dozen eggs”';
    st.classList.remove('listening');
    $('micBtn').classList.toggle('hidden', !voiceSupported());
  }

  function stopVoice() {
    voiceListening = false;
    var mb = $('micBtn'); if (mb) mb.classList.remove('listening');
    var st = $('voiceStatus'); if (st) st.classList.remove('listening');
    if (voiceRec) { try { voiceRec.onend = null; voiceRec.onerror = null; voiceRec.stop(); } catch (e) {} voiceRec = null; }
  }

  function toggleVoice() {
    if (voiceListening) {
      stopVoice();
      $('voiceStatus').textContent = voiceChips.length
        ? 'Got it! Check the items, fix anything, then add 👇'
        : 'Stopped — tap the mic to try again 🎤';
      return;
    }
    var rec = new SpeechRec();
    voiceRec = rec;
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    voiceListening = true;
    $('voicePane').classList.remove('hidden');
    $('micBtn').classList.add('listening');
    var st = $('voiceStatus');
    st.textContent = '🎙️ Listening… speak your list';
    st.classList.add('listening');
    var finalText = '';
    rec.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += t + ' ';
        else interim += t;
      }
      var show = (finalText + interim).trim();
      if (show) {
        var tr = $('voiceTranscript');
        tr.textContent = '“' + show + '”';
        tr.classList.remove('hidden');
      }
      if (finalText.trim()) addVoiceChips(window.WhatToEatVoice.parseVoiceList(finalText));
    };
    rec.onerror = function (ev) {
      stopVoice();
      $('voiceStatus').textContent = ev.error === 'not-allowed'
        ? 'Mic blocked — allow microphone access in the browser and try again 🎤'
        : 'Didn\'t catch that — tap the mic and try again 🎤';
    };
    rec.onend = function () {
      if (voiceListening) {
        stopVoice();
        $('voiceStatus').textContent = voiceChips.length
          ? 'Got it! Check the items, fix anything, then add 👇'
          : 'Didn\'t catch that — tap the mic and try again 🎤';
      }
    };
    try { rec.start(); } catch (e) { stopVoice(); }
  }

  function addVoiceChips(parsed) {
    var added = 0;
    parsed.forEach(function (p) {
      var dup = voiceChips.some(function (c) { return c.name.toLowerCase() === p.name.toLowerCase() && c.unit === p.unit; });
      if (!dup) { voiceChips.push({ name: p.name, qty: p.qty, unit: p.unit }); added++; }
    });
    if (added) renderVoiceChips();
  }

  function renderVoiceChips() {
    var box = $('voiceChips'); box.innerHTML = '';
    voiceChips.forEach(function (c, idx) {
      var d = document.createElement('div');
      d.className = 'vchip';
      var opts = VOICE_UNITS.map(function (u) {
        return '<option' + (u === c.unit ? ' selected' : '') + '>' + u + '</option>';
      }).join('');
      d.innerHTML = '<input type="text" data-f="name" value="' + esc(c.name) + '" maxlength="60">' +
        '<input type="number" data-f="qty" value="' + c.qty + '" min="0" step="any">' +
        '<select data-f="unit">' + opts + '</select>' +
        '<button class="vchip-x" title="Remove">×</button>';
      d.querySelector('[data-f="name"]').addEventListener('input', function (e) { c.name = e.target.value; });
      d.querySelector('[data-f="qty"]').addEventListener('input', function (e) { c.qty = Number(e.target.value) || 0; });
      d.querySelector('[data-f="unit"]').addEventListener('change', function (e) { c.unit = e.target.value; });
      d.querySelector('.vchip-x').addEventListener('click', function () { voiceChips.splice(idx, 1); renderVoiceChips(); });
      box.appendChild(d);
    });
    var btn = $('btnVoiceAdd');
    btn.classList.toggle('hidden', !voiceChips.length);
    btn.textContent = 'Add ' + voiceChips.length + (voiceChips.length === 1 ? ' item' : ' items') + ' →';
  }

  $('micBtn').addEventListener('click', toggleVoice);

  $('btnVoiceAdd').addEventListener('click', async function () {
    var locBtn = $('fLoc').querySelector('button.active');
    var location = locBtn ? locBtn.getAttribute('data-loc') : 'kitchen';
    var items = voiceChips.filter(function (c) { return c.name.trim(); });
    if (!items.length) return;
    var n = 0;
    for (var i = 0; i < items.length; i++) {
      try {
        await api('/api/households/' + encodeURIComponent(S.code) + '/stock', {
          method: 'POST',
          body: JSON.stringify({
            name: items[i].name.trim(), qty: items[i].qty,
            unit: items[i].unit, location: location, member_id: S.member.id,
          }),
        });
        n++;
      } catch (e) { /* keep going with the rest */ }
    }
    closeModal();
    toast(n === items.length ? 'Added ' + n + ' items 🎉' : 'Added ' + n + ' of ' + items.length + ' (some failed)');
  });

  // ---------- what to eat? (Phase 2) ----------
  var E = { meal: 'any', diet: 'any', servings: 4, detail: null, classicsLoaded: false };

  function switchTab(which) {
    $('tabStock').classList.toggle('active', which === 'stock');
    $('tabEat').classList.toggle('active', which === 'eat');
    $('stockPane').classList.toggle('hidden', which !== 'stock');
    $('eatPane').classList.toggle('hidden', which !== 'eat');
    window.scrollTo(0, 0);
  }
  $('tabStock').addEventListener('click', function () { switchTab('stock'); });
  $('tabEat').addEventListener('click', function () { switchTab('eat'); loadClassics(); });

  function wirePills(id, key) {
    $(id).querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        $(id).querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        E[key] = b.getAttribute('data-v');
      });
    });
  }
  wirePills('mealPills', 'meal');
  wirePills('dietPills', 'diet');

  $('servMinus').addEventListener('click', function () {
    if (E.servings > 1) { E.servings--; $('servVal').textContent = E.servings; }
  });
  $('servPlus').addEventListener('click', function () {
    if (E.servings < 24) { E.servings++; $('servVal').textContent = E.servings; }
  });

  function suggestApi(params) {
    var qs = Object.keys(params)
      .filter(function (k) { return params[k] !== '' && params[k] != null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return api('/api/households/' + encodeURIComponent(S.code) + '/suggest?' + qs);
  }

  function dietIcon(d) { return { vegan: '🌱', veg: '🥬', egg: '🥚', nonveg: '🍗' }[d] || '🍽️'; }

  function macroChips(m) {
    return '<span class="mchip">💪 ' + m.protein_g + 'g protein</span>' +
      '<span class="mchip">🔥 ' + m.calories + ' cal</span>' +
      '<span class="mchip">🌾 ' + m.carbs_g + 'g carbs</span>';
  }

  function suggestionCard(v) {
    var pct = v.matchPct;
    var cls = pct >= 80 ? 'great' : (pct >= 50 ? 'ok' : 'low');
    var miss = v.missing.length
      ? '<div class="missing-note">Missing: ' + esc(v.missing.slice(0, 3).map(function (m) { return m.name; }).join(', ')) +
        (v.missing.length > 3 ? ' +' + (v.missing.length - 3) + ' more' : '') + '</div>'
      : '<div class="all-have">✅ You have everything!</div>';
    return '<div class="sugg-card" data-id="' + v.id + '">' +
      (v.heritage ? '<div class="heritage-badge">🏠 Back home classic</div>' : '') +
      '<div class="sugg-title">' + esc(v.name) + ' <span class="diet-ic">' + dietIcon(v.diet) + '</span></div>' +
      '<div class="sugg-desc">' + esc(v.description) + '</div>' +
      '<div class="match-row"><div class="match-bar"><div class="match-fill ' + cls + '" style="width:' + pct + '%"></div></div>' +
      '<span class="match-pct">' + pct + '% in stock</span></div>' +
      '<div class="macro-row">' + macroChips(v.macros) + '</div>' + miss + '</div>';
  }

  function attachCardClicks(box) {
    box.querySelectorAll('.sugg-card').forEach(function (card) {
      card.addEventListener('click', function () { openRecipe(card.getAttribute('data-id')); });
    });
  }

  function loadClassics() {
    if (E.classicsLoaded) return;
    E.classicsLoaded = true;
    suggestApi({ heritage: 'punjabi-classic', servings: 4 }).then(function (d) {
      var box = $('classicsShelf');
      box.innerHTML = '';
      if (!d.suggestions.length) { box.innerHTML = '<div class="shelf-loading">No classics yet 🪔</div>'; return; }
      d.suggestions.forEach(function (v) {
        var el = document.createElement('div');
        el.className = 'shelf-card';
        el.innerHTML = '<div class="shelf-name">' + esc(v.name) + '</div>' +
          '<div class="shelf-match">' + v.matchPct + '% in stock</div>';
        el.addEventListener('click', function () { openRecipe(v.id); });
        box.appendChild(el);
      });
    }).catch(function () {
      E.classicsLoaded = false;
      $('classicsShelf').innerHTML = '<div class="shelf-loading">Couldn\'t load 😕</div>';
    });
  }

  function findDishes() {
    var p = { servings: E.servings, meal: E.meal, diet: E.diet };
    var mp = Number($('fMinProtein').value); if (mp > 0) p.minProtein = mp;
    var mc = Number($('fMaxCal').value); if (mc > 0) p.maxCalories = mc;
    var cb = Number($('fMaxCarbs').value); if (cb > 0) p.maxCarbs = cb;
    var box = $('suggestResults');
    box.innerHTML = '<div class="empty-note">Finding dishes… 🍳</div>';
    suggestApi(p).then(function (d) {
      box.innerHTML = '';
      if (!d.suggestions.length) {
        box.innerHTML = '<div class="empty-note">No dishes match — loosen the filters 🙂</div>';
        return;
      }
      var head = document.createElement('div');
      head.className = 'res-count';
      head.textContent = d.suggestions.length + ' dish' + (d.suggestions.length === 1 ? '' : 'es') +
        ' for ' + d.servings + ' servings';
      box.appendChild(head);
      d.suggestions.forEach(function (v) {
        var t = document.createElement('div');
        t.innerHTML = suggestionCard(v);
        var card = t.firstChild;
        card.addEventListener('click', function () { openRecipe(v.id); });
        box.appendChild(card);
      });
    }).catch(function (e) {
      box.innerHTML = '<div class="empty-note">Hmm: ' + esc(e.message) + '</div>';
    });
  }
  $('btnFind').addEventListener('click', findDishes);

  function openRecipe(id, servings) {
    api('/api/households/' + encodeURIComponent(S.code) + '/recipes/' + id +
        '?servings=' + (servings || E.servings))
      .then(function (v) {
        E.detail = v;
        renderRecipeModal();
        $('recipeBack').classList.remove('hidden');
      })
      .catch(function (e) { toast('Hmm: ' + e.message); });
  }

  function renderRecipeModal() {
    var v = E.detail;
    if (!v) return;
    $('recipeName').textContent = v.name;
    $('recipeMeta').innerHTML =
      (v.heritage ? '<span class="heritage-badge">🏠 Back home classic</span>' : '') +
      '<span class="meta-chip">' + dietIcon(v.diet) + ' ' + esc(v.diet) + '</span>' +
      '<span class="meta-chip">⏱ ' + v.prep_minutes + ' min</span>' +
      '<span class="meta-chip">' + esc(v.meal_types.join(' · ')) + '</span>';
    $('recipeMacros').innerHTML = macroChips(v.macros) +
      '<span class="mchip">🧈 ' + v.macros.fat_g + 'g fat</span>';
    var hn = $('recipeHealth');
    if (v.health_note) { hn.textContent = '💛 ' + v.health_note; hn.classList.remove('hidden'); }
    else hn.classList.add('hidden');
    $('rServVal').textContent = v.servings;
    $('recipeMatch').textContent = v.matchPct + '% in your stock';
    $('recipeIngs').innerHTML = v.ingredients.map(function (g) {
      return '<div class="ing-row' + (g.in_stock ? ' have' : ' miss') + '">' +
        '<span class="ing-tick">' + (g.in_stock ? '✅' : '❌') + '</span>' +
        '<span class="ing-name">' + esc(g.name) +
        (g.note ? ' <span class="ing-note">(' + esc(g.note) + ')</span>' : '') + '</span>' +
        '<span class="ing-qty">' + (g.qty == null ? '' : fmtQty(g.qty) + ' ' + esc(g.unit)) + '</span></div>';
    }).join('');
    $('recipeSteps').innerHTML = v.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
  }

  $('rServMinus').addEventListener('click', function () {
    if (E.detail && E.detail.servings > 1) openRecipe(E.detail.id, E.detail.servings - 1);
  });
  $('rServPlus').addEventListener('click', function () {
    if (E.detail && E.detail.servings < 24) openRecipe(E.detail.id, E.detail.servings + 1);
  });
  $('btnCloseRecipe').addEventListener('click', function () { $('recipeBack').classList.add('hidden'); });
  $('recipeBack').addEventListener('click', function (e) {
    if (e.target === $('recipeBack')) $('recipeBack').classList.add('hidden');
  });

  $('btnCook').addEventListener('click', async function () {
    if (!E.detail || !S.member) return;
    var v = E.detail;
    $('btnCook').disabled = true;
    try {
      var r = await api('/api/households/' + encodeURIComponent(S.code) + '/recipes/' + v.id + '/cook', {
        method: 'POST',
        body: JSON.stringify({ member_id: S.member.id, servings: v.servings }),
      });
      $('recipeBack').classList.add('hidden');
      var usedTxt = r.used.length ? 'Used: ' + r.used.map(function (u) { return u.name; }).join(', ') : 'nothing to deduct';
      toast('🍳 Cooking ' + v.name + '! ' + usedTxt);
      if (r.missing.length) {
        setTimeout(function () {
          toast('🛒 Still need: ' + r.missing.map(function (m) { return m.name; }).join(', '));
        }, 2000);
      }
      refreshStock();
      E.classicsLoaded = false; // stock changed — refresh match % next visit
    } catch (e) { toast('Hmm: ' + e.message); }
    $('btnCook').disabled = false;
  });

  // ---------- boot ----------
  (function boot() {
    var sess = loadSession();
    if (sess && sess.code && sess.memberId) {
      Promise.all([
        api('/api/households/' + encodeURIComponent(sess.code)),
        api('/api/households/' + encodeURIComponent(sess.code) + '/members'),
      ]).then(function (r) {
        var hh = r[0];
        var me = r[1].members.find(function (m) { return m.id === sess.memberId; });
        if (!me) { clearSession(); show('landing'); return; }
        S.household = hh; S.code = hh.join_code; S.member = me;
        enterHome();
      }).catch(function () { clearSession(); show('landing'); });
    } else {
      show('landing');
    }
  })();
})();
