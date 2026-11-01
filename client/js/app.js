const socket = io();

// Local player state
let currentRoomId = null;
let isHost = false;
let playerName = '';
let handGroups = [];
let cutJokerData = null;
let hasUnlockedJoker = false;
let jokerMode = 'hidden';
let isMyTurn = false;
let currentPhase = 'WAIT';
let turnInterval = null;

const SUITS = { S: '♠', H: '♥', D: '♦', C: '♣', J: '🃏' };
const RANKS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 0: 'PJ' };

// DOM References - Lobby
const mainLobbyScreen = document.getElementById('main-lobby-screen');
const gamePlayScreen = document.getElementById('game-play-screen');
const inputPlayerName = document.getElementById('input-player-name');
const inputJoinCode = document.getElementById('input-join-code');
const roomWaitingArea = document.getElementById('room-waiting-area');
const displayCreatedCode = document.getElementById('display-created-code');
const inviteLinkInput = document.getElementById('invite-link-input');
const qrcodeContainer = document.getElementById('qrcode-container');
const connectedCount = document.getElementById('connected-count');
const rosterList = document.getElementById('roster-list');
const btnStartGame = document.getElementById('btn-start-game');
const waitingHostMsg = document.getElementById('waiting-host-msg');

// DOM References - Game Table
const turnBorder = document.getElementById('turn-border-flash');
const timerDisplay = document.getElementById('turn-timer-display');
const statusDisplay = document.getElementById('game-status-display');
const gameRoomId = document.getElementById('game-room-id');
const closedCountElem = document.getElementById('closed-count');
const openPileCard = document.getElementById('top-open-card');
const cutJokerCard = document.getElementById('cut-joker-card');
const meldsWrapper = document.getElementById('melds-wrapper');
const btnRevealJoker = document.getElementById('btn-reveal-joker');
const rejoinModal = document.getElementById('rejoin-modal');
const leaderboardModal = document.getElementById('leaderboard-modal');
const leaderboardBody = document.getElementById('leaderboard-body');

// --- 1. INITIAL LOAD & PRE-FILL ---
window.addEventListener('DOMContentLoaded', () => {
  // Restore previously used player name
  const savedName = localStorage.getItem('rummy_player_name');
  if (savedName) {
    inputPlayerName.value = savedName;
  }

  // Check URL parameters for QR scan / invite link (e.g. ?room=ABCD)
  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('room');
  if (roomFromUrl) {
    inputJoinCode.value = roomFromUrl.toUpperCase().slice(0, 4);
    // If the name is already saved, the player only needs to click "Join Room"
    if (savedName) {
      inputJoinCode.focus();
    } else {
      inputPlayerName.focus();
    }
  }
});

function savePlayerName(name) {
  localStorage.setItem('rummy_player_name', name);
}

function generateRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Exclude I, O to prevent confusion
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  return code;
}

// --- 2. LOBBY ACTIONS ---

// Create Room Handler
document.getElementById('btn-create-room').addEventListener('click', () => {
  playerName = inputPlayerName.value.trim();
  if (!playerName) {
    alert('Please enter your name');
    inputPlayerName.focus();
    return;
  }
  savePlayerName(playerName);

  currentRoomId = generateRoomCode();
  isHost = true;

  const config = {
    maxPlayers: 20,
    jokerMode: document.getElementById('select-joker-mode').value,
    printedJokersPerDeck: parseInt(document.getElementById('select-printed-jokers').value, 10),
    requireFourCardSeq: document.getElementById('chk-four-card').checked,
    secondaryRankMetric: document.getElementById('select-rank-metric').value
  };

  socket.emit('room:create', { roomId: currentRoomId, config, playerName });
  setupWaitingLobby(currentRoomId);
});

// Join Room Handler
document.getElementById('btn-join-room').addEventListener('click', () => {
  playerName = inputPlayerName.value.trim();
  const roomCode = inputJoinCode.value.trim().toUpperCase();

  if (!playerName) {
    alert('Please enter your name');
    inputPlayerName.focus();
    return;
  }
  if (!roomCode || roomCode.length < 3) {
    alert('Please enter a valid 3 or 4 letter room code');
    inputJoinCode.focus();
    return;
  }
  savePlayerName(playerName);
  currentRoomId = roomCode;
  isHost = false;

  socket.emit('room:join', { roomId: currentRoomId, playerName });
  setupWaitingLobby(currentRoomId);
});

