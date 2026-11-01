const Deck = require('./models/Deck');
const { autoSortHand } = require('./logic/autoSorter');
const { validateDeclaration, calculateHandPoints } = require('./logic/scoring');
const { isValidPureSequence, classifyGroup } = require('./logic/validator');

// In-memory room storage: roomId -> Room instance
const rooms = new Map();

function registerSocketHandlers(io) {
  io.on('connection', (socket) => {

    // 1. Room Creation
    socket.on('room:create', ({ roomId, config, playerName }) => {
      if (rooms.has(roomId)) {
        return socket.emit('error', { message: 'Room already exists.' });
      }

      const room = {
        roomId,
        hostId: socket.id,
        config: {
          maxPlayers: config.maxPlayers || 20,
          jokerMode: config.jokerMode || 'hidden', // 'hidden' | 'open'
          printedJokersPerDeck: config.printedJokersPerDeck || 2, // 2 | 3
          requireFourCardSeq: config.requireFourCardSeq ?? true,
          secondaryRankMetric: config.secondaryRankMetric || 'averagePoints', // 'averagePoints' | 'gamesPerWin'
        },
        status: 'LOBBY',
        players: new Map(),
        initialRoster: new Set(),
        rosterChanged: false,
        closedPile: [],
        openPile: [],
        cutJoker: null,
        revealedPlayers: new Set(),
        turnOrder: [],
        activeTurnIndex: 0,
        turnTimer: null,
        countdownTimer: null,
        isPaused: false,
      };

      rooms.set(roomId, room);
      socket.join(roomId);
      addPlayerToRoom(room, socket, playerName);
      broadcastRoomState(io, room);
    });

    // 2. Join / Reconnect to Room
    socket.on('room:join', ({ roomId, playerName }) => {
      const room = rooms.get(roomId);
      if (!room) return socket.emit('error', { message: 'Room not found.' });

      // Handle reconnecting player by name
      let existingPlayer = null;
      for (const [sId, p] of room.players.entries()) {
        if (p.name === playerName) {
          existingPlayer = p;
          room.players.delete(sId);
          room.players.set(socket.id, p);
          p.id = socket.id;
          p.isOffline = false;
          break;
        }
      }

      socket.join(roomId);

      if (!existingPlayer) {
        if (room.players.size >= room.config.maxPlayers) {
          return socket.emit('error', { message: 'Room is full.' });
        }
        addPlayerToRoom(room, socket, playerName);
        if (room.status === 'PLAYING') {
          room.rosterChanged = true;
        }
      }

      broadcastRoomState(io, room);
    });

    // 3. Start Game (Host only or auto after countdown)
    socket.on('game:trigger_start', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.hostId !== socket.id || room.status !== 'LOBBY') return;
      if (room.players.size < 2) return socket.emit('error', { message: 'Need at least 2 players to start.' });

      room.status = 'STARTING';
      let count = 20;
      io.to(roomId).emit('game:countdown', { seconds: count });

      room.countdownTimer = setInterval(() => {
        count--;
        io.to(roomId).emit('game:countdown', { seconds: count });
        if (count <= 0) {
          clearInterval(room.countdownTimer);
          initiateRound(io, room);
        }
      }, 1000);
    });

    // 4. Card Draw
    socket.on('card:draw', ({ roomId, source }) => {
      const room = rooms.get(roomId);
      if (!room || room.status !== 'PLAYING' || room.isPaused) return;

      const player = getActivePlayer(room);
      if (!player || player.id !== socket.id || player.phase !== 'DRAW') return;

      let card;
      if (source === 'open' && room.openPile.length > 0) {
        card = room.openPile.pop();
      } else {
        if (room.closedPile.length === 0) recycleDiscardPile(room);
        card = room.closedPile.pop();
      }

      player.hand.push(card);
      player.phase = 'DISCARD';

      socket.emit('player:hand_update', { hand: player.hand });
      io.to(roomId).emit('table:piles_update', {
        openTop: room.openPile[room.openPile.length - 1] || null,
        closedCount: room.closedPile.length,
      });
    });

    // 5. Reveal Hidden Joker
    socket.on('joker:reveal_req', ({ roomId, pureSequence }) => {
      const room = rooms.get(roomId);
      if (!room || room.status !== 'PLAYING' || room.config.jokerMode !== 'hidden') return;

      const player = room.players.get(socket.id);
      if (!player || player.hasSeenHiddenJoker) return;

      // Verify sequence is legitimately pure
      if (!isValidPureSequence(pureSequence)) {
        return socket.emit('error', { message: 'Invalid pure sequence.' });
      }

      player.hasSeenHiddenJoker = true;
      room.revealedPlayers.add(socket.id);

      // Private reveal to player
      socket.emit('joker:revealed_private', { cutJoker: room.cutJoker });

      // Temporary 5-second public broadcast of the sequence to all players
      io.to(roomId).emit('joker:sequence_broadcast', {
        playerName: player.name,
        sequence: pureSequence,
        durationSeconds: 5,
      });

      // If all active non-eliminated players have seen the cut joker, open it permanently
      const activePlayers = [...room.players.values()].filter(p => !p.isEliminated && !p.hasFolded);
      if (activePlayers.every(p => p.hasSeenHiddenJoker)) {
        io.to(roomId).emit('joker:revealed_global', { cutJoker: room.cutJoker });
      }
    });

    // 6. Card Discard
    socket.on('card:discard', ({ roomId, cardId }) => {
      const room = rooms.get(roomId);
      if (!room || room.status !== 'PLAYING' || room.isPaused) return;

      const player = getActivePlayer(room);
      if (!player || player.id !== socket.id || player.phase !== 'DISCARD') return;

      const cardIndex = player.hand.findIndex(c => c.id === cardId);
      if (cardIndex === -1) return;

      const [discarded] = player.hand.splice(cardIndex, 1);
      room.openPile.push(discarded);
      player.phase = 'WAIT';
      player.consecutiveMissedTurns = 0; // reset inactivity streak

      socket.emit('player:hand_update', { hand: player.hand });
      io.to(roomId).emit('table:piles_update', {
        openTop: discarded,
        closedCount: room.closedPile.length,
      });

      advanceTurn(io, room);
    });

    // 7. Auto-Sort Hand
    socket.on('hand:auto_sort', ({ roomId }) => {
      const room = rooms.get(roomId);
      const player = room?.players.get(socket.id);
      if (!player) return;

      const canUseCutJoker = room.config.jokerMode === 'open' || player.hasSeenHiddenJoker;
      const sortedGroups = autoSortHand(
        player.hand,
        room.cutJoker,
        canUseCutJoker,
        room.config.requireFourCardSeq
      );

      socket.emit('hand:sorted', { groups: sortedGroups });
    });

    // 8. Player Declaration
    socket.on('round:declare', ({ roomId, groupedMelds }) => {
      const room = rooms.get(roomId);
      if (!room || room.status !== 'PLAYING') return;

      const player = getActivePlayer(room);
      if (!player || player.id !== socket.id) return;

      const isValid = validateDeclaration(
        groupedMelds,
        room.cutJoker,
        room.config.requireFourCardSeq
      );

      if (isValid) {
        // Player wins round with 0 deadwood points
        player.stats.gamesWon++;
        concludeRound(io, room, player.id);
      } else {
        // False declaration: penalty 80 points and immediate round knockout
        player.isEliminated = true;
        player.roundScore = 80;
        player.stats.totalPoints += 80;
        socket.emit('declaration:result', { success: false, points: 80 });
        io.to(roomId).emit('player:knocked_out', { playerId: player.id, name: player.name });

        const remainingActive = [...room.players.values()].filter(p => !p.isEliminated && !p.hasFolded);
        if (remainingActive.length <= 1) {
          concludeRound(io, room, remainingActive[0]?.id || null);
        } else {
          advanceTurn(io, room);
        }
      }
    });

    // 9. Drop / Fold
    socket.on('round:drop', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.status !== 'PLAYING') return;

      const player = room.players.get(socket.id);
      if (!player || player.hasFolded || player.isEliminated) return;

      const penalty = player.turnsPlayed === 0 ? 20 : 40;
      player.hasFolded = true;
      player.roundScore = penalty;
      player.stats.totalPoints += penalty;

      io.to(roomId).emit('player:dropped', { playerId: player.id, name: player.name, penalty });

      const remainingActive = [...room.players.values()].filter(p => !p.isEliminated && !p.hasFolded);
      if (remainingActive.length <= 1) {
        concludeRound(io, room, remainingActive[0]?.id || null);
      } else if (getActivePlayer(room)?.id === socket.id) {
        advanceTurn(io, room);
      }
    });

    // 10. Pause / Resume Toggle
    socket.on('game:toggle_pause', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.status !== 'PLAYING') return;

      room.isPaused = !room.isPaused;
      io.to(roomId).emit('game:pause_state', { isPaused: room.isPaused, toggledBy: socket.id });
    });

    // 11. Rejoin from Inactive / Reduced-Time State
    socket.on('player:resume_active', ({ roomId }) => {
      const room = rooms.get(roomId);
      const player = room?.players.get(socket.id);
      if (!player) return;

      player.consecutiveMissedTurns = 0;
      socket.emit('player:resumed');
    });

    // 12. Disconnect Handler
    socket.on('disconnect', () => {
      for (const room of rooms.values()) {
        const player = room.players.get(socket.id);
        if (player) {
          player.isOffline = true;
          room.rosterChanged = true;
          if (room.status === 'PLAYING' && getActivePlayer(room)?.id === socket.id) {
            triggerAutoPlay(io, room);
          }
          break;
        }
      }
    });

  });
}

