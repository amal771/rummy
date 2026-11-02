(() => {
const socket = io();
const R = window.RummyRules;
const $ = id => document.getElementById(id);

// ---------- state ----------
const S = {
  key: localStorage.getItem('rummy_player_key') || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()),
  name: '', roomId: sessionStorage.getItem('rummy_room'), isHost: false, config: null,
  status: 'LOBBY', jokerMode: 'open', cutJoker: null, unlocked: false,
  hand: [], layout: [], selected: new Set(), phase: 'WAIT', freshId: null,
  activeKey: null, table: null, showSubmitted: false, lastResult: null,
};
localStorage.setItem('rummy_player_key', S.key);

let timerHandle = null, showHandle = null, toastHandle = null, dragIds = null;

const SUITS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANKS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_ORDER = ['S', 'H', 'C', 'D'];

// ---------- helpers ----------
function toast(msg, bad = false, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => t.classList.add('hidden'), ms);
}
const isWild = c => !!c && (c.isPrintedJoker || (S.unlocked && S.cutJoker && c.rank === S.cutJoker.rank));
const cardById = id => S.hand.find(c => c.id === id);
const me = () => S.table && S.table.players.find(p => p.key === S.key);
const myStatus = () => (me() ? me().status : S.mySync || 'SPECTATOR');
const isMyTurn = () => S.status === 'PLAYING' && S.activeKey === S.key && !(S.table && (S.table.isPaused || S.table.planning));

function makeCard(card, opts = {}) {
  const el = document.createElement('div');
  if (!card) { el.className = 'card empty'; return el; }
  const red = card.suit === 'H' || card.suit === 'D';
  el.className = 'card' + (red ? ' red' : '') + (card.isPrintedJoker ? ' joker' : '') + (opts.mini ? ' mini' : '');
  const wild = isWild(card);
  if (wild && !opts.mini) el.classList.add('wild');
  if (card.isPrintedJoker) {
    el.innerHTML = '<div class="corner">JOKER</div><div class="pip">★</div>';
  } else {
    const r = RANKS[card.rank] || card.rank;
    el.innerHTML = `<div class="corner">${r}<i>${SUITS[card.suit]}</i></div><div class="pip">${SUITS[card.suit]}</div>`;
  }
  if (wild) el.insertAdjacentHTML('beforeend', '<span class="wild-tag">WILD</span>');
  el.setAttribute('aria-label', card.isPrintedJoker ? 'Joker' : `${RANKS[card.rank] || card.rank} of ${SUITS[card.suit]}`);
  return el;
}

function show(screen) {
  $('main-lobby-screen').classList.toggle('hidden', screen !== 'lobby');
  $('game-play-screen').classList.toggle('hidden', screen !== 'game');
}

// ---------- hand layout ----------
function suitGroups(cards) {
  const groups = SUIT_ORDER.map(s => cards.filter(c => c.suit === s).sort((a, b) => a.rank - b.rank).map(c => c.id)).filter(g => g.length);
  const jokers = cards.filter(c => c.isPrintedJoker).map(c => c.id);
  if (jokers.length) groups.push(jokers);
  return groups;
}

function syncLayout(newHand, drawnId) {
  const ids = new Set(newHand.map(c => c.id));
  S.hand = newHand;
  S.layout = S.layout.map(g => g.filter(id => ids.has(id))).filter(g => g.length);
  const placed = new Set(S.layout.flat());
  const fresh = newHand.filter(c => !placed.has(c.id));
  if (fresh.length === newHand.length) S.layout = suitGroups(newHand);
  else fresh.forEach(c => S.layout.push([c.id]));
  S.selected = new Set([...S.selected].filter(id => ids.has(id)));
  S.freshId = drawnId || null;
}

function moveCards(ids, target, beforeId) {
  const set = new Set(ids);
  const moving = S.layout.flat().filter(id => set.has(id));
  S.layout.forEach(g => { for (let i = g.length - 1; i >= 0; i--) if (set.has(g[i])) g.splice(i, 1); });
  if (target === 'new') S.layout.push(moving);
  else {
    let pos = beforeId ? target.indexOf(beforeId) : -1;
    if (pos < 0) pos = target.length;
    target.splice(pos, 0, ...moving);
  }
  S.layout = S.layout.filter(g => g.length);
  S.selected.clear();
  renderHand();
}

function groupInfo(ids) {
  const cards = ids.map(cardById).filter(Boolean);
  const type = R.classifyGroup(cards, S.cutJoker, S.unlocked);
  if (type === 'Pure Sequence') return ['Pure sequence', 'badge-pure'];
  if (type === 'Impure Sequence') return ['Sequence', 'badge-seq'];
  if (type === 'Set') return ['Set', 'badge-set'];
  return cards.length >= 3 ? ['Not a meld', 'badge-bad'] : ['Ungrouped', ''];
}

