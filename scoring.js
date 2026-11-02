const { classifyGroup, isWildcard } = require('./validator');

// Jokers/wildcards = 0, A K Q J 10 = 10, 2-9 = face value
function getCardPoints(card, cutJoker, hasUnlockedJoker) {
  if (isWildcard(card, cutJoker, hasUnlockedJoker)) return 0;
  return card.rank >= 10 ? 10 : card.rank;
}

function analyse(groups, cutJoker, unlocked) {
  let pure = 0, seq = 0, four = false;
  const types = groups.map(g => {
    const t = classifyGroup(g, cutJoker, unlocked);
    if (t === 'Pure Sequence' || t === 'Impure Sequence') {
      seq++;
      if (t === 'Pure Sequence') pure++;
      if (g.length >= 4) four = true;
    }
    return t;
  });
  return { types, pure, seq, four };
}

const qualifies = (a, req4) => a.pure >= 1 && a.seq >= 2 && (!req4 || a.four);

/**
 * A valid declaration: every group is a valid meld, with at least one pure
 * sequence and at least two sequences in total (and a 4+ card sequence if the
 * room requires it).
 */
function validateDeclaration(groups, cutJoker, requireFourCardSeq = true, unlocked = true) {
  const a = analyse(groups, cutJoker, unlocked);
  return !a.types.includes('Invalid') && qualifies(a, requireFourCardSeq);
}

/**
 * Deadwood points for a losing hand (max 80):
 *  - no pure sequence            -> 80
 *  - pure but not qualifying     -> everything outside pure sequences counts
 *  - qualifying hand             -> only cards outside valid melds count
 */
function calculateHandPoints(groups, cutJoker, hasUnlockedJoker, requireFourCardSeq = true) {
  const a = analyse(groups, cutJoker, hasUnlockedJoker);
  if (a.pure === 0) return 80;
  const ok = qualifies(a, requireFourCardSeq);
  let points = 0;
  groups.forEach((g, i) => {
    const t = a.types[i];
    const counts = ok ? t === 'Invalid' : t !== 'Pure Sequence';
    if (counts) g.forEach(c => { points += getCardPoints(c, cutJoker, hasUnlockedJoker); });
  });
  return Math.min(80, points);
}

module.exports = { validateDeclaration, calculateHandPoints, getCardPoints };