// --- Lifecycle & Turn Mechanics ---

function addPlayerToRoom(room, socket, playerName) {
  const newPlayer = {
    id: socket.id,
    name: playerName || `Player ${room.players.size + 1}`,
    hand: [],
    turnsPlayed: 0,
    phase: 'WAIT',
    isEliminated: false,
    hasFolded: false,
    hasSeenHiddenJoker: false,
    consecutiveMissedTurns: 0,
    isOffline: false,
    roundScore: 0,
    stats: {
      totalPoints: 0,
      gamesPlayed: 0,
      gamesWon: 0,
    },
  };
  room.players.set(socket.id, newPlayer);
  room.initialRoster.add(socket.id);
}

function initiateRound(io, room) {
  room.status = 'PLAYING';
  room.revealedPlayers.clear();

  // Create cards dynamically using deck builder
  const deckInstance = new Deck(room.players.size, room.config.printedJokersPerDeck);
  room.closedPile = deckInstance.cards;

  // Extract cut joker
  room.cutJoker = room.closedPile.pop();

  // Deal 13 cards to each player
  for (const player of room.players.values()) {
    player.hand = room.closedPile.splice(0, 13);
    player.isEliminated = false;
    player.hasFolded = false;
    player.turnsPlayed = 0;
    player.hasSeenHiddenJoker = room.config.jokerMode === 'open';
    player.stats.gamesPlayed++;
  }

  // First card to start discard pile
  room.openPile = [room.closedPile.pop()];
  room.turnOrder = [...room.players.keys()];
  room.activeTurnIndex = 0;

  // Distribute hands privately
  for (const [sId, player] of room.players.entries()) {
    io.to(sId).emit('round:start_hands', {
      hand: player.hand,
      cutJoker: room.config.jokerMode === 'open' ? room.cutJoker : null,
      jokerMode: room.config.jokerMode,
    });
  }

  io.to(room.roomId).emit('table:piles_update', {
    openTop: room.openPile[0],
    closedCount: room.closedPile.length,
  });

  startPlayerTurn(io, room);
}

