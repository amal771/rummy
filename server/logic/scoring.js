const { classifyGroup, isValidPureSequence, isWildcard } = require('./validator');

function getCardPoints(card, cutJoker, hasUnlockedJoker) {
  if (isWildcard(card, cutJoker, hasUnlockedJoker)) return 0;
  if (card.rank >= 10) return 10; // 10, J, Q, K, A
  return card.rank;
}

/**
 * Validates a declaration:
 * - At least 2 sequences
 * - At least 1 pure sequence
 * - If requireFourCardSeq is true: at least one sequence (pure or impure) must have length >= 4
 * - All other cards in valid sets/sequences
 */
function validateDeclaration(groupedMelds, cutJoker, requireFourCardSeq = true) {
  let pureCount = 0;
  let totalSeqCount = 0;
  let hasFourCardSeq = false;

  for (const group of groupedMelds) {
    const status = classifyGroup(group, cutJoker, true);
    if (status === 'Pure Sequence') {
      pureCount++;
      totalSeqCount++;
      if (group.length >= 4) hasFourCardSeq = true;
    } else if (status === 'Impure Sequence') {
      totalSeqCount++;
      if (group.length >= 4) hasFourCardSeq = true;
    } else if (status !== 'Set') {
      return false; // Found an Invalid group
    }
  }

  if (pureCount < 1) return false;
  if (totalSeqCount < 2) return false;
  if (requireFourCardSeq && !hasFourCardSeq) return false;

  return true;
}

/**
 * Calculates deadwood points.
 * Rule: Points stay frozen at 80 until minimum qualifying conditions are met.
 */
function calculateHandPoints(groupedMelds, cutJoker, hasUnlockedJoker, requireFourCardSeq = true) {
  let pureCount = 0;
  let totalSeqCount = 0;
  let hasFourCardSeq = false;

  const validGroups = [];
  const deadwoodGroups = [];

  for (const group of groupedMelds) {
    const status = classifyGroup(group, cutJoker, hasUnlockedJoker);
    if (status === 'Pure Sequence') {
      pureCount++;
      totalSeqCount++;
      if (group.length >= 4) hasFourCardSeq = true;
      validGroups.push(group);
    } else if (status === 'Impure Sequence') {
      totalSeqCount++;
      if (group.length >= 4) hasFourCardSeq = true;
      validGroups.push(group);
    } else if (status === 'Set') {
      validGroups.push(group);
    } else {
      deadwoodGroups.push(group);
    }
  }

  // Freeze at 80 if baseline qualifying sequences are not formed
  const qualifies = pureCount >= 1 && totalSeqCount >= 2 && (!requireFourCardSeq || hasFourCardSeq);
  if (!qualifies) {
    return 80;
  }

  // Calculate sum of invalid/unmelded cards
  let points = 0;
  for (const group of deadwoodGroups) {
    for (const card of group) {
      points += getCardPoints(card, cutJoker, hasUnlockedJoker);
    }
  }

  return Math.min(80, points);
}

module.exports = {
  validateDeclaration,
  calculateHandPoints,
  getCardPoints,
};
