process.env.RUMMY_COUNTDOWN = '1';
process.env.RUMMY_SHOW = '2';
const assert = require('assert');
const http = require('http');
const { Server } = require('socket.io');
const { io: Client } = require('socket.io-client');
const { registerSocketHandlers, _rooms } = require('../server/socketHandler');

const httpServer = http.createServer();
const io = new Server(httpServer);
registerSocketHandlers(io);

const wait = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev) => new Promise(r => s.once(ev, r));
const emit = (s, ev, data) => new Promise(r => s.emit(ev, data, r));
const C = (suit, rank, id) => ({ suit, rank, isPrintedJoker: false, id: id || `${suit}${rank}_t` });

function player(url, key) {
  const s = Client(url, { forceNew: true });
  s.key = key; s.errors = []; s.events = [];
  s.on('error', e => s.errors.push(e.message));
  s.on('player:hand_update', d => { s.hand = d.hand; s.phase = d.phase; });
  s.on('round:start_hands', d => { s.hand = d.hand; });
  s.on('game:sync', d => { s.sync = d; if (d.hand?.length) s.hand = d.hand; });
  ['declaration:result', 'player:dropped', 'player:knocked_out', 'round:ended', 'round:show_started']
    .forEach(ev => s.on(ev, d => s.events.push([ev, d])));
  return s;
}