function renderHand() {
  const wrap = $('melds-wrapper');
  wrap.innerHTML = '';
  S.layout.forEach((ids, gi) => {
    const col = document.createElement('div');
    col.className = 'meld-column';
    col.dataset.group = gi;
    const strip = document.createElement('div');
    strip.className = 'meld-cards';

    ids.forEach(id => {
      const card = cardById(id);
      if (!card) return;
      const el = makeCard(card);
      el.dataset.id = id;
      el.tabIndex = 0;
      if (S.selected.has(id)) el.classList.add('selected');
      if (S.freshId === id) el.classList.add('fresh');
      el.addEventListener('pointerdown', e => cardPointerDown(e, id, el));
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelect(id); }
        else if (e.key === 'Delete' && canDiscard()) socket.emit('card:discard', { cardId: id });
      });
      el.addEventListener('contextmenu', e => e.preventDefault());
      strip.appendChild(el);
    });

    const [label, cls] = groupInfo(ids);
    const badge = document.createElement('span');
    badge.className = `group-badge ${cls}`;
    badge.textContent = label;
    col.append(strip, badge);
    wrap.appendChild(col);
  });

  const zone = document.createElement('div');
  zone.className = 'new-group-zone';
  zone.dataset.zone = 'new';
  zone.textContent = 'Drop here for a new group';
  wrap.appendChild(zone);
  updateControls();
}

function toggleSelect(id) {
  S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
  renderHand();
}

// Pointer-based drag & drop (works with mouse and touch) plus real double-tap to discard.
// Touch: press and hold briefly to pick a card up; a quick swipe still scrolls the hand.
let drag = null, lastTap = { id: null, t: 0 };
const HOLD_MS = 170, MOVE_PX = 6, DOUBLE_TAP_MS = 320;

function cardPointerDown(e, id, el) {
  if (e.button > 0 || drag) return;
  drag = { id, el, x0: e.clientX, y0: e.clientY, active: false, touch: e.pointerType !== 'mouse', ghost: null, ids: null, target: null };
  if (drag.touch) {
    drag.timer = setTimeout(() => { if (drag && !drag.active) beginDrag(); }, HOLD_MS);
  }
}

function beginDrag() {
  const d = drag;
  d.active = true;
  d.ids = S.selected.has(d.id) ? S.layout.flat().filter(i => S.selected.has(i)) : [d.id];
  const ghost = d.el.cloneNode(true);
  ghost.className = d.el.className.replace(/selected|fresh/g, '') + ' drag-ghost';
  if (d.ids.length > 1) ghost.insertAdjacentHTML('beforeend', `<span class="ghost-count">${d.ids.length}</span>`);
  document.body.appendChild(ghost);
  d.ghost = ghost;
  document.body.classList.add('is-dragging');
  document.querySelectorAll('#melds-wrapper .card').forEach(c => { if (d.ids.includes(c.dataset.id)) c.classList.add('dragging'); });
  if (navigator.vibrate) navigator.vibrate(12);
}

function dropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const card = el.closest('#melds-wrapper .card');
  const col = el.closest('.meld-column');
  if (el.closest('.new-group-zone')) return { type: 'new' };
  if (col) return { type: 'group', col, beforeId: card ? card.dataset.id : null };
  if (el.closest('#melds-wrapper')) return { type: 'new' };   // blank space in the hand = new group
  return null;
}

document.addEventListener('pointermove', e => {
  if (!drag) return;
  const dist = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
  if (!drag.active) {
    if (!drag.touch && dist > MOVE_PX) beginDrag();
    else if (drag.touch && dist > 10) { clearTimeout(drag.timer); drag = null; return; } // user is scrolling
    else return;
  }
  drag.ghost.style.transform = `translate(${e.clientX - 29}px, ${e.clientY - 42}px) rotate(4deg)`;
  const t = dropTargetAt(e.clientX, e.clientY);
  document.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
  if (t) (t.type === 'group' ? t.col : document.querySelector('.new-group-zone')).classList.add('drop-target');
  drag.target = t;
});

