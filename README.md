# U-Bet

A Chrome extension that captures, records, and graphs your own bet history on stake.us: wager
sizes, outcomes, RTP over time, and — critically — three separate clocks per bet, so you can tell
apart a slower server, a slower result animation, and a result that arrived on time but was
displayed late.

It is **read-only telemetry**. The extension never modifies a request, a response, or a header.
It only observes network traffic and DOM state that were already going to happen, timestamps them,
and appends them to a local, hash-chained ledger.

## Install (unpacked, for development)

1. Open `chrome://extensions`.
2. Enable "Developer mode" (top right).
3. Click "Load unpacked" and select this repository's root folder.
4. Visit stake.us and place a bet. Open the extension popup to see the bet count tick up.
5. Click "Open dashboard" in the popup for charts and exports.

Requires Chrome 111+ (uses `"world": "MAIN"` content scripts, no injected `<script>` tag hack
needed).

## Architecture

```
stake.us page
  -> src/content/inject.js   (page MAIN world: wraps fetch/XHR/WebSocket, timestamps, read-only)
  -> src/content/content.js  (ISOLATED world: classifies network events, watches DOM for
                               animation start/finish, normalizes into a BetRecordV1 candidate)
  -> src/background/background.js (service worker: session bookkeeping, hash-chains records)
  -> src/background/db.js    (IndexedDB: append-only "bets" store + "raw" store for anything
                               that couldn't be classified yet)
  -> src/dashboard/*         (charts + raw event log, reads via chrome.runtime messages)
  -> src/lib/export.js       (JSON / CSV / LLM-ready export, used by both popup and dashboard)
```

Each `BetRecordV1` carries three clocks:

- `submittedAt` -> `serverResultAt`: **server latency** (network/server time).
- `animationStartedAt` -> `animationFinishedAt`: **animation duration** (client-side reveal time).
- `submittedAt` -> `animationFinishedAt`: total time until the result was actually visible.

Records are hash-chained (`rawEventHash`, `previousRecordHash`) so an exported ledger can be
checked for gaps or after-the-fact edits — the popup and dashboard both display chain status, and
the background service worker exposes no "edit" or "delete a record" API, only append + read +
full wipe.

## Calibration (do this before trusting the data)

Field-name and DOM-class matching in `src/content/content.js` are **best-effort heuristics**, not
verified against live stake.us traffic. Before relying on the numbers:

1. Play a few real bets with the dashboard open.
2. Check the "Unclassified network events" table at the bottom of the dashboard — any bet-shaped
   traffic that wasn't recognized shows up there with a body preview, so you can see the actual
   field names stake.us uses.
3. Update `FIELD_CANDIDATES` in `content.js` to include those field names if they differ from the
   guesses already listed.
4. Watch the page during a bet to see what CSS class actually gets added/removed during the result
   animation, and tighten `ANIMATION_START_CLASS_RE` / `ANIMATION_END_CLASS_RE` accordingly.
5. Cross-check 100 or so bets by hand against the dashboard before trusting `animationDurationMs`
   for anything.

## Export layer

Three formats, available from both the popup and the dashboard:

- **JSON** — the full raw ledger, unmodified.
- **CSV** — flat, one row per bet, for spreadsheets.
- **LLM export** (`.md` or `.json`) — a self-describing bundle: a data dictionary explaining every
  field, precomputed summary statistics (totals, rolling RTP over 25/100/500/1000-bet windows,
  latency/animation stats, per-game and per-risk breakdowns), and the record set. Meant to be
  pasted or attached directly into an LLM conversation without the model having to re-derive
  totals from thousands of raw rows first. The dashboard also has a "copy to clipboard" shortcut
  for the JSON variant.

## Privacy / data handling

All data stays in the browser's local IndexedDB (extension-scoped, not the site's own storage).
Nothing is sent anywhere by this extension. "Wipe local data" in the dashboard permanently deletes
everything — export first if you want to keep it.

## Status / roadmap

- [x] Network + DOM capture pipeline, hash-chained local ledger
- [x] Dashboard with cumulative net, rolling RTP, wager/net, balance-vs-animation-duration (with a
      configurable withdrawal-threshold reference line), latency-vs-animation-duration, and
      game/risk breakdowns
- [x] JSON / CSV / LLM export
- [ ] Calibrate `FIELD_CANDIDATES` and animation-class regexes against real stake.us traffic
- [ ] Per-game adapters beyond the generic heuristic classifier (Keno first)
- [ ] Safari packaging, if still wanted, once the Chrome version is verified against live data