function startPlayerTurn(io, room) {
  clearTimeout(room.turnTimer);

  const player = getActivePlayer(room);
  if (!player || player.isEliminated || player.hasFolded) {
    return advanceTurn(io, room);
  }

  player.phase = 'DRAW';
  player.turnsPlayed++;

  // Determine turn length based on inactivity
  let turnSeconds = 30;
  if (player.consecutiveMissedTurns >= 3 || player.isOffline) {
    turnSeconds = 3;
  } else if (player.consecutiveMissedTurns > 0) {
    turnSeconds = 10;
  }

  // Broadcast turn start; active player receives flashBorder flag
  io.to(room.roomId).emit('turn:start', {
    activePlayerId: player.id,
    durationSeconds: turnSeconds,
    isReduced: turnSeconds < 30,
  });

  room.turnTimer = setTimeout(() => {
    player.consecutiveMissedTurns++;
    triggerAutoPlay(io, room);
  }, turnSeconds * 1000);
}

function triggerAutoPlay(io, room) {
  const player = getActivePlayer(room);
  if (!player || player.phase === 'WAIT') return;

  // Auto-draw from closed stock pile
  if (player.phase === 'DRAW') {
    if (room.closedPile.length === 0) recycleDiscardPile(room);
    const card = room.closedPile.pop();
    player.hand.push(card);
  }

  // Auto-discard drawn or top card directly to open pile
  const discarded = player.hand.pop();
  room.openPile.push(discarded);
  player.phase = 'WAIT';

  io.to(player.id).emit('player:hand_update', { hand: player.hand });
  io.to(room.roomId).emit('table:piles_update', {
    openTop: discarded,
    closedCount: room.closedPile.length,
  });

  advanceTurn(io, room);
}

