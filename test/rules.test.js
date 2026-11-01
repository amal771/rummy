const assert = require('assert');
const { classifyGroup } = require('../server/logic/validator');
const { validateDeclaration, calculateHandPoints } = require('../server/logic/scoring');
const { bestArrangement } = require('../server/logic/autoSorter');

let n = 0;
const C = (suit, rank, id) => ({ suit, rank, isPrintedJoker: false, id: id || `${suit}${rank}` });
const PJ = (i = 0) => ({ suit: 'J', rank: 0, isPrintedJoker: true, id: `PJ${i}` });
const seq = (s, ...r) => r.map(x => C(s, x));
const t = (name, fn) => { fn(); n++; };
const cut = C('D', 9, 'cut');

t('pure sequences', () => {
  assert.strictEqual(classifyGroup(seq('H', 4, 5, 6), null), 'Pure Sequence');
  assert.strictEqual(classifyGroup(seq('H', 14, 2, 3), null), 'Pure Sequence');   // A-2-3
  assert.strictEqual(classifyGroup(seq('H', 12, 13, 14), null), 'Pure Sequence'); // Q-K-A
  assert.notStrictEqual(classifyGroup(seq('H', 13, 14, 2), null), 'Pure Sequence'); // no wrap-around
  assert.strictEqual(classifyGroup([...seq('H', 4, 5), PJ()], null), 'Impure Sequence');
});
t('impure sequences and wildcards', () => {
  assert.strictEqual(classifyGroup([C('S', 3), PJ(), C('S', 5)], null), 'Impure Sequence');
  assert.strictEqual(classifyGroup([C('S', 3), C('H', 4), C('S', 5)], null), 'Invalid');
  // cut joker (rank 9) acts as wild when unlocked, not when locked
  assert.strictEqual(classifyGroup([C('S', 3), C('H', 9), C('S', 5)], cut, true), 'Impure Sequence');
  assert.strictEqual(classifyGroup([C('S', 3), C('H', 9), C('S', 5)], cut, false), 'Invalid');
});
t('sets', () => {
  assert.strictEqual(classifyGroup([C('S', 7), C('H', 7), C('D', 7)], null), 'Set');
  assert.strictEqual(classifyGroup([C('S', 7), C('S', 7, 'S7b'), C('D', 7)], null), 'Invalid'); // same suit twice
  assert.strictEqual(classifyGroup([C('S', 7), C('H', 7), PJ()], null), 'Set');
  assert.strictEqual(classifyGroup([C('S', 7), C('H', 7), C('D', 7), C('C', 7), PJ()], null), 'Invalid'); // 5 cards
});
t('declaration', () => {
  const hand = [seq('S', 3, 4, 5, 6), seq('H', 8, 9, 10), [C('D', 2), C('H', 2), C('S', 2)], seq('C', 11, 12, 13)];
  assert(validateDeclaration(hand, null, true));
  // no pure sequence: both sequences use a joker
  const noPure = [[C('S', 3), PJ(0), C('S', 5), C('S', 6)], [C('H', 8), PJ(1), C('H', 10)], hand[2], [C('C', 11), C('C', 12), PJ(2)], [C('D', 6), C('H', 6), C('S', 6)]];
  assert(!validateDeclaration(noPure, null, false));
  // only one sequence
  assert(!validateDeclaration([hand[0], hand[2], [C('D', 5), C('H', 5), C('S', 5)], [C('D', 6), C('H', 6), C('S', 6)]], null, true));
  // 4-card sequence rule
  const no4 = [seq('S', 3, 4, 5), seq('H', 8, 9, 10), hand[2], seq('C', 11, 12, 13), [C('D', 6), C('H', 6), C('S', 6)]];
  assert(!validateDeclaration(no4, null, true));
  assert(validateDeclaration(no4, null, false));
});
t('points', () => {
  const pure = seq('S', 3, 4, 5, 6);
  // no pure sequence -> 80
  assert.strictEqual(calculateHandPoints([[C('H', 3), PJ(), C('H', 5)], [C('D', 13)]], null, true, true), 80);
  // pure only: everything else counts (jokers 0, face 10)
  assert.strictEqual(calculateHandPoints([pure, [C('H', 13), C('H', 5), PJ()]], null, true, false), 15);
  // qualifying hand: only invalid cards count
  const ok = [pure, seq('H', 8, 9, 10), [C('D', 2), C('H', 2), C('S', 2)], [C('C', 12), C('C', 5)]];
  assert.strictEqual(calculateHandPoints(ok, null, true, false), 15);
  // capped at 80
  const big = [pure, [C('H', 13), C('D', 13), C('C', 13), C('H', 12), C('D', 12), C('C', 12), C('H', 11), C('D', 11), C('S', 11)]];
  assert.strictEqual(calculateHandPoints(big, null, true, true), 80);
});
t('auto arrangement finds 4 melds (not just 2)', () => {
  const hand = [...seq('S', 3, 4, 5, 6), ...seq('H', 8, 9, 10), C('D', 2), C('H', 2), C('S', 2), ...seq('C', 11, 12, 13)];
  const r = bestArrangement(hand, null, true, true);
  assert.strictEqual(r.points, 0);
  assert.strictEqual(r.groups.flat().length, 13);
  // 14 cards: the odd one out is left over
  const r14 = bestArrangement([...hand, C('D', 13)], null, true, true);
  assert.strictEqual(r14.points, 10);
});
t('auto arrangement uses wildcards well', () => {
  const hand = [...seq('S', 3, 4, 5), C('H', 8), PJ(0), C('H', 10), C('D', 6), C('D', 6, 'D6b'), C('C', 6), ...seq('H', 11, 12, 13), C('D', 4)];
  const r = bestArrangement(hand, null, true, false);
  assert.strictEqual(r.points, 18); // S345 + H10-13 + {D6,C6,joker}; H8, D6, D4 left over
});
t('worst-case search is fast', () => {
  const hand = [PJ(0), PJ(1), C('S', 3), C('S', 5), C('S', 7), C('H', 3), C('H', 4), C('H', 9), C('D', 9), C('C', 9), C('D', 12), C('C', 2), C('S', 13), C('H', 8)];
  const t0 = Date.now();
  bestArrangement(hand, C('S', 3), true, true);
  assert(Date.now() - t0 < 1500, 'solver too slow');
});

console.log(`rules: ${n} test groups passed`);