document.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag;
  clearTimeout(d.timer);
  drag = null;
  if (d.active) {
    d.ghost.remove();
    document.body.classList.remove('is-dragging');
    const t = dropTargetAt(e.clientX, e.clientY);
    if (t && t.type === 'group') moveCards(d.ids, S.layout[+t.col.dataset.group], t.beforeId);
    else if (t && t.type === 'new') moveCards(d.ids, 'new');
    else renderHand();
    return;
  }
  // a tap: second tap on the same card within the window discards it
  const now = Date.now();
  if (lastTap.id === d.id && now - lastTap.t < DOUBLE_TAP_MS && canDiscard()) {
    lastTap = { id: null, t: 0 };
    S.selected.clear();
    socket.emit('card:discard', { cardId: d.id });
    return;
  }
  lastTap = { id: d.id, t: now };
  toggleSelect(d.id);
});

function cancelDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  if (drag.ghost) drag.ghost.remove();
  document.body.classList.remove('is-dragging');
  drag = null;
  renderHand();
}
document.addEventListener('pointercancel', cancelDrag);
// once a touch drag has started, stop the page from scrolling under the finger
document.addEventListener('touchmove', e => { if (drag && drag.active && e.cancelable) e.preventDefault(); }, { passive: false });

// ---------- controls & messages ----------
const canDiscard = () => isMyTurn() && S.phase === 'DISCARD';

function updateControls() {
  const sel = S.selected.size;
  const inGroup = [...S.selected].some(id => (S.layout.find(g => g.includes(id)) || []).length > 1);
  const live = ['PLAYING', 'SHOWING'].includes(S.status) && myStatus() === 'ACTIVE';
  $('btn-group').disabled = !live || sel < 2;
  $('btn-ungroup').disabled = !live || !inGroup;
  $('btn-sort').disabled = !live;
  $('btn-auto-sort').disabled = !live;
  $('btn-discard').disabled = !(canDiscard() && sel === 1);
  $('btn-declare').disabled = !(canDiscard() && sel === 1);
  $('btn-drop').disabled = !(isMyTurn() && S.phase === 'DRAW');
  const lockedHidden = S.jokerMode === 'hidden' && !S.unlocked && S.status === 'PLAYING' && myStatus() === 'ACTIVE';
  $('btn-reveal-joker').classList.toggle('hidden', !(lockedHidden && S.layout.some(g => groupInfo(g)[1] === 'badge-pure')));
  $('closed-pile').classList.toggle('can-draw', isMyTurn() && S.phase === 'DRAW');
  $('open-pile').classList.toggle('can-draw', isMyTurn() && S.phase === 'DRAW' && !!(S.table && S.table.openTop));
  updateMessage();
}

function updateMessage() {
  const el = $('turn-message');
  const t = S.table;
  let msg = '', mine = false;
  const nameOf = k => (t && t.players.find(p => p.key === k) || {}).name || 'Someone';
  if (S.status === 'PLAYING') {
    if (t && t.isPaused) msg = 'Game paused by the host';
    else if (t && t.planning) msg = 'Cards dealt: arrange your hand. The first turn starts when the timer ends.';
    else if (t && t.isPaused) msg = 'Game paused by the host';
    else if (myStatus() === 'SPECTATOR') msg = "You'll join the next round";
    else if (myStatus() !== 'ACTIVE') msg = 'You are out of this round';
    else if (S.activeKey === S.key) {
      mine = true;
      msg = S.phase === 'DRAW' ? 'Your turn: draw from the closed or open pile' : 'Select one card, then Discard it or Finish with it';
    } else msg = `${nameOf(S.activeKey)} is playing…`;
  } else if (S.status === 'SHOWING') msg = 'Round finished: players are confirming their cards';
  else if (S.status === 'ENDED') msg = 'Round over: tap Ready for the next round';
  el.textContent = msg;
  el.classList.toggle('mine', mine);
  $('game-status-display').textContent = t ? `Round ${t.roundNo}` : '';
}

function startTimer(seconds) {
  clearInterval(timerHandle);
  const bar = $('timer-bar'), txt = $('turn-timer-display');
  const total = seconds, end = Date.now() + seconds * 1000;
  const tick = () => {
    const left = Math.max(0, (end - Date.now()) / 1000);
    txt.textContent = Math.ceil(left) + 's';
    bar.style.width = (left / total * 100) + '%';
    bar.classList.toggle('low', left <= 5);
    if (left <= 0) clearInterval(timerHandle);
  };
  tick();
  timerHandle = setInterval(tick, 250);
}
function stopTimer(text = '--') {
  clearInterval(timerHandle);
  $('turn-timer-display').textContent = text;
  $('timer-bar').style.width = '0';
}