function advanceTurn(io, room) {
  clearTimeout(room.turnTimer);
  room.activeTurnIndex = (room.activeTurnIndex + 1) % room.turnOrder.length;
  startPlayerTurn(io, room);
}

function recycleDiscardPile(room) {
  if (room.openPile.length <= 1) return;
  const topCard = room.openPile.pop();
  room.closedPile = room.openPile.reverse();
  room.openPile = [topCard];
}

function concludeRound(io, room, winnerId) {
  clearTimeout(room.turnTimer);
  room.status = 'ENDED';

  // Compute deadwood penalty for all other players
  const playerRows = [];
  for (const player of room.players.values()) {
    if (player.id === winnerId) {
      player.roundScore = 0;
    } else if (!player.isEliminated && !player.hasFolded) {
      const sorted = autoSortHand(
        player.hand,
        room.cutJoker,
        room.config.jokerMode === 'open' || player.hasSeenHiddenJoker,
        room.config.requireFourCardSeq
      );
      const points = calculateHandPoints(
        sorted,
        room.cutJoker,
        room.config.jokerMode === 'open' || player.hasSeenHiddenJoker,
        room.config.requireFourCardSeq
      );
      player.roundScore = points;
      player.stats.totalPoints += points;
    }

    const avg = player.stats.gamesPlayed > 0
      ? (player.stats.totalPoints / player.stats.gamesPlayed).toFixed(2)
      : '0.00';
    const gpw = player.stats.gamesWon > 0
      ? (player.stats.gamesPlayed / player.stats.gamesWon).toFixed(2)
      : 'N/A';

    playerRows.push({
      id: player.id,
      name: player.name,
      totalPoints: player.stats.totalPoints,
      averagePoints: parseFloat(avg),
      gamesPlayed: player.stats.gamesPlayed,
      gamesWon: player.stats.gamesWon,
      gamesPerWin: gpw,
    });
  }

  // Dynamic ranking logic
  if (!room.rosterChanged) {
    // Stable roster: sort by total points ascending
    playerRows.sort((a, b) => a.totalPoints - b.totalPoints);
  } else {
    // Roster changed: sort by configured metric
    if (room.config.secondaryRankMetric === 'gamesPerWin') {
      playerRows.sort((a, b) => {
        const valA = a.gamesPerWin === 'N/A' ? Infinity : parseFloat(a.gamesPerWin);
        const valB = b.gamesPerWin === 'N/A' ? Infinity : parseFloat(b.gamesPerWin);
        return valA - valB;
      });
    } else {
      playerRows.sort((a, b) => a.averagePoints - b.averagePoints);
    }
  }

  io.to(room.roomId).emit('round:ended', {
    winnerId,
    cutJoker: room.cutJoker,
    leaderboard: playerRows,
  });
}

function getActivePlayer(room) {
  const socketId = room.turnOrder[room.activeTurnIndex];
  return room.players.get(socketId);
}

function broadcastRoomState(io, room) {
  io.to(room.roomId).emit('room:state_sync', {
    roomId: room.roomId,
    status: room.status,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      isOffline: p.isOffline,
    })),
    config: room.config,
  });
}

module.exports = { registerSocketHandlers };
