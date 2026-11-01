const { isValidPureSequence, isValidImpureSequence, isValidSet, isWildcard } = require('./validator');
const { calculateHandPoints } = require('./scoring');

/**
 * Generates combinations of size k from an array
 */
function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];
  const head = arr[0];
  const tail = arr.slice(1);
  const withHead = getCombinations(tail, k - 1).map(c => [head, ...c]);
  const withoutHead = getCombinations(tail, k);
  return [...withHead, ...withoutHead];
}

/**
 * Finds optimal card groupings to minimize deadwood points
 */
function autoSortHand(cards, cutJoker, hasUnlockedJoker, requireFourCardSeq = true) {
  // If <= 3 cards, return as a single group
  if (cards.length <= 3) return [cards];

  let bestGrouping = [cards];
  let lowestPoints = 81;

  // 1. Separate wildcards and natural cards
  const wildcards = cards.filter(c => isWildcard(c, cutJoker, hasUnlockedJoker));
  const naturals = cards.filter(c => !isWildcard(c, cutJoker, hasUnlockedJoker));

  // 2. Identify all possible pure sequences
  const pureSeqCandidates = [];
  const suitBuckets = {};
  naturals.forEach(c => {
    suitBuckets[c.suit] = suitBuckets[c.suit] || [];
    suitBuckets[c.suit].push(c);
  });

  Object.values(suitBuckets).forEach(suitCards => {
    for (let size = 3; size <= Math.min(5, suitCards.length); size++) {
      const combos = getCombinations(suitCards, size);
      combos.forEach(combo => {
        if (isValidPureSequence(combo)) {
          pureSeqCandidates.push(combo);
        }
      });
    }
  });

  // Helper to remove selected cards from hand
  function excludeCards(pool, toRemove) {
    const removeIds = new Set(toRemove.map(c => c.id));
    return pool.filter(c => !removeIds.has(c.id));
  }

  // If no pure sequences are possible, sort by suit and rank to tidy the UI
  if (pureSeqCandidates.length === 0) {
    return [
      cards.slice().sort((a, b) => {
        if (a.suit === b.suit) return a.rank - b.rank;
        return a.suit.localeCompare(b.suit);
      })
    ];
  }

  // 3. Search combinations anchored by pure sequences
  for (const pureSeq of pureSeqCandidates) {
    const remainingAfterPure = excludeCards(cards, pureSeq);
    
    // Look for second sequences or sets from remainder
    const candidateMelds = [];
    for (let size = 3; size <= Math.min(4, remainingAfterPure.length); size++) {
      const combos = getCombinations(remainingAfterPure, size);
      combos.forEach(combo => {
        if (isValidImpureSequence(combo, cutJoker, hasUnlockedJoker) || 
            isValidSet(combo, cutJoker, hasUnlockedJoker)) {
          candidateMelds.push(combo);
        }
      });
    }

    // Evaluate combinations of valid melds
    for (const meld of candidateMelds) {
      const remainingDeadwood = excludeCards(remainingAfterPure, meld);
      const testGrouping = [pureSeq, meld];
      if (remainingDeadwood.length > 0) testGrouping.push(remainingDeadwood);

      const pts = calculateHandPoints(testGrouping, cutJoker, hasUnlockedJoker, requireFourCardSeq);
      if (pts < lowestPoints) {
        lowestPoints = pts;
        bestGrouping = testGrouping;
        if (lowestPoints === 0) return bestGrouping; // Optimal win condition reached
      }
    }
  }

  return bestGrouping;
}

module.exports = { autoSortHand };
