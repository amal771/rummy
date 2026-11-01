# Online Rummy

Multiplayer 13-card Indian Rummy (2–20 players) built with Node, Express and Socket.IO.

```bash
npm install
npm start          # http://localhost:3000
npm test           # rules + full multiplayer flow tests
```

## Rules implemented

- 13 cards each; draw (closed or open pile) then discard. One pack for 2 players, two for 3–8, more packs as the table grows (up to 20 players).
- Wild jokers: printed jokers plus every card of the cut-joker rank. A room can use an **open** cut joker, or a
  **hidden** one unlocked by showing a pure sequence.
- Valid declaration: all 13 cards in valid groups, at least two sequences, at least one pure. Optional room rule: a 4-card sequence.
- Finish by discarding one card face-down and declaring. Other players get 45 seconds to arrange and confirm their cards.
- Scoring: A/K/Q/J/10 = 10, 2–9 face value, jokers 0, capped at 80. No pure sequence = 80.
- Drop = 20 before your first turn, 40 after. Wrong declaration = 80 and out of the round.
- Missing three turns in a row drops you. Disconnected players are auto-played and can rejoin from the same browser.
- The host deals each next round; the first player rotates.

## Layout

- `server/logic/validator.js` meld rules (also served to the browser at `/shared/rules.js`)
- `server/logic/scoring.js` declaration check and deadwood points
- `server/logic/autoSorter.js` exhaustive best-arrangement solver (Auto group and scoring)
- `server/socketHandler.js` rooms, turns, timers, show phase, reconnects
- `client/` lobby and table UI
