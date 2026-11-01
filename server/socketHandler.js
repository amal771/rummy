const Deck = require('./models/Deck');
const { bestArrangement } = require('./logic/autoSorter');
const { validateDeclaration, calculateHandPoints } = require('./logic/scoring');
const { isValidPureSequence } = require('./logic/validator');

const rooms = new Map(); // roomId -> room

const TURN_SECONDS = 45;
const REDUCED_SECONDS = 10;
const OFFLINE_SECONDS = 3;
const MAX_MISSED_TURNS = 3;   // auto-drop after this many missed turns in a row
const PLANNING_SECONDS = Number(process.env.RUMMY_PLANNING) || 20;    // arrange cards after the deal, before turn 1
const NEXT_ROUND_SECONDS = Number(process.env.RUMMY_NEXT) || 60;      // auto-start of the next round
const SHOW_SECONDS = Number(process.env.RUMMY_SHOW) || 45;
const MAX_PLAYERS = 20;
const FIRST_DROP = 20;
const MIDDLE_DROP = 40;
const MAX_POINTS = 80;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const cleanName = s => String(s || '').replace(/[<>&"']/g, '').trim().slice(0, 15);
const cleanKey = s => String(s || '').replace(/[^\w-]/g, '').slice(0, 64);

function registerSocketHandlers(io) {

  // ---------- helpers ----------
  const ctx = (socket) => {
    const room = rooms.get(socket.data.roomId);
    const player = room && room.players.get(socket.data.key);
    return player && player.sid === socket.id ? { room, player } : {};
  };
  const toPlayer = (p, ev, data) => { if (p.sid) io.to(p.sid).emit(ev, data); };
  const toRoom = (room, ev, data) => io.to(room.roomId).emit(ev, data);
  const active = room => [...room.players.values()].filter(p => p.status === 'ACTIVE');
  const activePlayer = room => room.players.get(room.turnOrder[room.activeTurnIndex]);
  const canUseJoker = (room, p) => room.config.jokerMode === 'open' || p.hasSeenHiddenJoker;
  const inTurn = (room, p) => room.status === 'PLAYING' && !room.planning && !room.isPaused && activePlayer(room) === p;

  function generateCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
      if (!rooms.has(code)) return code;
    }
  }

  function newPlayer(room, key, name) {
    let finalName = name, n = 2;
    const taken = () => [...room.players.values()].some(p => p.name.toLowerCase() === finalName.toLowerCase());
    while (taken()) finalName = `${name.slice(0, 12)} ${n++}`;
    return {
      key, sid: null, name: finalName, hand: [],
      status: 'SPECTATOR',          // SPECTATOR | ACTIVE | DROPPED | OUT
      phase: 'WAIT',                // WAIT | DRAW | DISCARD
      turnsPlayed: 0, lastDrawnId: null, hasSeenHiddenJoker: false,
      missed: 0, isOffline: false, roundScore: 0, showGroups: null,
      stats: { totalPoints: 0, gamesPlayed: 0, gamesWon: 0 },
    };
  }

  function attach(socket, room, player) {
    socket.join(room.roomId);
    socket.data.roomId = room.roomId;
    socket.data.key = player.key;
    player.sid = socket.id;
    player.isOffline = false;
    clearTimeout(room.cleanupTimer);
    if (player.key === room.hostKey) clearTimeout(room.hostTimer);
  }

  function publicPlayers(room) {
    const order = room.turnOrder.length ? room.turnOrder : [...room.players.keys()];
    const extra = [...room.players.keys()].filter(k => !order.includes(k));
    return [...order, ...extra].map(k => room.players.get(k)).filter(Boolean).map(p => ({
      key: p.key, name: p.name, status: p.status, isOffline: p.isOffline,
      cards: p.hand.length, totalPoints: p.stats.totalPoints, isHost: p.key === room.hostKey,
    }));
  }

  function broadcastRoomState(room) {
    toRoom(room, 'room:state_sync', {
      roomId: room.roomId, status: room.status, hostKey: room.hostKey,
      config: room.config, players: publicPlayers(room),
    });
  }

  function broadcastTable(room) {
    const act = room.status === 'PLAYING' && !room.planning ? activePlayer(room) : null;
    toRoom(room, 'table:state', {
      status: room.status, roundNo: room.roundNo, isPaused: room.isPaused, planning: room.planning,
      activeKey: act ? act.key : null,
      openTop: room.openPile[room.openPile.length - 1] || null,
      closedCount: room.closedPile.length,
      players: publicPlayers(room),
    });
  }

  // Full state for a (re)connecting player
  function sendSync(room, p) {
    const dealt = p.status !== 'SPECTATOR';
    toPlayer(p, 'game:sync', {
      status: room.status, paused: room.isPaused, myStatus: p.status, isHost: p.key === room.hostKey, jokerMode: room.config.jokerMode,
      inRound: dealt && ['PLAYING', 'SHOWING'].includes(room.status),
      hand: dealt ? p.hand : [], phase: p.phase,
      cutJoker: room.cutJoker && (canUseJoker(room, p) || room.status === 'ENDED') ? room.cutJoker : null,
      unlocked: canUseJoker(room, p),
      showing: room.status === 'SHOWING'
        ? { winnerName: room.players.get(room.winnerKey).name, secondsLeft: Math.max(0, Math.round((room.showEndsAt - Date.now()) / 1000)), submitted: !!p.showGroups || room.winnerKey === p.key }
        : null,
      planning: room.planning ? { secondsLeft: Math.max(0, Math.round(((room.isPaused ? room.pausedRemaining : room.planningEndsAt - Date.now())) / 1000)) } : null,
      nextRound: room.status === 'ENDED' ? { secondsLeft: Math.max(0, Math.round((room.nextEndsAt - Date.now()) / 1000)), ...readyInfo(room) } : null,
      turn: room.status === 'PLAYING' && !room.planning && activePlayer(room)
        ? { activeKey: activePlayer(room).key, secondsLeft: Math.max(0, Math.round(((room.isPaused ? room.pausedRemaining : room.turnEndsAt - Date.now())) / 1000)) }
        : null,
      lastResult: room.status === 'ENDED' ? room.lastResult : null,
    });
    broadcastTable(room);
  }

  const resolveGroups = (hand, groups) => {
    if (!Array.isArray(groups)) return null;
    const byId = new Map(hand.map(c => [c.id, c]));
    const seen = new Set(), out = [];
    for (const g of groups) {
      if (!Array.isArray(g)) return null;
      const arr = [];
      for (const id of g) {
        const c = byId.get(id);
        if (!c || seen.has(id)) return null;
        seen.add(id); arr.push(c);
      }
      if (arr.length) out.push(arr);
    }
    return seen.size === hand.length ? out : null;
  };

  // ---------- socket events ----------
  io.on('connection', (socket) => {

    socket.on('room:create', (data = {}, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const name = cleanName(data.playerName), key = cleanKey(data.playerKey);
      if (!name || !key) return cb({ ok: false, error: 'Enter your name first.' });
      leaveRoom(socket, false);

      const c = data.config || {};
      const room = {
        roomId: generateCode(), hostKey: key,
        config: {
          maxPlayers: clamp(parseInt(c.maxPlayers, 10) || MAX_PLAYERS, 2, MAX_PLAYERS),
          jokerMode: c.jokerMode === 'open' ? 'open' : 'hidden',
          printedJokersPerDeck: parseInt(c.printedJokersPerDeck, 10) === 3 ? 3 : 2,
          requireFourCardSeq: c.requireFourCardSeq !== false,
          secondaryRankMetric: c.secondaryRankMetric === 'gamesPerWin' ? 'gamesPerWin' : 'averagePoints',
        },
        status: 'LOBBY', players: new Map(), rosterChanged: false, roundNo: 0,
        closedPile: [], openPile: [], cutJoker: null, turnOrder: [], activeTurnIndex: 0,
        turnTimer: null, turnEndsAt: 0, pausedRemaining: 0, isPaused: false,
        planning: false, pauseTimer: null, planningEndsAt: 0, planningTimer: null, nextTimer: null, nextEndsAt: 0, readyKeys: new Set(),
        showTimer: null, cleanupTimer: null, hostTimer: null,
        winnerKey: null, showEndsAt: 0, lastResult: null,
      };
      rooms.set(room.roomId, room);
      const p = newPlayer(room, key, name);
      room.players.set(key, p);
      attach(socket, room, p);
      broadcastRoomState(room);
      cb({ ok: true, roomId: room.roomId, isHost: true, name: p.name });
    });

    socket.on('room:join', (data = {}, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const roomId = String(data.roomId || '').toUpperCase().trim();
      const name = cleanName(data.playerName), key = cleanKey(data.playerKey);
      const room = rooms.get(roomId);
      if (!room) return cb({ ok: false, error: 'Room not found. Check the code and try again.' });
      if (!name || !key) return cb({ ok: false, error: 'Enter your name first.' });

      let p = room.players.get(key);
      if (!p) {
        if (room.players.size >= room.config.maxPlayers) return cb({ ok: false, error: 'This room is full.' });
        leaveRoom(socket, false);
        p = newPlayer(room, key, name);
        room.players.set(key, p);
        if (room.roundNo > 0) room.rosterChanged = true;
      }
      if (p.sid && p.sid !== socket.id) io.sockets.sockets.get(p.sid)?.disconnect(true); // stale tab
      attach(socket, room, p);
      broadcastRoomState(room);
      cb({ ok: true, roomId, isHost: p.key === room.hostKey, name: p.name });
      sendSync(room, p);
    });

    socket.on('room:leave', () => leaveRoom(socket, true));

    // Host starts the game: cards are dealt straight away, then everyone gets a planning period
    socket.on('game:trigger_start', () => {
      const { room, player } = ctx(socket);
      if (!room || player.key !== room.hostKey || room.status !== 'LOBBY') return;
      if (onlinePlayers(room).length < 2) return socket.emit('error', { message: 'You need at least 2 players to start.' });
      initiateRound(room);
    });

    // Between rounds: the next one starts when everyone is ready, or after NEXT_ROUND_SECONDS
    socket.on('game:ready', () => {
      const { room, player } = ctx(socket);
      if (!room || room.status !== 'ENDED') return;
      room.readyKeys.add(player.key);
      broadcastReady(room);
      checkAllReady(room);
    });

    socket.on('card:draw', ({ source } = {}) => {
      const { room, player } = ctx(socket);
      if (!room || !inTurn(room, player) || player.phase !== 'DRAW') return;
      const card = drawCard(room, player, source === 'open' ? 'open' : 'closed');
      if (!card) return socket.emit('error', { message: 'No cards left to draw.' });
      toPlayer(player, 'player:hand_update', { hand: player.hand, phase: player.phase, drawnId: card.id });
      broadcastTable(room);
    });

    socket.on('card:discard', ({ cardId } = {}) => {
      const { room, player } = ctx(socket);
      if (!room || !inTurn(room, player) || player.phase !== 'DISCARD') return;
      if (!player.hand.some(c => c.id === cardId)) return;
      discard(room, player, cardId);
      advanceTurn(room);
    });

    socket.on('hand:auto_sort', () => {
      const { room, player } = ctx(socket);
      if (!room || player.status !== 'ACTIVE' || !['PLAYING', 'SHOWING'].includes(room.status)) return;
      const { groups } = bestArrangement(player.hand, room.cutJoker, canUseJoker(room, player), room.config.requireFourCardSeq);
      socket.emit('hand:sorted', { groups: groups.map(g => g.map(c => c.id)) });
    });

    socket.on('joker:reveal_req', ({ cardIds } = {}) => {
      const { room, player } = ctx(socket);
      if (!room || room.status !== 'PLAYING' || room.config.jokerMode !== 'hidden') return;
      if (player.status !== 'ACTIVE' || player.hasSeenHiddenJoker || !Array.isArray(cardIds)) return;
      const seq = cardIds.map(id => player.hand.find(c => c.id === id));
      if (seq.some(c => !c) || new Set(cardIds).size !== cardIds.length || !isValidPureSequence(seq)) {
        return socket.emit('error', { message: 'That is not a valid pure sequence in your hand.' });
      }
      player.hasSeenHiddenJoker = true;
      toPlayer(player, 'joker:revealed_private', { cutJoker: room.cutJoker });
      toRoom(room, 'joker:sequence_broadcast', { playerName: player.name, sequence: seq, durationSeconds: 5 });
      if (active(room).every(p => p.hasSeenHiddenJoker)) {
        toRoom(room, 'joker:revealed_global', { cutJoker: room.cutJoker });
      }
    });

    // Finish: discard one card face-down, arrange the remaining 13 into groups.
    socket.on('round:declare', ({ groups, finishCardId } = {}) => {
      const { room, player } = ctx(socket);
      if (!room || !inTurn(room, player) || player.phase !== 'DISCARD') return;
      const idx = player.hand.findIndex(c => c.id === finishCardId);
      if (idx < 0) return socket.emit('error', { message: 'Pick the card you want to finish with.' });
      const rest = player.hand.filter((_, i) => i !== idx);
      const resolved = resolveGroups(rest, groups);
      if (!resolved) return socket.emit('error', { message: 'Your groups are out of sync. Try again.' });

      clearTimeout(room.turnTimer);
      if (validateDeclaration(resolved, room.cutJoker, room.config.requireFourCardSeq, true)) {
        player.hand = rest;
        player.phase = 'WAIT';
        player.showGroups = resolved;
        toPlayer(player, 'player:hand_update', { hand: player.hand, phase: 'WAIT' });
        startShow(room, player);
      } else {
        // Invalid declaration: 80 points and out of this round
        player.status = 'OUT';
        player.phase = 'WAIT';
        player.roundScore = MAX_POINTS;
        player.stats.totalPoints += MAX_POINTS;
        toPlayer(player, 'declaration:result', { success: false, points: MAX_POINTS });
        toRoom(room, 'player:knocked_out', { key: player.key, name: player.name });
        afterPlayerLeavesRound(room, player);
      }
    });

    socket.on('round:submit_show', ({ groups } = {}) => {
      const { room, player } = ctx(socket);
      if (!room || room.status !== 'SHOWING' || player.status !== 'ACTIVE' || player.key === room.winnerKey) return;
      const resolved = resolveGroups(player.hand, groups);
      if (!resolved) return socket.emit('error', { message: 'Your groups are out of sync. Auto-grouping will be used.' });
      player.showGroups = resolved;
      checkShowComplete(room);
    });

    socket.on('round:drop', () => {
      const { room, player } = ctx(socket);
      if (!room || !inTurn(room, player) || player.phase !== 'DRAW') return;
      dropPlayer(room, player, player.turnsPlayed === 0 ? FIRST_DROP : MIDDLE_DROP);
    });

    socket.on('game:toggle_pause', () => {
      const { room, player } = ctx(socket);
      if (!room || player.key !== room.hostKey || room.status !== 'PLAYING') return;
      setPaused(room, !room.isPaused);
    });

    socket.on('player:resume_active', () => {
      const { player } = ctx(socket);
      if (!player) return;
      player.missed = 0;
      socket.emit('player:resumed');
    });

    socket.on('disconnect', () => {
      const { room, player } = ctx(socket);
      if (!room) return;
      player.isOffline = true;
      player.sid = null;

      if (room.hostKey === player.key) {
        // Grace period so a page refresh or brief network drop doesn't cost the host their role
        clearTimeout(room.hostTimer);
        room.hostTimer = setTimeout(() => {
          const host = room.players.get(room.hostKey);
          if (host && host.isOffline) { transferHost(room); broadcastRoomState(room); broadcastTable(room); }
        }, 30000);
      }
      if (room.status === 'PLAYING' && !room.planning && activePlayer(room) === player && !room.isPaused) {
        armTurnTimer(room, OFFLINE_SECONDS); // don't make the table wait for someone who left
      }
      if (room.status === 'SHOWING') checkShowComplete(room);
      if (room.status === 'ENDED') { broadcastReady(room); checkAllReady(room); }
      broadcastRoomState(room);
      broadcastTable(room);
      if (!onlinePlayers(room).length) {
        room.cleanupTimer = setTimeout(() => destroyRoom(room), 10 * 60 * 1000);
      }
    });
  });

  // ---------- room lifecycle ----------
  const onlinePlayers = room => [...room.players.values()].filter(p => !p.isOffline);

  function transferHost(room) {
    const next = onlinePlayers(room).find(p => p.key !== room.hostKey);
    if (next) room.hostKey = next.key;
  }

  function readyInfo(room) {
    const online = onlinePlayers(room);
    return { ready: online.filter(p => room.readyKeys.has(p.key)).map(p => p.key), total: online.length };
  }
  const broadcastReady = room => toRoom(room, 'round:ready_state', readyInfo(room));

  function checkAllReady(room) {
    if (room.status !== 'ENDED') return;
    const i = readyInfo(room);
    if (i.total >= 2 && i.ready.length === i.total) initiateRound(room);
  }

  function scheduleNextRound(room, seconds = NEXT_ROUND_SECONDS) {
    clearTimeout(room.nextTimer);
    room.nextEndsAt = Date.now() + seconds * 1000;
    room.nextTimer = setTimeout(() => {
      if (room.status !== 'ENDED') return;
      if (onlinePlayers(room).length >= 2) return initiateRound(room);
      toRoom(room, 'error', { message: 'Waiting for at least 2 players to deal the next round…' });
      scheduleNextRound(room, 15);
    }, seconds * 1000);
  }

  // Pause freezes whichever clock is running (planning or the current turn).
  // It auto-resumes after 5 minutes so a missing host can never stall the table.
  function setPaused(room, paused) {
    if (room.status !== 'PLAYING' || room.isPaused === paused) return;
    room.isPaused = paused;
    clearTimeout(room.pauseTimer);
    if (paused) {
      if (room.planning) {
        room.pausedRemaining = Math.max(1000, room.planningEndsAt - Date.now());
        clearTimeout(room.planningTimer);
      } else {
        room.pausedRemaining = Math.max(1000, room.turnEndsAt - Date.now());
        clearTimeout(room.turnTimer);
      }
      room.pauseTimer = setTimeout(() => setPaused(room, false), 5 * 60 * 1000);
    } else if (room.planning) {
      room.planningEndsAt = Date.now() + room.pausedRemaining;
      room.planningTimer = setTimeout(() => endPlanning(room), room.pausedRemaining);
      toRoom(room, 'round:planning', { seconds: Math.ceil(room.pausedRemaining / 1000), resumed: true });
    } else {
      armTurnTimer(room, room.pausedRemaining / 1000);
      toRoom(room, 'turn:start', { activeKey: activePlayer(room).key, durationSeconds: Math.ceil(room.pausedRemaining / 1000), isReduced: false, resumed: true });
    }
    toRoom(room, 'game:pause_state', { isPaused: room.isPaused });
    broadcastTable(room);
  }

  function endPlanning(room) {
    if (room.status !== 'PLAYING' || !room.planning) return;
    room.planning = false;
    startPlayerTurn(room);
  }

  function destroyRoom(room) {
    clearTimeout(room.turnTimer); clearTimeout(room.showTimer); clearTimeout(room.planningTimer); clearTimeout(room.nextTimer); clearTimeout(room.pauseTimer);
    clearTimeout(room.cleanupTimer); clearTimeout(room.hostTimer);
    rooms.delete(room.roomId);
  }

  function leaveRoom(socket, explicit) {
    const { room, player } = ctx(socket);
    if (!room) return;
    socket.leave(room.roomId);
    socket.data.roomId = null;
    socket.data.key = null;
    player.sid = null;
    player.isOffline = true;

    if (room.status === 'PLAYING' && player.status === 'ACTIVE') {
      if (activePlayer(room) === player && player.phase === 'DISCARD') {
        // already drew: put the drawn card back on the open pile, then drop
        discardSilently(room, player);
      }
      dropPlayer(room, player, player.turnsPlayed === 0 ? FIRST_DROP : MIDDLE_DROP);
    } else if (room.status === 'SHOWING') {
      checkShowComplete(room);
    }
    if (room.status === 'ENDED') checkAllReady(room);
    if (['LOBBY', 'ENDED'].includes(room.status) || player.status === 'SPECTATOR') {
      room.players.delete(player.key);
      if (room.roundNo > 0) room.rosterChanged = true;
    }
    if (room.hostKey === player.key) transferHost(room);
    if (!room.players.size || (explicit && !onlinePlayers(room).length)) return destroyRoom(room);
    broadcastRoomState(room);
    broadcastTable(room);
  }

  function initiateRound(room) {
    // Players who left between rounds are removed
    for (const [k, p] of room.players) if (p.isOffline) { room.players.delete(k); room.rosterChanged = true; }
    if (room.players.size < 2) {
      room.status = room.roundNo ? 'ENDED' : 'LOBBY';
      broadcastRoomState(room);
      return toRoom(room, 'error', { message: 'Not enough players to start.' });
    }
    if (!room.players.has(room.hostKey)) room.hostKey = [...room.players.keys()][0];

    clearTimeout(room.nextTimer); clearTimeout(room.planningTimer);
    room.readyKeys = new Set();
    room.status = 'PLAYING';
    room.roundNo++;
    room.isPaused = false;
    clearTimeout(room.pauseTimer);
    room.winnerKey = null;
    room.lastResult = null;

    const order = [...room.players.keys()];
    const first = (room.roundNo - 1) % order.length;   // deal / first turn rotates
    room.turnOrder = order.slice(first).concat(order.slice(0, first));
    room.activeTurnIndex = 0;

    const deck = new Deck(order.length, room.config.printedJokersPerDeck);
    room.closedPile = deck.cards;
    // The cut joker must be a normal card, never a printed joker
    const cutIdx = room.closedPile.findIndex(c => !c.isPrintedJoker);
    room.cutJoker = room.closedPile.splice(cutIdx, 1)[0];

    for (const p of room.players.values()) {
      p.hand = room.closedPile.splice(0, 13);
      p.status = 'ACTIVE'; p.phase = 'WAIT'; p.turnsPlayed = 0; p.missed = 0;
      p.lastDrawnId = null; p.roundScore = 0; p.showGroups = null;
      p.hasSeenHiddenJoker = room.config.jokerMode === 'open';
      p.stats.gamesPlayed++;
    }
    room.openPile = [room.closedPile.pop()];

    for (const p of room.players.values()) {
      toPlayer(p, 'round:start_hands', {
        hand: p.hand, jokerMode: room.config.jokerMode,
        cutJoker: room.config.jokerMode === 'open' ? room.cutJoker : null,
        roundNo: room.roundNo,
      });
    }
    broadcastRoomState(room);
    // Planning period: cards are dealt, nobody plays yet, so everyone can arrange their hand
    room.planning = true;
    room.planningEndsAt = Date.now() + PLANNING_SECONDS * 1000;
    toRoom(room, 'round:planning', { seconds: PLANNING_SECONDS });
    broadcastTable(room);
    room.planningTimer = setTimeout(() => endPlanning(room), PLANNING_SECONDS * 1000);
  }

  // ---------- turns ----------
  function armTurnTimer(room, seconds) {
    clearTimeout(room.turnTimer);
    room.turnEndsAt = Date.now() + seconds * 1000;
    room.turnTimer = setTimeout(() => onTurnTimeout(room), seconds * 1000);
  }

  function startPlayerTurn(room) {
    clearTimeout(room.turnTimer);
    let p = activePlayer(room), guard = 0;
    while ((!p || p.status !== 'ACTIVE') && guard++ < room.turnOrder.length) {
      room.activeTurnIndex = (room.activeTurnIndex + 1) % room.turnOrder.length;
      p = activePlayer(room);
    }
    if (!p || p.status !== 'ACTIVE') return concludeRound(room, null);

    p.phase = 'DRAW';
    p.lastDrawnId = null;
    const seconds = p.isOffline ? OFFLINE_SECONDS : p.missed > 0 ? REDUCED_SECONDS : TURN_SECONDS;
    if (room.isPaused) { room.pausedRemaining = seconds * 1000; room.turnEndsAt = Date.now() + seconds * 1000; }
    else armTurnTimer(room, seconds);
    toRoom(room, 'turn:start', { activeKey: p.key, durationSeconds: seconds, isReduced: seconds < TURN_SECONDS });
    broadcastTable(room);
  }

  function advanceTurn(room) {
    clearTimeout(room.turnTimer);
    room.activeTurnIndex = (room.activeTurnIndex + 1) % room.turnOrder.length;
    startPlayerTurn(room);
  }

  function recycleDiscardPile(room) {
    if (room.openPile.length <= 1) return;
    const top = room.openPile.pop();
    room.closedPile = Deck.shuffle(room.openPile);
    room.openPile = [top];
  }

  function drawCard(room, p, source) {
    let card;
    if (source === 'open' && room.openPile.length > 0) card = room.openPile.pop();
    else {
      if (room.closedPile.length === 0) recycleDiscardPile(room);
      card = room.closedPile.pop() || (room.openPile.length > 1 ? room.openPile.pop() : null);
    }
    if (!card) return null;
    p.hand.push(card);
    p.lastDrawnId = card.id;
    p.phase = 'DISCARD';
    return card;
  }

  function discard(room, p, cardId) {
    const i = p.hand.findIndex(c => c.id === cardId);
    room.openPile.push(p.hand.splice(i, 1)[0]);
    p.phase = 'WAIT';
    p.turnsPlayed++;
    p.missed = 0;
    toPlayer(p, 'player:hand_update', { hand: p.hand, phase: 'WAIT' });
    broadcastTable(room);
  }

  function discardSilently(room, p) {
    const id = p.lastDrawnId || p.hand[p.hand.length - 1].id;
    const i = p.hand.findIndex(c => c.id === id);
    if (i >= 0) room.openPile.push(p.hand.splice(i, 1)[0]);
    p.phase = 'WAIT';
  }

  function onTurnTimeout(room) {
    if (room.status !== 'PLAYING' || room.isPaused) return;
    const p = activePlayer(room);
    if (!p) return;
    p.missed++;
    if (p.missed >= MAX_MISSED_TURNS) {
      if (p.phase === 'DISCARD') discardSilently(room, p);
      return dropPlayer(room, p, p.turnsPlayed === 0 ? FIRST_DROP : MIDDLE_DROP, true);
    }
    // Auto play: draw from the closed pile and throw the drawn card back
    if (p.phase === 'DRAW' && !drawCard(room, p, 'closed')) return advanceTurn(room);
    const id = p.lastDrawnId || p.hand[p.hand.length - 1].id;
    const missed = p.missed;
    discard(room, p, id);
    p.missed = missed;   // auto-play must not clear the inactivity streak
    advanceTurn(room);
  }

  function dropPlayer(room, p, penalty, auto = false) {
    if (p.status !== 'ACTIVE') return;
    const wasTurn = room.status === 'PLAYING' && !room.planning && activePlayer(room) === p;
    p.status = 'DROPPED';
    p.phase = 'WAIT';
    p.roundScore = penalty;
    p.stats.totalPoints += penalty;
    toRoom(room, 'player:dropped', { key: p.key, name: p.name, penalty, auto });
    afterPlayerLeavesRound(room, p, wasTurn);
  }

  function afterPlayerLeavesRound(room, p, wasTurn = true) {
    const left = active(room);
    if (left.length <= 1) return concludeRound(room, left[0] ? left[0].key : null);
    if (room.status === 'PLAYING' && wasTurn) advanceTurn(room);
    else broadcastTable(room);
  }

  // ---------- show & scoring ----------
  function startShow(room, winner) {
    room.status = 'SHOWING';
    room.winnerKey = winner.key;
    room.showEndsAt = Date.now() + SHOW_SECONDS * 1000;
    clearTimeout(room.turnTimer);
    toRoom(room, 'round:show_started', { winnerName: winner.name, seconds: SHOW_SECONDS });
    broadcastTable(room);
    room.showTimer = setTimeout(() => concludeRound(room, winner.key), (SHOW_SECONDS + 2) * 1000);
    checkShowComplete(room);
  }

  function checkShowComplete(room) {
    if (room.status !== 'SHOWING') return;
    const waiting = active(room).filter(p => p.key !== room.winnerKey && !p.isOffline && !p.showGroups);
    if (!waiting.length) concludeRound(room, room.winnerKey);
  }

  function concludeRound(room, winnerKey) {
    if (room.status === 'ENDED') return;
    clearTimeout(room.turnTimer); clearTimeout(room.showTimer); clearTimeout(room.planningTimer);
    room.status = 'ENDED';
    room.isPaused = false;
    clearTimeout(room.pauseTimer);
    room.planning = false;

    const results = [];
    for (const p of room.players.values()) {
      if (p.status === 'SPECTATOR') continue;
      let groups = null;
      const isWinner = p.key === winnerKey;
      if (isWinner) {
        p.roundScore = 0;
        p.stats.gamesWon++;
        groups = p.showGroups;
      } else if (p.status === 'ACTIVE') {
        const unlocked = canUseJoker(room, p);
        groups = p.showGroups || bestArrangement(p.hand, room.cutJoker, unlocked, room.config.requireFourCardSeq).groups;
        p.roundScore = calculateHandPoints(groups, room.cutJoker, unlocked, room.config.requireFourCardSeq);
        p.stats.totalPoints += p.roundScore;
      }
      results.push({
        key: p.key, name: p.name, status: isWinner ? 'WINNER' : p.status,
        roundScore: p.roundScore, groups,
      });
    }

    const rows = [...room.players.values()].map(p => {
      const g = p.stats.gamesPlayed;
      return {
        key: p.key, name: p.name, totalPoints: p.stats.totalPoints,
        averagePoints: g ? +(p.stats.totalPoints / g).toFixed(2) : 0,
        gamesPlayed: g, gamesWon: p.stats.gamesWon,
        gamesPerWin: p.stats.gamesWon ? +(g / p.stats.gamesWon).toFixed(2) : 'N/A',
      };
    });
    // Stable roster: lowest total wins. Roster changed: compare on the room's chosen metric.
    if (!room.rosterChanged) rows.sort((a, b) => a.totalPoints - b.totalPoints);
    else if (room.config.secondaryRankMetric === 'gamesPerWin') {
      const v = r => (r.gamesPerWin === 'N/A' ? Infinity : r.gamesPerWin);
      rows.sort((a, b) => v(a) - v(b));
    } else rows.sort((a, b) => a.averagePoints - b.averagePoints);

    const winner = winnerKey ? room.players.get(winnerKey) : null;
    room.lastResult = {
      winnerKey, winnerName: winner ? winner.name : null, cutJoker: room.cutJoker,
      results, leaderboard: rows,
      rankedBy: room.rosterChanged ? room.config.secondaryRankMetric : 'totalPoints',
    };
    scheduleNextRound(room);
    toRoom(room, 'round:ended', { ...room.lastResult, nextRoundSeconds: NEXT_ROUND_SECONDS });
    broadcastReady(room);
    broadcastRoomState(room);
    broadcastTable(room);
  }
}

module.exports = { registerSocketHandlers, _rooms: rooms };