(async () => {
  await new Promise(r => httpServer.listen(0, r));
  const url = `http://localhost:${httpServer.address().port}`;
  const [a, b, c] = [player(url, 'ka'), player(url, 'kb'), player(url, 'kc')];

  const created = await emit(a, 'room:create', { playerName: 'Asha', playerKey: 'ka', config: { jokerMode: 'open' } });
  assert(created.ok && /^[A-Z]{4}$/.test(created.roomId));
  const roomId = created.roomId, room = _rooms.get(roomId);
  assert.strictEqual((await emit(b, 'room:join', { roomId: 'ZZZZ', playerName: 'Ben', playerKey: 'kb' })).ok, false);
  assert((await emit(b, 'room:join', { roomId, playerName: 'Ben', playerKey: 'kb' })).ok);
  assert((await emit(c, 'room:join', { roomId, playerName: 'Ben', playerKey: 'kc' })).name !== 'Ben', 'duplicate names are renamed');

  // only the host can start
  b.emit('game:trigger_start'); await wait(100);
  assert.strictEqual(room.status, 'LOBBY');
  a.emit('game:trigger_start'); await wait(1600);
  assert.strictEqual(room.status, 'PLAYING');
  [a, b, c].forEach(p => assert.strictEqual(p.hand.length, 13));
  assert(!room.cutJoker.isPrintedJoker, 'cut joker is never a printed joker');
  const all = new Set([a, b, c].flatMap(p => p.hand.map(x => x.id)));
  assert.strictEqual(all.size, 39, 'no duplicate cards dealt');

  const byKey = { ka: a, kb: b, kc: c };
  const P = () => Object.values(byKey);
  const current = () => byKey[room.turnOrder[room.activeTurnIndex]];

  // out-of-turn actions are ignored
  const first = current();
  const other = [a, b, c].find(p => p !== first);
  other.emit('card:draw', { source: 'closed' }); await wait(100);
  assert.strictEqual(room.players.get(other.key).hand.length, 13);

  // a normal turn: draw from the open pile (allowed on the very first turn), then discard
  const openTop = room.openPile[room.openPile.length - 1];
  first.emit('card:draw', { source: 'open' }); await wait(100);
  assert.strictEqual(first.hand.length, 14);
  assert(first.hand.some(x => x.id === openTop.id), 'took the open card');
  first.emit('card:discard', { cardId: 'nope' }); await wait(50);
  assert.strictEqual(first.hand.length, 14, 'cannot discard a card you do not hold');
  first.emit('card:discard', { cardId: first.hand[0].id }); await wait(100);
  assert.strictEqual(first.hand.length, 13);
  assert.notStrictEqual(current(), first, 'turn advanced');

  // forged declaration (cards that are not in the hand) is rejected without penalty
  let p = current();
  p.emit('card:draw', { source: 'closed' }); await wait(100);
  p.emit('round:declare', { groups: [[C('S', 3), C('S', 4), C('S', 5)]], finishCardId: p.hand[0].id }); await wait(100);
  assert(p.errors.length, 'forged groups produce an error');
  assert.strictEqual(room.players.get(p.key).status, 'ACTIVE');

  // reconnect mid-round: same key, new socket, game state restored and turn order intact
  const keep = current();
  const reKey = [a, b, c].find(x => x !== keep && x !== p && x.key !== 'ka').key;
  byKey[reKey].disconnect(); await wait(100);
  const back = player(url, reKey); byKey[reKey] = back;
  const rj = await emit(back, 'room:join', { roomId, playerName: 'x', playerKey: reKey });
  assert(rj.ok); await wait(150);
  assert(back.sync.inRound && back.sync.hand.length === 13, 'hand restored after reconnect');

  // valid declaration: inject a winning hand, then check the show phase
  const dealer = current();
  const dp = room.players.get(dealer.key);
  if (dp.phase === 'DRAW') { dealer.emit('card:draw', { source: 'closed' }); await wait(100); }
  dp.hand = [C('S', 3), C('S', 4), C('S', 5), C('S', 6), C('H', 8), C('H', 9), C('H', 10),
             C('D', 2), C('H', 2, 'H2_t'), C('C', 2), C('C', 11), C('C', 12), C('C', 13), C('D', 5, 'finish')];
  dp.hand.forEach((x, i) => { x.id = x.id.startsWith('finish') ? 'finish' : `W${i}`; });
  dealer.hand = dp.hand;
  const ids = i => dp.hand.slice(i[0], i[1]).map(x => x.id);
  // groups that drop a card are out of sync -> error, no penalty
  dealer.emit('round:declare', { groups: [ids([0, 4]), ids([4, 7]), ids([7, 10])], finishCardId: 'finish' });
  await wait(150);
  assert.strictEqual(dp.status, 'ACTIVE');
  dealer.emit('round:declare', { groups: [ids([0, 4]), ids([4, 7]), ids([7, 10]), [dp.hand[10].id, dp.hand[12].id, dp.hand[11].id]].map(g => g), finishCardId: 'finish' });
  await wait(300);
  assert.strictEqual(room.status, 'SHOWING', 'valid declaration starts the show phase');
  assert.strictEqual(dp.hand.length, 13);

  // losers submit their arrangement; the round ends once everyone has shown
  for (const q of P().filter(x => x !== dealer)) {
    const h = room.players.get(q.key).hand;
    q.emit('round:submit_show', { groups: [h.map(x => x.id)] });
  }
  await wait(300);
  assert.strictEqual(room.status, 'ENDED');
  const res = room.lastResult;
  assert.strictEqual(res.winnerKey, dealer.key);
  assert.strictEqual(res.results.find(r => r.key === dealer.key).roundScore, 0);
  res.results.filter(r => r.key !== dealer.key).forEach(r => assert(r.roundScore > 0 && r.roundScore <= 80));
  assert.strictEqual(res.leaderboard.length, 3);

  // next round: only the host may start it; dealer rotates
  const firstRound1 = room.turnOrder[0];
  b.emit('game:next_round'); await wait(100);
  assert.strictEqual(room.status, 'ENDED');
  a.emit('game:next_round'); await wait(200);
  assert.strictEqual(room.status, 'PLAYING');
  assert.notStrictEqual(room.turnOrder[0], firstRound1, 'first player rotates each round');
  [...room.players.values()].forEach(pl => assert.strictEqual(pl.hand.length, 13));

  // drop: only on your own turn, before drawing. First drop = 20
  const t1 = byKey[room.turnOrder[room.activeTurnIndex]];
  const notNow = P().find(x => x !== t1);
  notNow.emit('round:drop'); await wait(100);
  assert.strictEqual(room.players.get(notNow.key).status, 'ACTIVE', 'cannot drop out of turn');
  t1.emit('round:drop'); await wait(150);
  assert.strictEqual(room.players.get(t1.key).roundScore, 20);

  // second player drops after a full turn: 40; last player standing wins
  const t2 = byKey[room.turnOrder[room.activeTurnIndex]];
  t2.emit('card:draw', { source: 'closed' }); await wait(80);
  t2.emit('card:discard', { cardId: t2.hand[0].id }); await wait(100);
  let t3 = byKey[room.turnOrder[room.activeTurnIndex]];
  if (t3 === t2 || room.players.get(t3.key).status !== 'ACTIVE') t3 = P().find(x => x !== t1 && x !== t2);
  const t3Obj = room.players.get(t3.key);
  assert.strictEqual(t3Obj.status, 'ACTIVE');
  // t2 plays again to reach their next turn, then drops for 40
  const spin = async () => { while (byKey[room.turnOrder[room.activeTurnIndex]] !== t2) {
      const x = byKey[room.turnOrder[room.activeTurnIndex]];
      x.emit('card:draw', { source: 'closed' }); await wait(60);
      x.emit('card:discard', { cardId: x.hand[0].id }); await wait(60); } };
  await spin();
  t2.emit('round:drop'); await wait(150);
  assert.strictEqual(room.players.get(t2.key).roundScore, 40);
  assert.strictEqual(room.status, 'ENDED');
  assert.strictEqual(room.lastResult.winnerKey, t3.key);

  // wrong declaration => 80 and out
  a.emit('game:next_round'); await wait(200);
  const w = byKey[room.turnOrder[room.activeTurnIndex]];
  const wp = room.players.get(w.key);
  w.emit('card:draw', { source: 'closed' }); await wait(80);
  w.emit('round:declare', { groups: [wp.hand.slice(0, 13).map(x => x.id)], finishCardId: wp.hand[13].id }); await wait(150);
  assert.strictEqual(wp.status, 'OUT');
  assert.strictEqual(wp.roundScore, 80);
  assert(w.events.some(e => e[0] === 'declaration:result'));

  P().forEach(x => x.close());
  io.close(); httpServer.close();
  console.log('game: full flow passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