// ---------- table ----------
function renderTable(t) {
  S.table = t;
  S.status = t.status;
  S.activeKey = t.activeKey;
  $('closed-count').textContent = t.closedCount;
  const open = $('top-open-card');
  open.replaceWith(Object.assign(makeCard(t.openTop), { id: 'top-open-card' }));
  $('btn-pause-toggle').classList.toggle('hidden', !(S.isHost && t.status === 'PLAYING'));
  showPauseBanner(t.status === 'PLAYING' && t.isPaused);
  closeMenu();
  $('btn-pause-toggle').textContent = t.isPaused ? 'Resume' : 'Pause';

  const seats = $('seats');
  seats.innerHTML = '';
  t.players.filter(p => p.status !== 'SPECTATOR').forEach(p => {
    const d = document.createElement('div');
    d.className = 'seat' + (p.key === t.activeKey ? ' turn' : '') + (p.key === S.key ? ' me' : '') + (p.status === 'DROPPED' || p.status === 'OUT' ? ' gone' : '');
    const n = document.createElement('div'); n.className = 'seat-name'; n.textContent = p.name;
    const m = document.createElement('div'); m.className = 'seat-meta';
    const tags = [];
    if (p.status === 'DROPPED') tags.push('Dropped');
    else if (p.status === 'OUT') tags.push('Out');
    else tags.push(`${p.cards} cards`);
    if (p.isOffline) tags.push('offline');
    tags.push(`${p.totalPoints} pts`);
    m.textContent = tags.join(' · ');
    d.append(n, m);
    seats.appendChild(d);
  });
  renderCutJoker();
  updateControls();
}

function showPauseBanner(paused) {
  $('pause-banner').classList.toggle('hidden', !paused);
  $('btn-resume-banner').classList.toggle('hidden', !S.isHost);
}

function renderCutJoker() {
  const slot = $('cut-joker-card');
  const label = $('joker-label');
  if (S.cutJoker) {
    const el = makeCard(S.cutJoker);
    el.id = 'cut-joker-card';
    slot.replaceWith(el);
    label.textContent = 'Wild joker';
  } else {
    const el = document.createElement('div');
    el.id = 'cut-joker-card'; el.className = 'card card-back'; el.innerHTML = '<span>?</span>';
    slot.replaceWith(el);
    label.textContent = 'Wild joker (hidden)';
  }
}

// ---------- lobby ----------
function saveName(n) { localStorage.setItem('rummy_player_name', n); }

function enterRoom(res, nameShown) {
  S.roomId = res.roomId; S.isHost = res.isHost;
  sessionStorage.setItem('rummy_room', res.roomId);
  $('lobby-forms').classList.add('hidden');
  $('room-waiting-area').classList.remove('hidden');
  $('display-created-code').textContent = res.roomId;
  $('game-room-id').textContent = res.roomId;
  if (res.name) { $('input-player-name').value = res.name; saveName(res.name); }
  const url = `${location.origin}${location.pathname}?room=${res.roomId}`;
  $('invite-link-input').value = url;
  const qr = $('qrcode-container');
  qr.innerHTML = '';
  if (typeof QRCode !== 'undefined') new QRCode(qr, { text: url, width: 128, height: 128, correctLevel: QRCode.CorrectLevel.M });
  else qr.classList.add('hidden');
  updateHostUI();
}

function updateHostUI() {
  $('btn-start-game').classList.toggle('hidden', !S.isHost);
  $('waiting-host-msg').classList.toggle('hidden', S.isHost);
}

function leaveToLobby() {
  socket.emit('room:leave');
  sessionStorage.removeItem('rummy_room');
  location.href = location.origin + location.pathname;
}

function readName() {
  const name = $('input-player-name').value.trim();
  if (!name) { toast('Enter your name first.', true); $('input-player-name').focus(); return null; }
  saveName(name); S.name = name;
  return name;
}

$('btn-create-room').addEventListener('click', () => {
  const name = readName(); if (!name) return;
  socket.emit('room:create', {
    playerName: name, playerKey: S.key,
    config: {
      maxPlayers: +$('select-max-players').value, jokerMode: $('select-joker-mode').value,
      printedJokersPerDeck: +$('select-printed-jokers').value, turnSeconds: +$('select-turn-seconds').value, requireFourCardSeq: $('chk-four-card').checked,
      secondaryRankMetric: $('select-rank-metric').value,
    },
  }, res => res.ok ? enterRoom(res) : toast(res.error, true));
});

$('btn-join-room').addEventListener('click', () => {
  const name = readName(); if (!name) return;
  const code = $('input-join-code').value.trim().toUpperCase();
  if (code.length < 3) { toast('Enter the 4-letter room code.', true); return; }
  socket.emit('room:join', { roomId: code, playerName: name, playerKey: S.key },
    res => res.ok ? enterRoom(res) : toast(res.error, true));
});

