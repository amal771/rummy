/**
 * Ranks: 2-10, J=11, Q=12, K=13, A=14
 * Printed Jokers: isPrintedJoker === true (suit 'J', rank 0)
 */

function isCutJoker(card, cutJoker) {
  if (!card || !cutJoker) return false;
  return card.rank === cutJoker.rank;
}

function isWildcard(card, cutJoker, hasUnlockedJoker = true) {
  if (!card) return false;
  if (card.isPrintedJoker) return true;
  if (hasUnlockedJoker && cutJoker && isCutJoker(card, cutJoker)) return true;
  return false;
}

// 1. Pure Sequence: >=3 consecutive cards of same suit, NO wildcards allowed
function isValidPureSequence(cards) {
  if (!cards || cards.length < 3) return false;
  if (cards.some(c => c.isPrintedJoker)) return false;

  const suit = cards[0].suit;
  if (!cards.every(c => c.suit === suit)) return false;

  const ranks = cards.map(c => c.rank).sort((a, b) => a - b);
  // Check for duplicates
  for (let i = 0; i < ranks.length - 1; i++) {
    if (ranks[i] === ranks[i + 1]) return false;
  }

  // Standard consecutive check
  let consecutive = true;
  for (let i = 0; i < ranks.length - 1; i++) {
    if (ranks[i + 1] !== ranks[i] + 1) {
      consecutive = false;
      break;
    }
  }
  if (consecutive) return true;

  // Ace low check (A-2-3 -> 14, 2, 3 becomes 1, 2, 3)
  if (ranks.includes(14)) {
    const aceLowRanks = ranks.map(r => (r === 14 ? 1 : r)).sort((a, b) => a - b);
    for (let i = 0; i < aceLowRanks.length - 1; i++) {
      if (aceLowRanks[i + 1] !== aceLowRanks[i] + 1) return false;
    }
    return true;
  }

  return false;
}

// 2. Impure Sequence: >=3 cards of same suit, gaps bridged by wildcards
function isValidImpureSequence(cards, cutJoker, hasUnlockedJoker = true) {
  if (!cards || cards.length < 3) return false;

  const naturals = cards.filter(c => !isWildcard(c, cutJoker, hasUnlockedJoker));
  const wildcards = cards.filter(c => isWildcard(c, cutJoker, hasUnlockedJoker));

  // If all are wildcards, it's valid as an impure sequence
  if (naturals.length === 0) return true;

  const suit = naturals[0].suit;
  if (!naturals.every(c => c.suit === suit)) return false;

  const ranks = [...new Set(naturals.map(c => c.rank))].sort((a, b) => a - b);
  if (ranks.length !== naturals.length) return false; // Duplicate natural ranks invalid

  function canBridge(rankList, wildCount) {
    let needed = 0;
    for (let i = 0; i < rankList.length - 1; i++) {
      const diff = rankList[i + 1] - rankList[i] - 1;
      if (diff < 0) return false;
      needed += diff;
    }
    return needed <= wildCount;
  }

  if (canBridge(ranks, wildcards.length)) return true;

  // Ace low alternative check
  if (ranks.includes(14)) {
    const aceLow = ranks.map(r => (r === 14 ? 1 : r)).sort((a, b) => a - b);
    if (canBridge(aceLow, wildcards.length)) return true;
  }

  return false;
}

// 3. Set: 3 or 4 cards of identical rank across DIFFERENT suits (wildcards fill missing)
function isValidSet(cards, cutJoker, hasUnlockedJoker = true) {
  if (!cards || cards.length < 3 || cards.length > 4) return false;

  const naturals = cards.filter(c => !isWildcard(c, cutJoker, hasUnlockedJoker));
  if (naturals.length === 0) return true; // All wildcards

  const targetRank = naturals[0].rank;
  if (!naturals.every(c => c.rank === targetRank)) return false;

  const seenSuits = new Set();
  for (const c of naturals) {
    if (seenSuits.has(c.suit)) return false; // Duplicate suits illegal in sets
    seenSuits.add(c.suit);
  }
  return true;
}

// Identify group category
function classifyGroup(group, cutJoker, hasUnlockedJoker = true) {
  if (isValidPureSequence(group)) return 'Pure Sequence';
  if (isValidImpureSequence(group, cutJoker, hasUnlockedJoker)) return 'Impure Sequence';
  if (isValidSet(group, cutJoker, hasUnlockedJoker)) return 'Set';
  return 'Invalid';
}

module.exports = {
  isValidPureSequence,
  isValidImpureSequence,
  isValidSet,
  classifyGroup,
  isWildcard,
};