function setupWaitingLobby(code) {
  roomWaitingArea.classList.remove('hidden');
  displayCreatedCode.textContent = code;

  // Generate shareable URL
  const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${code}`;
  inviteLinkInput.value = inviteUrl;

  // Render QR Code
  qrcodeContainer.innerHTML = '';
  new QRCode(qrcodeContainer, {
    text: inviteUrl,
    width: 128,
    height: 128,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  if (isHost) {
    btnStartGame.classList.remove('hidden');
    waitingHostMsg.classList.add('hidden');
  } else {
    btnStartGame.classList.add('hidden');
    waitingHostMsg.classList.remove('hidden');
  }
}

// Copy invite link button
document.getElementById('btn-copy-link').addEventListener('click', () => {
  inviteLinkInput.select();
  navigator.clipboard.writeText(inviteLinkInput.value);
  alert('Invite link copied to clipboard!');
});

// Start Game Handler
btnStartGame.addEventListener('click', () => {
  socket.emit('game:trigger_start', { roomId: currentRoomId });
});

// --- 3. SOCKET LOBBY & GAME EVENTS ---

socket.on('room:state_sync', (state) => {
  if (state.players) {
    connectedCount.textContent = state.players.length;
    rosterList.innerHTML = '';
    state.players.forEach(p => {
      const li = document.createElement('li');
      li.textContent = p.name;
      rosterList.appendChild(li);
    });
  }

  if (state.status === 'STARTING') {
    statusDisplay.textContent = 'Starting...';
  } else if (state.status === 'PLAYING') {
    mainLobbyScreen.classList.add('hidden');
    gamePlayScreen.classList.remove('hidden');
    gameRoomId.textContent = currentRoomId;
  }
});

socket.on('game:countdown', ({ seconds }) => {
  statusDisplay.textContent = `Starting in ${seconds}s`;
});

socket.on('round:start_hands', (data) => {
  mainLobbyScreen.classList.add('hidden');
  gamePlayScreen.classList.remove('hidden');
  gameRoomId.textContent = currentRoomId;

  jokerMode = data.jokerMode;
  cutJokerData = data.cutJoker;
  hasUnlockedJoker = (jokerMode === 'open');

  handGroups = [data.hand];
  renderCutJoker();
  triggerAutoSort();
});

socket.on('turn:start', ({ activePlayerId, durationSeconds, isReduced }) => {
  isMyTurn = (activePlayerId === socket.id);
  clearInterval(turnInterval);

  if (isMyTurn) {
    currentPhase = 'DRAW';
    turnBorder.classList.remove('hidden');
    setTimeout(() => turnBorder.classList.add('hidden'), 3000);

    if (isReduced) {
      rejoinModal.classList.remove('hidden');
    }
  } else {
    currentPhase = 'WAIT';
  }

  let timeLeft = durationSeconds;
  timerDisplay.textContent = `${timeLeft}s`;
  turnInterval = setInterval(() => {
    timeLeft--;
    if (timeLeft >= 0) {
      timerDisplay.textContent = `${timeLeft}s`;
    } else {
      clearInterval(turnInterval);
    }
  }, 1000);
});

socket.on('table:piles_update', ({ openTop, closedCount }) => {
  closedCountElem.textContent = closedCount;
  renderCardToElement(openTop, openPileCard);
});

socket.on('joker:revealed_private', ({ cutJoker }) => {
  cutJokerData = cutJoker;
  hasUnlockedJoker = true;
  btnRevealJoker.classList.add('hidden');
  renderCutJoker();
  triggerAutoSort();
});

socket.on('joker:revealed_global', ({ cutJoker }) => {
  cutJokerData = cutJoker;
  renderCutJoker();
});

socket.on('joker:sequence_broadcast', ({ playerName, sequence, durationSeconds }) => {
  const banner = document.getElementById('sequence-broadcast-banner');
  const nameSpan = document.getElementById('broadcast-player-name');
  const cardsContainer = document.getElementById('broadcast-cards');

  nameSpan.textContent = playerName;
  cardsContainer.innerHTML = '';
  sequence.forEach(card => {
    const el = document.createElement('div');
    el.className = 'card';
    renderCardToElement(card, el);
    cardsContainer.appendChild(el);
  });

  banner.classList.remove('hidden');
  setTimeout(() => banner.classList.add('hidden'), durationSeconds * 1000);
});

socket.on('hand:sorted', ({ groups }) => {
  handGroups = groups;
  checkPureSequenceAvailability();
  renderHandMelds();
});

socket.on('player:hand_update', ({ hand }) => {
  handGroups = [hand];
  triggerAutoSort();
});

socket.on('round:ended', ({ leaderboard }) => {
  renderLeaderboard(leaderboard);
  leaderboardModal.classList.remove('hidden');
});

socket.on('game:pause_state', ({ isPaused }) => {
  statusDisplay.textContent = isPaused ? 'PAUSED' : 'Playing';
});

// --- 4. GAME ACTIONS & PLAY CONTROLS ---

document.getElementById('closed-pile').addEventListener('click', () => {
  if (isMyTurn && currentPhase === 'DRAW') {
    socket.emit('card:draw', { roomId: currentRoomId, source: 'closed' });
  }
});

document.getElementById('open-pile').addEventListener('click', () => {
  if (isMyTurn && currentPhase === 'DRAW') {
    socket.emit('card:draw', { roomId: currentRoomId, source: 'open' });
  }
});

document.getElementById('btn-auto-sort').addEventListener('click', triggerAutoSort);

document.getElementById('btn-rejoin-active').addEventListener('click', () => {
  socket.emit('player:resume_active', { roomId: currentRoomId });
  rejoinModal.classList.add('hidden');
});

document.getElementById('btn-drop').addEventListener('click', () => {
  if (confirm('Drop round and accept points penalty?')) {
    socket.emit('round:drop', { roomId: currentRoomId });
  }
});

document.getElementById('btn-declare').addEventListener('click', () => {
  socket.emit('round:declare', { roomId: currentRoomId, groupedMelds: handGroups });
});

document.getElementById('btn-pause-toggle').addEventListener('click', () => {
  socket.emit('game:toggle_pause', { roomId: currentRoomId });
});

document.getElementById('btn-leaderboard-toggle').addEventListener('click', () => {
  leaderboardModal.classList.toggle('hidden');
});

document.getElementById('btn-close-leaderboard').addEventListener('click', () => {
  leaderboardModal.classList.add('hidden');
});

document.getElementById('btn-exit-lobby').addEventListener('click', () => {
  window.location.href = window.location.origin + window.location.pathname;
});

btnRevealJoker.addEventListener('click', () => {
  const pureMeld = handGroups.find(g => isPure(g));
  if (pureMeld) {
    socket.emit('joker:reveal_req', { roomId: currentRoomId, pureSequence: pureMeld });
  }
});

function triggerAutoSort() {
  socket.emit('hand:auto_sort', { roomId: currentRoomId });
}

function renderHandMelds() {
  meldsWrapper.innerHTML = '';

  handGroups.forEach((group) => {
    const col = document.createElement('div');
    col.className = 'meld-column';

    const cardsContainer = document.createElement('div');
    cardsContainer.className = 'meld-cards';

    group.forEach((card) => {
      const cardEl = document.createElement('div');
      cardEl.className = 'card';
      renderCardToElement(card, cardEl);

      cardEl.addEventListener('click', () => {
        if (isMyTurn && currentPhase === 'DISCARD') {
          socket.emit('card:discard', { roomId: currentRoomId, cardId: card.id });
        }
      });

      cardsContainer.appendChild(cardEl);
    });

    const badge = document.createElement('span');
    const groupStatus = isPure(group) ? 'Pure Sequence' : 'Meld';
    badge.className = `group-badge ${isPure(group) ? 'badge-pure' : 'badge-set'}`;
    badge.textContent = groupStatus;

    col.appendChild(cardsContainer);
    col.appendChild(badge);
    meldsWrapper.appendChild(col);
  });
}

function renderCardToElement(card, element) {
  if (!card) {
    element.innerHTML = '';
    element.className = 'card empty';
    return;
  }

  const isRed = card.suit === 'H' || card.suit === 'D';
  element.className = `card ${isRed ? 'red' : 'black'}`;

  const rankStr = RANKS[card.rank] || card.rank;
  const suitStr = SUITS[card.suit] || '';

  let html = `<div>${rankStr} ${suitStr}</div>`;

  if (hasUnlockedJoker && cutJokerData && card.rank === cutJokerData.rank) {
    html += `<span class="joker-indicator">★ JKR</span>`;
  }

  element.innerHTML = html;
}

function renderCutJoker() {
  if (cutJokerData) {
    cutJokerCard.classList.remove('card-back');
    renderCardToElement(cutJokerData, cutJokerCard);
  } else {
    cutJokerCard.className = 'card card-back';
    cutJokerCard.innerHTML = '<span>Hidden</span>';
  }
}

function checkPureSequenceAvailability() {
  if (jokerMode === 'hidden' && !hasUnlockedJoker) {
    const hasPure = handGroups.some(g => isPure(g));
    btnRevealJoker.classList.toggle('hidden', !hasPure);
  }
}

function isPure(cards) {
  if (!cards || cards.length < 3) return false;
  if (cards.some(c => c.isPrintedJoker)) return false;
  const s = cards[0].suit;
  if (!cards.every(c => c.suit === s)) return false;
  const ranks = cards.map(c => c.rank).sort((a,b) => a - b);
  for (let i = 0; i < ranks.length - 1; i++) {
    if (ranks[i+1] !== ranks[i] + 1) return false;
  }
  return true;
}

function renderLeaderboard(players) {
  leaderboardBody.innerHTML = '';
  players.forEach((p, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${p.name}</td>
      <td>${p.totalPoints}</td>
      <td>${p.averagePoints}</td>
      <td>${p.gamesPlayed}</td>
      <td>${p.gamesWon}</td>
      <td>${p.gamesPerWin}</td>
    `;
    leaderboardBody.appendChild(tr);
  });
}