$('btn-copy-link').addEventListener('click', () => {
  const v = $('invite-link-input').value;
  (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(
    () => toast('Invite link copied.'), () => { $('invite-link-input').select(); toast('Press Ctrl+C to copy the link.'); });
});
$('btn-start-game').addEventListener('click', () => socket.emit('game:trigger_start'));
$('btn-leave-room').addEventListener('click', leaveToLobby);
$('btn-exit-lobby').addEventListener('click', () => {
  if (confirm("Leave this game? You'll be dropped from the current round.")) leaveToLobby();
});

window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('rummy_player_name');
  if (saved) $('input-player-name').value = saved;
  const room = new URLSearchParams(location.search).get('room');
  if (room) { $('input-join-code').value = room.toUpperCase().slice(0, 4); (saved ? $('input-join-code') : $('input-player-name')).focus(); }
});

// ---------- socket events ----------
socket.on('connect', () => {
  // Reconnect (or page refresh): rejoin the same seat with our stable key
  const saved = localStorage.getItem('rummy_player_name');
  if (S.roomId && saved) {
    socket.emit('room:join', { roomId: S.roomId, playerName: saved, playerKey: S.key }, res => {
      if (res.ok) enterRoom(res);
      else { sessionStorage.removeItem('rummy_room'); S.roomId = null; show('lobby'); toast(res.error, true); }
    });
  }
});
socket.on('disconnect', () => toast('Connection lost. Reconnecting…', true, 5000));
socket.on('error', e => toast(e.message, true));

socket.on('room:state_sync', st => {
  S.config = st.config;
  S.isHost = st.hostKey === S.key;
  updateHostUI();
  $('connected-count').textContent = st.players.length;
  $('max-count').textContent = st.config.maxPlayers;
  const list = $('roster-list');
  list.innerHTML = '';
  st.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name;
    if (p.isHost) li.classList.add('host');
    if (p.isOffline) li.classList.add('offline');
    list.appendChild(li);
  });
  const c = st.config;
  $('room-config-line').textContent = `${c.jokerMode === 'open' ? 'Open' : 'Hidden'} wild joker · ${c.turnSeconds}s turns · ${c.printedJokersPerDeck} printed jokers per pack${c.requireFourCardSeq ? ' · 4-card sequence required' : ''}`;
});

function resetForRound() {
  S.layout = []; S.selected.clear(); S.showSubmitted = false; S.lastResult = null; S.phase = 'WAIT';
  clearInterval(showHandle); clearInterval(S.nextTick);
  $('show-banner').classList.add('hidden');
  $('leaderboard-modal').classList.add('hidden');
  $('rejoin-modal').classList.add('hidden');
}

socket.on('round:start_hands', d => {
  resetForRound();
  S.jokerMode = d.jokerMode;
  S.cutJoker = d.cutJoker;
  S.unlocked = d.jokerMode === 'open';
  syncLayout(d.hand);
  S.status = 'PLAYING';
  show('game');
  renderCutJoker();
  renderHand();
});

socket.on('game:sync', d => {
  S.status = d.status; S.isHost = d.isHost; S.jokerMode = d.jokerMode;
  S.cutJoker = d.cutJoker; S.unlocked = d.unlocked; S.phase = d.phase; S.mySync = d.myStatus;
  if (d.inRound || d.status === 'ENDED' || d.status === 'SHOWING') {
    show('game');
    $('game-room-id').textContent = S.roomId;
    if (d.hand.length) syncLayout(d.hand);
    renderCutJoker(); renderHand();
    if (d.turn) { S.activeKey = d.turn.activeKey; startTimer(Math.max(1, d.turn.secondsLeft)); }
    if (d.planning) startTimer(Math.max(1, d.planning.secondsLeft));
    if (d.paused) stopTimer('Paused');
    if (d.showing) beginShow(d.showing.winnerName, d.showing.secondsLeft, d.showing.submitted);
    if (d.lastResult) showResult(d.lastResult, d.nextRound);
  } else show('lobby');
});

socket.on('table:state', t => {
  const wasLobby = !$('main-lobby-screen').classList.contains('hidden');
  if (wasLobby && ['PLAYING', 'SHOWING'].includes(t.status) && t.players.some(p => p.key === S.key)) show('game');
  renderTable(t);
});

socket.on('round:planning', ({ seconds, resumed }) => { stopTimer(); startTimer(seconds); if (!resumed) toast('Cards dealt. Use the time to arrange your hand.'); });

socket.on('turn:start', ({ activeKey, durationSeconds, isReduced, resumed }) => {
  S.activeKey = activeKey;
  if (!resumed) S.phase = activeKey === S.key ? 'DRAW' : 'WAIT';
  startTimer(durationSeconds);
  if (activeKey === S.key && !resumed) {
    const flash = $('turn-border-flash');
    flash.classList.remove('hidden');
    setTimeout(() => flash.classList.add('hidden'), 3000);
    if (isReduced) $('rejoin-modal').classList.remove('hidden');
  }
  updateControls();
});

