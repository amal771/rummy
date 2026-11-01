const socket = io();

// Local player state
let currentRoomId = null;
let localPlayerId = null;
let handGroups = [];
let cutJokerData = null;
let hasUnlockedJoker = false;
let jokerMode = 'hidden';
let isMyTurn = false;
let currentPhase = 'WAIT'; // 'DRAW' | 'DISCARD' | 'WAIT'
let turnInterval = null;

// Suit symbols
const SUITS = { S: '♠', H: '♥', D: '♦', C: '♣', J: '🃏' };
const RANKS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 0: 'PJ' };

// DOM References
const turnBorder = document.getElementById('turn-border-flash');
const timerDisplay = document.getElementById('turn-timer-display');
const closedCountElem = document.getElementById('closed-count');
const openPileCard = document.getElementById('top-open-card');
const cutJokerCard = document.getElementById('cut-joker-card');
const meldsWrapper = document.getElementById('melds-wrapper');
const btnRevealJoker = document.getElementById('btn-reveal-joker');
const rejoinModal = document.getElementById('rejoin-modal');
const leaderboardModal = document.getElementById('leaderboard-modal');
const leaderboardBody = document.getElementById('leaderboard-body');

// 1. Initial Hand Setup
socket.on('round:start_hands', (data) => {
  jokerMode = data.jokerMode;
  cutJokerData = data.cutJoker;
  hasUnlockedJoker = (jokerMode === 'open');

  // Put initial cards into one group and trigger an automatic sort
  handGroups = [data.hand];
  renderCutJoker();
  triggerAutoSort();
});

// 2. Active Turn Alerts & Timers
socket.on('turn:start', ({ activePlayerId, durationSeconds, isReduced }) => {
  isMyTurn = (activePlayerId === socket.id);
  clearInterval(turnInterval);

  if (isMyTurn) {
    currentPhase = 'DRAW';
    // Trigger 3s neon green outer pulse
    turnBorder.classList.remove('hidden');
    setTimeout(() => turnBorder.classList.add('hidden'), 3000);

    // If player is on reduced timer, show rejoin popup
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

// 3. Piles Updates
socket.on('table:piles_update', ({ openTop, closedCount }) => {
  closedCountElem.textContent = closedCount;
  renderCardToElement(openTop, openPileCard);
});

// 4. Hidden Joker Mechanics
socket.on('joker:revealed_private', ({ cutJoker }) => {
  cutJokerData = cutJoker;
  hasUnlockedJoker = true;
  btnRevealJoker.classList.add('hidden');
  renderCutJoker();
  renderHandMelds();
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

// 5. Sorted Hand & Hand Updates
socket.on('hand:sorted', ({ groups }) => {
  handGroups = groups;
  checkPureSequenceAvailability();
  renderHandMelds();
});

socket.on('player:hand_update', ({ hand }) => {
  // Update internal grouping
  handGroups = [hand];
  triggerAutoSort();
});

// 6. Round End & Leaderboard
socket.on('round:ended', ({ leaderboard }) => {
  renderLeaderboard(leaderboard);
  leaderboardModal.classList.remove('hidden');
});

// --- UI Interaction Handlers ---

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

document.getElementById('btn-leaderboard-toggle').addEventListener('click', () => {
  leaderboardModal.classList.toggle('hidden');
});

document.getElementById('btn-close-leaderboard').addEventListener('click', () => {
  leaderboardModal.classList.add('hidden');
});

document.getElementById('btn-exit-lobby').addEventListener('click', () => {
  window.location.reload();
});

btnRevealJoker.addEventListener('click', () => {
  // Find the first pure sequence among current melds
  const pureMeld = handGroups.find(g => getGroupClass(g) === 'Pure Sequence');
  if (pureMeld) {
    socket.emit('joker:reveal_req', { roomId: currentRoomId, pureSequence: pureMeld });
  }
});

// --- Helpers & Renderers ---

function triggerAutoSort() {
  socket.emit('hand:auto_sort', { roomId: currentRoomId });
}

function renderHandMelds() {
  meldsWrapper.innerHTML = '';

  handGroups.forEach((group, groupIdx) => {
    const col = document.createElement('div');
    col.className = 'meld-column';

    const cardsContainer = document.createElement('div');
    cardsContainer.className = 'meld-cards';

    group.forEach((card) => {
      const cardEl = document.createElement('div');
      cardEl.className = 'card';
      renderCardToElement(card, cardEl);

      // Discard action on click if in DISCARD phase
      cardEl.addEventListener('click', () => {
        if (isMyTurn && currentPhase === 'DISCARD') {
          socket.emit('card:discard', { roomId: currentRoomId, cardId: card.id });
        }
      });

      cardsContainer.appendChild(cardEl);
    });

    const badge = document.createElement('span');
    const groupStatus = getGroupClass(group);
    badge.className = `group-badge badge-${groupStatus.toLowerCase().split(' ')[0]}`;
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

  // Display small joker indicator under rank if wildcard unlocked
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
    const hasPure = handGroups.some(g => getGroupClass(g) === 'Pure Sequence');
    btnRevealJoker.classList.toggle('hidden', !hasPure);
  }
}

function getGroupClass(group) {
  if (isPure(group)) return 'Pure Sequence';
  return 'Meld';
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
