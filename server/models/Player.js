class Player {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.hand = [];
    this.isEliminated = false;
    this.hasFolded = false;
    this.hasSeenHiddenJoker = false;
    
    // Inactivity tracking
    this.isOffline = false;
    this.consecutiveMissedTurns = 0;
    this.isReducedTimer = false; // true if timer set to 10s or 3s
    
    // Lifetime room stats
    this.stats = {
      totalPoints: 0,
      gamesPlayed: 0,
      gamesWon: 0,
      get averagePoints() {
        return this.gamesPlayed > 0 ? (this.totalPoints / this.gamesPlayed).toFixed(2) : 0;
      },
      get gamesPerWin() {
        return this.gamesWon > 0 ? (this.gamesPlayed / this.gamesWon).toFixed(2) : 'N/A';
      }
    };
  }

  getTurnDuration() {
    if (this.consecutiveMissedTurns >= 3 || this.isOffline) return 3;
    if (this.consecutiveMissedTurns > 0) return 10;
    return 30;
  }
}
