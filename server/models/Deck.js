class Deck {
  /**
   * Standard setup: one pack for 2 players, two packs for 3+ players.
   * Each pack = 52 cards + printed jokers.
   */
  constructor(playerCount, printedJokersPerDeck = 2) {
    this.cards = [];
    const numDecks = playerCount <= 2 ? 1 : 2;
    const suits = ['S', 'H', 'D', 'C'];
    for (let d = 0; d < numDecks; d++) {
      for (const suit of suits) {
        for (let rank = 2; rank <= 14; rank++) {
          this.cards.push({ suit, rank, isPrintedJoker: false, id: `${suit}${rank}_${d}` });
        }
      }
      for (let j = 0; j < printedJokersPerDeck; j++) {
        this.cards.push({ suit: 'J', rank: 0, isPrintedJoker: true, id: `PJ_${d}_${j}` });
      }
    }
    Deck.shuffle(this.cards);
  }

  static shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

module.exports = Deck;
