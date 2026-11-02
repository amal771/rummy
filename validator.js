/**
 * Rummy meld rules (shared by server and browser).
 * Ranks: 2-10, J=11, Q=12, K=13, A=14 (A may also be low: A-2-3).
 * Printed jokers: isPrintedJoker === true. The "cut joker" rank is wild once unlocked.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RummyRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function isWildcard(card, cutJoker, hasUnlockedJoker = true) {
    if (!card) return false;
    if (card.isPrintedJoker) return true;
    return !!(hasUnlockedJoker && cutJoker && card.rank === cutJoker.rank);
  }

  // Can `ranks` (sorted, unique) be a run once `wild` wildcards fill gaps / extend the ends?
  function canBridge(ranks, wild) {
    let needed = 0;
    for (let i = 0; i < ranks.length - 1; i++) needed += ranks[i + 1] - ranks[i] - 1;
    if (needed > wild) return false;
    return ranks.length + wild <= 13; // a run can never be longer than 13 cards
  }

  // 1. Pure sequence: 3+ consecutive cards of one suit, no printed jokers
  function isValidPureSequence(cards) {
    if (!cards || cards.length < 3 || cards.length > 13) return false;
    if (cards.some(c => c.isPrintedJoker)) return false;
    const suit = cards[0].suit;
    if (!cards.every(c => c.suit === suit)) return false;

    const ranks = cards.map(c => c.rank).sort((a, b) => a - b);
    if (new Set(ranks).size !== ranks.length) return false;

    const run = r => r.every((x, i) => i === 0 || x === r[i - 1] + 1);
    if (run(ranks)) return true;
    if (ranks.includes(14)) {
      return run(ranks.map(r => (r === 14 ? 1 : r)).sort((a, b) => a - b));
    }
    return false;
  }

  // 2. Impure sequence: 3+ cards, one suit for the naturals, wildcards fill gaps
  function isValidImpureSequence(cards, cutJoker, hasUnlockedJoker = true) {
    if (!cards || cards.length < 3 || cards.length > 14) return false;
    const naturals = cards.filter(c => !isWildcard(c, cutJoker, hasUnlockedJoker));
    const wild = cards.length - naturals.length;
    if (naturals.length === 0) return true;

    const suit = naturals[0].suit;
    if (!naturals.every(c => c.suit === suit)) return false;
    const ranks = naturals.map(c => c.rank).sort((a, b) => a - b);
    if (new Set(ranks).size !== ranks.length) return false;

    if (canBridge(ranks, wild)) return true;
    if (ranks.includes(14)) {
      const low = ranks.map(r => (r === 14 ? 1 : r)).sort((a, b) => a - b);
      if (canBridge(low, wild)) return true;
    }
    return false;
  }

  // 3. Set: 3-4 cards of one rank, all different suits (wildcards fill in)
  function isValidSet(cards, cutJoker, hasUnlockedJoker = true) {
    if (!cards || cards.length < 3 || cards.length > 4) return false;
    const naturals = cards.filter(c => !isWildcard(c, cutJoker, hasUnlockedJoker));
    if (naturals.length === 0) return true;
    if (!naturals.every(c => c.rank === naturals[0].rank)) return false;
    return new Set(naturals.map(c => c.suit)).size === naturals.length;
  }

  function classifyGroup(group, cutJoker, hasUnlockedJoker = true) {
    if (isValidPureSequence(group)) return 'Pure Sequence';
    if (isValidImpureSequence(group, cutJoker, hasUnlockedJoker)) return 'Impure Sequence';
    if (isValidSet(group, cutJoker, hasUnlockedJoker)) return 'Set';
    return 'Invalid';
  }

  return { isValidPureSequence, isValidImpureSequence, isValidSet, classifyGroup, isWildcard };
});
