class Room {
  constructor(roomId, hostId, config) {
    this.roomId = roomId;
    this.hostId = hostId;
    this.config = {
      maxPlayers: config.maxPlayers || 20,
      jokerMode: config.jokerMode || 'hidden', // 'hidden' | 'open'
      printedJokersPerDeck: config.printedJokersPerDeck || 2, // 2 | 3
      requireFourCardSeq: config.requireFourCardSeq ?? true,
      secondaryRankMetric: config.secondaryRankMetric || 'averagePoints', // 'averagePoints' | 'gamesPerWin'
    };

    // State Flags: 'LOBBY' | 'STARTING' | 'PLAYING' | 'PAUSED' | 'ENDED'
    this.status = 'LOBBY';
    this.players = new Map(); // socketId -> Player
    this.rosterHistory = new Set(); // tracks unique player IDs ever joined
    this.rosterChanged = false;

    // Deck and Table
    this.closedPile = [];
    this.openPile = [];
    this.cutJoker = null;
    this.revealedPlayers = new Set(); // Player IDs who unlocked the hidden joker

    // Turn Control
    this.turnOrder = [];
    this.activeTurnIndex = 0;
    this.turnTimer = null;
    this.turnTimeRemaining = 30;
    this.phase = 'DRAW'; // 'DRAW' | 'DISCARD'
  }
}