socket.on('player:hand_update', ({ hand, phase, drawnId }) => {
  S.phase = phase;
  syncLayout(hand, drawnId);
  renderHand();
});

socket.on('hand:sorted', ({ groups }) => {
  S.layout = groups.filter(g => g.every(id => cardById(id)));
  S.selected.clear();
  renderHand();
});

socket.on('joker:revealed_private', ({ cutJoker }) => {
  S.cutJoker = cutJoker; S.unlocked = true;
  renderCutJoker(); renderHand();
  toast('Wild joker unlocked. It can now complete your melds.');
});
socket.on('joker:revealed_global', ({ cutJoker }) => {
  S.cutJoker = cutJoker; S.unlocked = true;
  renderCutJoker(); renderHand();
});
socket.on('joker:sequence_broadcast', ({ playerName, sequence, durationSeconds }) => {
  $('broadcast-player-name').textContent = playerName;
  const strip = $('broadcast-cards');
  strip.innerHTML = '';
  sequence.forEach(c => strip.appendChild(makeCard(c, { mini: true })));
  const b = $('sequence-broadcast-banner');
  b.classList.remove('hidden');
  setTimeout(() => b.classList.add('hidden'), durationSeconds * 1000);
});

socket.on('player:dropped', ({ name, penalty, auto }) => toast(`${name} ${auto ? 'was dropped for inactivity' : 'dropped'} (+${penalty} points)`));
socket.on('player:knocked_out', ({ name }) => toast(`${name} made a wrong declaration and is out (+80 points)`, true));
socket.on('declaration:result', () => toast('Wrong declaration: 80 points, and you are out of this round.', true, 5000));
socket.on('game:pause_state', ({ isPaused }) => {
  if (isPaused) stopTimer('Paused');
  showPauseBanner(isPaused);
  toast(isPaused ? 'Host paused the game.' : 'Game resumed.');
});
socket.on('player:resumed', () => {});

// show phase: everyone else arranges their cards after someone finishes
function beginShow(winnerName, seconds, submitted) {
  S.status = 'SHOWING';
  stopTimer('--');
  $('turn-border-flash').classList.add('hidden');
  const iAmWinner = S.table && S.table.players.some(p => p.key === S.key) && winnerName === (me() || {}).name;
  S.showSubmitted = submitted || iAmWinner;
  if (iAmWinner) { toast('You finished! Waiting for the others to show their cards.'); return; }
  if (myStatus() !== 'ACTIVE' || S.showSubmitted) return;
  $('show-winner').textContent = winnerName;
  $('show-banner').classList.remove('hidden');
  const end = Date.now() + seconds * 1000;
  clearInterval(showHandle);
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    $('show-seconds').textContent = left;
    if (left <= 0) { clearInterval(showHandle); confirmShow(); }
  };
  tick();
  showHandle = setInterval(tick, 500);
}
function confirmShow() {
  if (S.showSubmitted) return;
  S.showSubmitted = true;
  clearInterval(showHandle);
  $('show-banner').classList.add('hidden');
  socket.emit('round:submit_show', { groups: S.layout });
  toast('Your cards are confirmed.');
}
socket.on('round:show_started', ({ winnerName, seconds }) => beginShow(winnerName, seconds, false));
$('btn-confirm-show').addEventListener('click', confirmShow);

// ---------- results ----------
function rankNote(r) {
  if (r.rankedBy === 'averagePoints') return 'Players joined or left, so ranking uses average points.';
  if (r.rankedBy === 'gamesPerWin') return 'Players joined or left, so ranking uses games per win.';
  return 'Ranked by total points. Lowest wins.';
}

function renderLeaderboardRows(rows) {
  const body = $('leaderboard-body');
  body.innerHTML = '';
  rows.forEach((p, i) => {
    const tr = document.createElement('tr');
    if (p.key === S.key) tr.className = 'me';
    [i + 1, p.name, p.totalPoints, p.averagePoints ?? '–', p.gamesPlayed ?? '–', p.gamesWon ?? '–', p.gamesPerWin ?? '–']
      .forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
    body.appendChild(tr);
  });
}

