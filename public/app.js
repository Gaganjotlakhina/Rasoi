/* Kya Khaye frontend — Phase 1: households, onboarding, live stock. */
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
    socket.on('tobuy:changed', function () { refreshTobuy(); });
    socket.on('poll:changed', function () { if (curTab === 'vote') loadPolls(); });
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
    resetScan();
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
    resetScan();
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

  // shared by voice chips and scan chips: batch-add confirmed items to stock
  async function addChipsToStock(chips) {
    var locBtn = $('fLoc').querySelector('button.active');
    var location = locBtn ? locBtn.getAttribute('data-loc') : 'kitchen';
    var items = chips.filter(function (c) { return c.name.trim(); });
    if (!items.length) return 0;
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
    return { added: n, total: items.length };
  }

  $('btnVoiceAdd').addEventListener('click', async function () {
    var r = await addChipsToStock(voiceChips);
    closeModal();
    toast(r.added === r.total ? 'Added ' + r.added + ' items 🎉' : 'Added ' + r.added + ' of ' + r.total + ' (some failed)');
  });

  // ---------- receipt scan (photo -> stock, Phase 4) ----------
  var scanChips = []; // {name, qty, unit} — user confirms before anything is added
  var scanImageData = null; // downscaled JPEG data URL sent to /scan

  function resetScan() {
    scanChips = [];
    scanImageData = null;
    $('scanPane').classList.add('hidden');
    var th = $('scanThumb'); th.classList.add('hidden'); th.removeAttribute('src');
    $('scanChips').innerHTML = '';
    $('btnScanRead').classList.add('hidden');
    $('btnScanAdd').classList.add('hidden');
    var st = $('scanStatus');
    st.textContent = 'Snap a grocery list or store receipt — I’ll read the items 📸';
    st.classList.remove('reading');
    var f = $('scanFile'); if (f) f.value = '';
  }

  function downscaleImage(dataUrl, maxDim, cb) {
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      cb(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = function () { cb(null); };
    img.src = dataUrl;
  }

  $('scanBtn').addEventListener('click', function () {
    resetVoice();
    $('scanPane').classList.remove('hidden');
    $('scanFile').click();
  });

  $('scanFile').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('That’s not a photo 🖼️'); return; }
    var rd = new FileReader();
    rd.onload = function () {
      downscaleImage(rd.result, 1600, function (small) {
        if (!small) { toast('Couldn’t read that photo — try another 📸'); return; }
        scanImageData = small;
        scanChips = [];
        $('scanChips').innerHTML = '';
        $('btnScanAdd').classList.add('hidden');
        var th = $('scanThumb');
        th.src = small;
        th.classList.remove('hidden');
        $('btnScanRead').classList.remove('hidden');
        $('scanStatus').textContent = 'Looking good — tap “Read items” and I’ll pull out the groceries 📖';
      });
    };
    rd.readAsDataURL(file);
  });

  function addScanChips(parsed) {
    var added = 0;
    parsed.forEach(function (p) {
      var dup = scanChips.some(function (c) { return c.name.toLowerCase() === p.name.toLowerCase() && c.unit === p.unit; });
      if (!dup) { scanChips.push({ name: p.name, qty: p.qty, unit: p.unit }); added++; }
    });
    if (added) renderScanChips();
    return added;
  }

  function renderScanChips() {
    var box = $('scanChips'); box.innerHTML = '';
    scanChips.forEach(function (c, idx) {
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
      d.querySelector('.vchip-x').addEventListener('click', function () { scanChips.splice(idx, 1); renderScanChips(); });
      box.appendChild(d);
    });
    var btn = $('btnScanAdd');
    btn.classList.toggle('hidden', !scanChips.length);
    btn.textContent = 'Add ' + scanChips.length + (scanChips.length === 1 ? ' item' : ' items') + ' →';
  }

  $('btnScanRead').addEventListener('click', async function () {
    if (!scanImageData) return;
    var st = $('scanStatus');
    st.textContent = '📖 Reading your receipt… give me ~20 seconds';
    st.classList.add('reading');
    $('btnScanRead').classList.add('hidden');
    try {
      var r = await api('/api/households/' + encodeURIComponent(S.code) + '/scan', {
        method: 'POST',
        body: JSON.stringify({ member_id: S.member.id, image: scanImageData }),
      });
      var items = (r && r.items) || [];
      var n = addScanChips(items);
      st.classList.remove('reading');
      st.textContent = n
        ? 'Found ' + n + (n === 1 ? ' item' : ' items') + ' — fix anything, then add 👇'
        : 'Couldn’t find any items — try a clearer, straighter photo 📸';
      if (!n) $('btnScanRead').classList.remove('hidden');
    } catch (e) {
      st.classList.remove('reading');
      st.textContent = e.message && /not available/i.test(e.message)
        ? 'Receipt scanning isn’t switched on yet — tell the family chef 📸'
        : 'Hmm, that didn’t work — try a clearer photo 📸';
      $('btnScanRead').classList.remove('hidden');
    }
  });

  $('btnScanAdd').addEventListener('click', async function () {
    var r = await addChipsToStock(scanChips);
    closeModal();
    toast(r.added === r.total ? 'Added ' + r.added + ' items 🎉' : 'Added ' + r.added + ' of ' + r.total + ' (some failed)');
  });

  // ---------- what to eat? (Phase 2) ----------
  var E = { meal: 'any', diet: 'any', servings: 4, detail: null, classicsLoaded: false };

  // ---------- tabs (Phase 1 stock / Phase 2 eat / Phase 3 tobuy + vote) ----------
  var TABS = ['stock', 'eat', 'tobuy', 'vote'];
  var curTab = 'stock';
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function switchTab(which) {
    curTab = which;
    TABS.forEach(function (t) {
      $('tab' + cap(t)).classList.toggle('active', t === which);
      $(t + 'Pane').classList.toggle('hidden', t !== which);
    });
    if (which === 'tobuy') refreshTobuy();
    if (which === 'vote') loadPolls();
    if (which === 'eat') loadClassics();
    window.scrollTo(0, 0);
  }
  TABS.forEach(function (t) {
    $('tab' + cap(t)).addEventListener('click', function () { switchTab(t); });
  });

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

  // ---------- to buy (Phase 3) ----------
  var T = { items: [] };

  function refreshTobuy() {
    if (!S.code) return;
    api('/api/households/' + encodeURIComponent(S.code) + '/tobuy')
      .then(function (d) { T.items = d.items; renderTobuy(); })
      .catch(function () { toast('Couldn\'t load the list 😕'); });
  }

  function renderTobuy() {
    var box = $('tobuyList'); box.innerHTML = '';
    if (!T.items.length) {
      box.innerHTML = '<div class="empty-note">List is empty — add something, or cook and watch it fill itself 🛒</div>';
      return;
    }
    T.items.forEach(function (it) {
      var d = document.createElement('div');
      d.className = 'tb-item' + (it.done ? ' done' : '');
      var badge = it.source === 'auto'
        ? '<span class="src-badge auto" title="Added automatically when it ran out">🤖 auto</span>'
        : '<span class="src-badge manual">✋ manual</span>';
      d.innerHTML =
        '<button class="tb-check" title="Bought it?">' + (it.done ? '✅' : '⬜') + '</button>' +
        '<div class="tb-info"><div class="tb-name">' + esc(it.name) + '</div>' +
        '<div class="tb-sub">' + fmtQty(it.qty) + ' ' + esc(it.unit) + ' · ' + badge + '</div></div>' +
        '<button class="icon-btn tb-del" title="Remove">🗑️</button>';
      d.querySelector('.tb-check').addEventListener('click', function () {
        api('/api/households/' + encodeURIComponent(S.code) + '/tobuy/' + it.id, {
          method: 'PATCH', body: JSON.stringify({ member_id: S.member.id, done: !it.done }),
        }).catch(function (e) { toast('Hmm: ' + e.message); });
      });
      d.querySelector('.tb-del').addEventListener('click', function () {
        if (!confirm('Remove "' + it.name + '" from the list?')) return;
        api('/api/households/' + encodeURIComponent(S.code) + '/tobuy/' + it.id +
            '?member_id=' + S.member.id, { method: 'DELETE' })
          .catch(function (e) { toast('Hmm: ' + e.message); });
      });
      box.appendChild(d);
    });
  }

  $('btnTbAdd').addEventListener('click', async function () {
    var name = $('tbName').value.trim();
    if (!name) { toast('Name the item first 🏷️'); return; }
    try {
      await api('/api/households/' + encodeURIComponent(S.code) + '/tobuy', {
        method: 'POST',
        body: JSON.stringify({
          name: name, qty: Number($('tbQty').value) || 1,
          unit: $('tbUnit').value, member_id: S.member.id,
        }),
      });
      $('tbName').value = ''; $('tbQty').value = 1;
    } catch (e) { toast('Hmm: ' + e.message); }
  });

  // ---------- family vote (Phase 3) ----------
  var V = { open: null, history: [], recipes: [], picked: {}, slot: 'dinner' };

  function loadPolls() {
    if (!S.code) return;
    api('/api/households/' + encodeURIComponent(S.code) + '/polls?member_id=' + S.member.id)
      .then(function (d) { V.open = d.open; V.history = d.history; renderVote(); })
      .catch(function () { toast('Couldn\'t load votes 😕'); });
  }

  function renderVote() {
    var openBox = $('pollOpen'); openBox.innerHTML = '';
    $('pollStartWrap').innerHTML = '';
    if (V.open) renderOpenPoll(V.open, openBox);
    else renderPollStart();
    renderPollHistory();
  }

  function renderOpenPoll(p, box) {
    var el = document.createElement('div');
    el.className = 'card poll-card';
    el.innerHTML = '<h3 style="margin:0 0 2px">🗳️ Family vote — ' + esc(p.meal_slot) + '</h3>' +
      '<p class="poll-sub">started by ' + esc(p.created_by ? p.created_by.name : 'someone') +
      ' · ' + p.total_votes + ' of ' + p.total_members + ' voted</p>' +
      '<div class="poll-cands"></div>' +
      '<button class="btn secondary" id="btnClosePoll">Close vote & decide 🏁</button>';
    box.appendChild(el);
    var cbox = el.querySelector('.poll-cands');
    var maxVotes = Math.max.apply(null, [1].concat(p.candidates.map(function (c) { return c.votes; })));
    p.candidates.forEach(function (c) {
      var card = document.createElement('div');
      card.className = 'cand-card' + (c.my_voted ? ' voted' : '');
      var pct = Math.round((c.votes / maxVotes) * 100);
      var voters = c.voters.map(function (v) { return avatarHTML(v, 'avatar-chip sm'); }).join('');
      card.innerHTML =
        (c.heritage ? '<div class="heritage-badge">🏠 Back home classic</div>' : '') +
        '<div class="cand-name">' + esc(c.name) + ' <span class="diet-ic">' + dietIcon(c.diet) + '</span></div>' +
        '<div class="tally-bar"><div class="tally-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="cand-foot"><span class="cand-votes">' + c.votes + (c.votes === 1 ? ' vote' : ' votes') + '</span>' +
        '<span class="voter-row">' + voters + '</span></div>' +
        (c.my_voted ? '<div class="my-vote">✓ your pick</div>' : '');
      card.addEventListener('click', function () { castVote(p.id, c.id); });
      cbox.appendChild(card);
    });
    el.querySelector('#btnClosePoll').addEventListener('click', function () {
      if (!confirm('Close the vote and declare the winner?')) return;
      api('/api/households/' + encodeURIComponent(S.code) + '/polls/' + p.id + '/close', {
        method: 'POST', body: JSON.stringify({ member_id: S.member.id }),
      }).catch(function (e) { toast('Hmm: ' + e.message); });
    });
  }

  function renderPollStart() {
    var box = $('pollStartWrap');
    var el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = '<h3 style="margin:0 0 2px">🗳️ Start a family vote</h3>' +
      '<p class="poll-sub">Pick a meal, nominate up to 4 dishes, everyone taps their favourite.</p>' +
      '<label class="field">MEAL</label>' +
      '<div class="pills" id="pollSlots">' +
      '<button data-v="breakfast">🌅 Breakfast</button>' +
      '<button data-v="lunch">☀️ Lunch</button>' +
      '<button data-v="dinner" class="active">🌙 Dinner</button>' +
      '<button data-v="snack">🍿 Snack</button></div>' +
      '<label class="field">DISHES (up to 4)</label>' +
      '<input type="text" id="pollSearch" placeholder="Search dishes… 🔍" autocomplete="off">' +
      '<div id="pollPickList" class="pick-list"><div class="empty-note">Loading dishes…</div></div>' +
      '<button class="btn" id="btnStartPoll">Start vote 🗳️</button>';
    box.appendChild(el);
    V.slot = 'dinner'; V.picked = {};
    el.querySelectorAll('#pollSlots button').forEach(function (b) {
      b.addEventListener('click', function () {
        el.querySelectorAll('#pollSlots button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        V.slot = b.getAttribute('data-v');
      });
    });
    var renderPicks = function (filter) {
      var list = el.querySelector('#pollPickList'); list.innerHTML = '';
      var recs = V.recipes.filter(function (r) {
        return !filter || r.name.toLowerCase().indexOf(filter) >= 0;
      }).slice(0, 40);
      if (!recs.length) { list.innerHTML = '<div class="empty-note">No dishes match 🙂</div>'; return; }
      recs.forEach(function (r) {
        var row = document.createElement('div');
        var isOn = !!V.picked[r.id];
        row.className = 'pick-row' + (isOn ? ' on' : '');
        row.innerHTML = '<span class="pick-tick">' + (isOn ? '✅' : '⬜') + '</span>' +
          '<span class="pick-name">' + esc(r.name) + '</span>' +
          '<span class="diet-ic">' + dietIcon(r.diet) + '</span>';
        row.addEventListener('click', function () {
          if (V.picked[r.id]) delete V.picked[r.id];
          else {
            if (Object.keys(V.picked).length >= 4) { toast('Max 4 dishes per vote 🗳️'); return; }
            V.picked[r.id] = true;
          }
          renderPicks(el.querySelector('#pollSearch').value.trim().toLowerCase());
        });
        list.appendChild(row);
      });
    };
    el.querySelector('#pollSearch').addEventListener('input', function (e) {
      renderPicks(e.target.value.trim().toLowerCase());
    });
    var ready = V.recipes.length ? Promise.resolve() :
      api('/api/households/' + encodeURIComponent(S.code) + '/recipes').then(function (d) { V.recipes = d.recipes; });
    ready.then(function () { renderPicks(''); }).catch(function () {
      el.querySelector('#pollPickList').innerHTML = '<div class="empty-note">Couldn\'t load dishes 😕</div>';
    });
    el.querySelector('#btnStartPoll').addEventListener('click', function () {
      var ids = Object.keys(V.picked);
      if (!ids.length) { toast('Nominate at least one dish 🍽️'); return; }
      api('/api/households/' + encodeURIComponent(S.code) + '/polls', {
        method: 'POST',
        body: JSON.stringify({ member_id: S.member.id, meal_slot: V.slot, recipe_ids: ids }),
      }).catch(function (e) { toast('Hmm: ' + e.message); });
    });
  }

  function renderPollHistory() {
    var box = $('pollHistory'); box.innerHTML = '';
    if (!V.history.length) return;
    var h = document.createElement('h3');
    h.className = 'hist-title'; h.textContent = '📜 Past votes';
    box.appendChild(h);
    V.history.forEach(function (p) {
      var el = document.createElement('div');
      el.className = 'card hist-card';
      var cands = p.candidates.map(function (c) { return esc(c.name) + ' (' + c.votes + ')'; }).join(' · ');
      el.innerHTML = '<div class="winner-banner">🎉 ' + esc(p.winner ? p.winner.name : 'no winner') + '</div>' +
        '<div class="hist-sub">' + esc(p.meal_slot) + ' · ' + cands + '</div>';
      box.appendChild(el);
    });
  }

  function castVote(pollId, recipeId) {
    api('/api/households/' + encodeURIComponent(S.code) + '/polls/' + pollId + '/vote', {
      method: 'POST', body: JSON.stringify({ member_id: S.member.id, recipe_id: recipeId }),
    }).catch(function (e) { toast('Hmm: ' + e.message); });
    // the poll:changed broadcast refreshes the UI live
  }

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
