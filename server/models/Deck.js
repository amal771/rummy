class Deck {
  constructor(playerCount, printedJokersPerDeck = 2) {
    this.playerCount = playerCount;
    this.jokersPerDeck = printedJokersPerDeck;
    this.deckSize = 52 + this.jokersPerDeck;
    this.cards = [];
    this.buildDecks();
  }

  buildDecks() {
    // Formula: (NumDecks * DeckSize) - (Players * 13 + 1) >= 50
    const cardsNeeded = (this.playerCount * 13) + 1 + 50;
    const numDecks = Math.ceil(cardsNeeded / this.deckSize);

    const suits = ['S', 'H', 'D', 'C'];
    for (let d = 0; d < numDecks; d++) {
      for (const suit of suits) {
        for (let rank = 2; rank <= 14; rank++) {
          this.cards.push({ suit, rank, isPrintedJoker: false, id: `${suit}${rank}_${d}` });
        }
      }
      for (let j = 0; j < this.jokersPerDeck; j++) {
        this.cards.push({ suit: 'J', rank: 0, isPrintedJoker: true, id: `PJ_${d}_${j}` });
      }
    }
    this.shuffle();
  }

  shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  deal(numCards) {
    return this.cards.splice(0, numCards);
  }
}

module.exports = Deck;