function showResult(r, next) {
  S.lastResult = r;
  const secs = next ? next.secondsLeft : (r.nextRoundSeconds || 60);
  S.nextEnd = Date.now() + secs * 1000;
  S.iAmReady = !!(next && next.ready.includes(S.key));
  if (next) S.readyInfo = { ready: next.ready, total: next.total };
  S.status = 'ENDED';
  S.cutJoker = r.cutJoker; S.unlocked = true;
  clearInterval(showHandle);
  $('show-banner').classList.add('hidden');
  startTimer(Math.max(1, secs));
  $('result-title').textContent = r.winnerName ? `${r.winnerName} wins the round` : 'Round over';
  const box = $('round-results');
  box.classList.remove('hidden');
  box.innerHTML = '';
  r.results.slice().sort((a, b) => a.roundScore - b.roundScore).forEach(p => {
    const row = document.createElement('div');
    row.className = 'result-row' + (p.status === 'WINNER' ? ' win' : '');
    const head = document.createElement('div');
    head.className = 'result-head';
    const nm = document.createElement('div'); nm.textContent = p.name;
    const sc = document.createElement('span');
    const note = { WINNER: 'Finished', DROPPED: 'Dropped', OUT: 'Wrong declaration', ACTIVE: '' }[p.status] || '';
    sc.textContent = `${note ? note + ' · ' : ''}${p.roundScore} pts`;
    head.append(nm, sc);
    row.appendChild(head);
    if (p.groups) {
      const gs = document.createElement('div'); gs.className = 'result-groups';
      p.groups.forEach(g => {
        const gd = document.createElement('div'); gd.className = 'result-group';
        g.forEach(c => gd.appendChild(makeCard(c, { mini: true })));
        gs.appendChild(gd);
      });
      row.appendChild(gs);
    }
    box.appendChild(row);
  });
  renderLeaderboardRows(r.leaderboard);
  $('rank-note').textContent = rankNote(r);
  $('btn-next-round').classList.remove('hidden');
  $('next-round-wait').classList.remove('hidden');
  updateReadyUI();
  clearInterval(S.nextTick);
  S.nextTick = setInterval(updateReadyUI, 500);
  $('leaderboard-modal').classList.remove('hidden');
  renderCutJoker(); renderHand();
}
socket.on('round:ended', r => { S.iAmReady = false; S.readyInfo = { ready: [], total: (S.table ? S.table.players.length : 0) }; showResult(r); });
socket.on('round:ready_state', info => { S.readyInfo = info; S.iAmReady = info.ready.includes(S.key); updateReadyUI(); });

function updateReadyUI() {
  const left = Math.max(0, Math.ceil(((S.nextEnd || 0) - Date.now()) / 1000));
  const info = S.readyInfo || { ready: [], total: 0 };
  $('next-round-wait').textContent = `Next round starts in ${left}s, or as soon as everyone is ready · ${info.ready.length}/${info.total} ready`;
  const btn = $('btn-next-round');
  btn.disabled = !!S.iAmReady;
  btn.textContent = S.iAmReady ? 'Ready ✓ waiting for others' : 'Ready for next round';
}

$('btn-next-round').addEventListener('click', () => { S.iAmReady = true; updateReadyUI(); socket.emit('game:ready'); });
$('btn-leaderboard-toggle').addEventListener('click', () => {
  if (S.lastResult) { showResult(S.lastResult); return; }
  $('round-results').classList.add('hidden');
  $('result-title').textContent = 'Points table';
  const rows = S.table ? S.table.players.map(p => ({ key: p.key, name: p.name, totalPoints: p.totalPoints })) : [];
  rows.sort((a, b) => a.totalPoints - b.totalPoints);
  renderLeaderboardRows(rows);
  $('rank-note').textContent = 'Totals so far this session.';
  $('btn-next-round').classList.add('hidden');
  $('next-round-wait').classList.add('hidden');
  $('leaderboard-modal').classList.toggle('hidden');
});
$('btn-close-leaderboard').addEventListener('click', () => $('leaderboard-modal').classList.add('hidden'));

// ---------- play actions ----------
$('closed-pile').addEventListener('click', () => { if (isMyTurn() && S.phase === 'DRAW') socket.emit('card:draw', { source: 'closed' }); });
$('open-pile').addEventListener('click', () => { if (isMyTurn() && S.phase === 'DRAW') socket.emit('card:draw', { source: 'open' }); });

