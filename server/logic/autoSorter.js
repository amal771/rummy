const { classifyGroup } = require('./validator');
const { getCardPoints, calculateHandPoints } = require('./scoring');

const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3, J: 4 };
const sortCards = cards => cards.slice().sort((a, b) =>
  (SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit]) || (a.rank - b.rank));

function orderMeld(group, type) {
  if (type === 'Set') return sortCards(group);
  const lowAce = group.some(c => c.rank === 14) && group.some(c => c.rank === 2) && !group.some(c => c.rank === 13);
  const r = c => (lowAce && c.rank === 14 ? 1 : c.rank);
  return group.slice().sort((a, b) => r(a) - r(b));
}

/**
 * Finds the arrangement of a hand (13 or 14 cards) with the fewest deadwood
 * points. Exhaustive search over every valid meld, with a node cap as a safety net.
 * Returns { groups, points } where leftover cards form the last group.
 */
function bestArrangement(cards, cutJoker, unlocked, requireFourCardSeq = true) {
  const n = cards.length;
  if (n < 3 || n > 14) {
    return { groups: [sortCards(cards)], points: calculateHandPoints([cards], cutJoker, unlocked, requireFourCardSeq) };
  }

  const pts = cards.map(c => getCardPoints(c, cutJoker, unlocked));
  const total = pts.reduce((s, p) => s + p, 0);
  const full = (1 << n) - 1;
  const byLow = Array.from({ length: n }, () => []);

  for (let m = 7; m <= full; m++) {
    let size = 0, x = m;
    while (x) { size += x & 1; x >>= 1; }
    if (size < 3) continue;
    const group = [];
    let sum = 0;
    for (let i = 0; i < n; i++) if (m >> i & 1) { group.push(cards[i]); sum += pts[i]; }
    const type = classifyGroup(group, cutJoker, unlocked);
    if (type === 'Invalid') continue;
    byLow[31 - Math.clz32(m & -m)].push({ mask: m, type, size, sum, group });
  }
  byLow.forEach(list => list.sort((a, b) => b.size - a.size));

  let best = null, nodes = 0;
  const MAX_NODES = 80000;

  function evaluate(chosen) {
    let pure = 0, seq = 0, four = false, pureSum = 0, melded = 0;
    for (const m of chosen) {
      melded += m.sum;
      if (m.type === 'Pure Sequence') { pure++; seq++; pureSum += m.sum; if (m.size >= 4) four = true; }
      else if (m.type === 'Impure Sequence') { seq++; if (m.size >= 4) four = true; }
    }
    const dead = total - melded;
    let points;
    if (pure === 0) points = 80;
    else if (seq >= 2 && (!requireFourCardSeq || four)) points = dead;
    else points = total - pureSum;
    points = Math.min(80, points);
    if (!best || points < best.points || (points === best.points && dead < best.dead)) {
      best = { points, dead, chosen: chosen.slice() };
    }
  }

  function dfs(decided, chosen) {
    if (++nodes > MAX_NODES || (best && best.points === 0)) return;
    if (decided === full) return evaluate(chosen);
    const low = ~decided & (decided + 1);
    const i = 31 - Math.clz32(low);
    for (const meld of byLow[i]) {
      if (meld.mask & decided) continue;
      chosen.push(meld);
      dfs(decided | meld.mask, chosen);
      chosen.pop();
    }
    dfs(decided | low, chosen);
  }
  dfs(0, []);

  const rank = { 'Pure Sequence': 0, 'Impure Sequence': 1, 'Set': 2 };
  const melds = best.chosen.slice().sort((a, b) => rank[a.type] - rank[b.type]);
  const used = new Set();
  const groups = melds.map(m => { m.group.forEach(c => used.add(c.id)); return orderMeld(m.group, m.type); });
  const rest = cards.filter(c => !used.has(c.id));
  if (rest.length) groups.push(sortCards(rest));

  return { groups, points: calculateHandPoints(groups, cutJoker, unlocked, requireFourCardSeq) };
}

module.exports = { bestArrangement, sortCards };