$('btn-group').addEventListener('click', () => {
  const ids = S.layout.flat().filter(id => S.selected.has(id));
  if (ids.length >= 2) moveCards(ids, 'new');
});
$('btn-ungroup').addEventListener('click', () => {
  const ids = S.layout.flat().filter(id => S.selected.has(id));
  S.layout = S.layout.map(g => g.filter(id => !S.selected.has(id))).filter(g => g.length);
  ids.forEach(id => S.layout.push([id]));
  S.selected.clear();
  renderHand();
});
$('btn-sort').addEventListener('click', () => { S.layout = suitGroups(S.hand); S.selected.clear(); renderHand(); });
$('btn-auto-sort').addEventListener('click', () => socket.emit('hand:auto_sort'));
$('btn-discard').addEventListener('click', () => {
  if (canDiscard() && S.selected.size === 1) socket.emit('card:discard', { cardId: [...S.selected][0] });
});
$('btn-drop').addEventListener('click', () => {
  if (confirm('Drop out of this round? It costs 20 points before your first turn and 40 points after.')) socket.emit('round:drop');
});
$('btn-reveal-joker').addEventListener('click', () => {
  const pure = S.layout.find(g => groupInfo(g)[1] === 'badge-pure');
  if (pure) socket.emit('joker:reveal_req', { cardIds: pure });
});

$('btn-declare').addEventListener('click', () => {
  if (!(canDiscard() && S.selected.size === 1)) return;
  const finishCardId = [...S.selected][0];
  const groups = S.layout.map(g => g.filter(id => id !== finishCardId)).filter(g => g.length);
  const cards = groups.map(g => g.map(cardById));
  const types = cards.map(g => R.classifyGroup(g, S.cutJoker, true));
  const pure = types.filter(t => t === 'Pure Sequence').length;
  const seq = types.filter(t => t.endsWith('Sequence')).length;
  const four = cards.some((g, i) => types[i].endsWith('Sequence') && g.length >= 4);
  const needFour = !S.config || S.config.requireFourCardSeq;
  const valid = !types.includes('Invalid') && pure >= 1 && seq >= 2 && (!needFour || four);
  const canJudge = S.unlocked || S.jokerMode === 'open';
  if (canJudge && !valid && !confirm('Your groups are not a valid declaration. A wrong declaration scores 80 points and puts you out of the round. Declare anyway?')) return;
  socket.emit('round:declare', { groups, finishCardId });
});

$('btn-pause-toggle').addEventListener('click', () => socket.emit('game:toggle_pause'));
$('btn-resume-banner').addEventListener('click', () => socket.emit('game:toggle_pause'));

// ---------- menu & full screen ----------
function closeMenu() { $('menu-panel').classList.add('hidden'); $('btn-menu').setAttribute('aria-expanded', 'false'); }
$('btn-menu').addEventListener('click', e => {
  e.stopPropagation();
  const open = $('menu-panel').classList.toggle('hidden') === false;
  $('btn-menu').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) closeMenu(); });

const fsRoot = document.documentElement;
const fsRequest = fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen;
const fsExit = document.exitFullscreen || document.webkitExitFullscreen;
const inFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
// Installed to the Home Screen: already full screen, nothing more to do
const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches;
// iPhone/iPod Safari (and every iOS browser) cannot fullscreen web pages; iPad can
const isIPhone = () => /iPhone|iPod/.test(navigator.userAgent);

async function toggleFullscreen() {
  closeMenu();
  if (!fsRequest) {
    // No Fullscreen API (iPhone): explain the Home Screen route instead of failing silently
    if (isIPhone()) $('ios-guide-modal').classList.remove('hidden');
    else toast('This browser does not allow full screen. Try Chrome, Edge or Firefox.', true, 6000);
    return;
  }
  try {
    if (inFullscreen()) await fsExit.call(document);
    else {
      await fsRequest.call(fsRoot);
      try { await screen.orientation.lock('landscape'); } catch (_) { /* not supported: fine */ }
    }
  } catch (_) {
    toast(isIPhone() ? 'Full screen is not available here.' : 'The browser blocked full screen. Tap the button again.', true);
  }
}
function syncFullscreenLabels() {
  const label = inFullscreen() ? 'Exit full screen' : (!fsRequest && isIPhone() ? 'Full screen…' : 'Full screen');
  $('btn-fullscreen').textContent = label;
  $('btn-fullscreen-lobby').textContent = label;
}
if (isStandalone()) {            // running as an installed app: hide the button, it's already full screen
  $('btn-fullscreen').classList.add('hidden');
  $('btn-fullscreen-lobby').classList.add('hidden');
}
syncFullscreenLabels();
$('btn-close-ios-guide').addEventListener('click', () => $('ios-guide-modal').classList.add('hidden'));
$('btn-fullscreen').addEventListener('click', toggleFullscreen);
$('btn-fullscreen-lobby').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFullscreenLabels);
document.addEventListener('webkitfullscreenchange', syncFullscreenLabels);
$('btn-rejoin-active').addEventListener('click', () => {
  socket.emit('player:resume_active');
  $('rejoin-modal').classList.add('hidden');
});
})();
