# Changelog

The version in `manifest.json` is bumped on every functional change, so the
build loaded in Chrome (`chrome://extensions`, or the label in the popup
footer / dashboard header) can always be matched against what's in the repo.

Every export also carries an `extensionVersion` field — check it before
treating an anomaly in old capture data as real signal, since it may be a bug
that a later version fixed.

## 0.5.0

The dashboard now refreshes itself every second, so a live session can be
watched without clicking Refresh. A "live" indicator sits next to the button.

Naive polling would have been noticeably worse than clicking, so the loop
avoids the obvious costs:

- Chain verification re-hashes every record, so it runs only when the bet count
  changes rather than on every tick. At a few thousand records, hashing the
  whole ledger once a second would dominate the CPU.
- Rendering is skipped entirely when neither store has grown, which is the
  common case between bets — this avoids redrawing seven canvases every second
  for no reason.
- The raw event table restores its scroll position after rebuilding, so the
  view no longer jumps while the log is being read.
- Polling pauses while the tab is hidden and catches up on return.
- Overlapping ticks are collapsed: callers receive the in-flight promise, so an
  export clicked mid-tick resolves against real data rather than a stale
  snapshot or, on first load, an empty set.

## 0.4.0

Inspected the live logged-in page over CDP and found that the animation
detection had been anchored to noise the whole time.

- **The reveal detector was matching scroll containers.** The start regex was
  `/animat|reveal|spinn|roll(ing)?/i`, and `roll(ing)?` matches the "roll"
  inside `scrollY`. Every scroll container on the page satisfied it, so
  `animationStartedAt` was stamped by unrelated mutations rather than the game
  reveal. Every duration recorded before this version is therefore suspect,
  even though the values looked plausible.
- **The end pattern never could have matched.** Tiles do not use
  `settle`/`complete`/`done` classes; they carry `data-game-tile-status`, which
  the observer ignored entirely because it only inspected `class`.

Timing is now anchored to the game's own state attribute. A reveal walks the
tiles in a staggered cascade — `hidden -> revealed` for a drawn number, and
`selected -> match` for one the player picked. One observed reveal ran 10 tiles
over 1349 ms at roughly 150 ms per tile, which is what produced the ~150 ms
onset clustering noticed earlier. Start is the first tile flip, end is the last.
Measured records are tagged `tile-cascade`.

- **Balance capture now works.** The websocket field spotted earlier
  (`availableBalances.amount`) carries a delta, so it was never safe to store as
  a balance. The rendered wallet at `[data-testid="coin-toggle"]` holds the
  absolute figure instead. Balances are tracked as a timestamped history so a
  bet can be matched to the values immediately before and after it, rather than
  whatever happens to be on screen when the record is finalized. This unblocks
  the balance-vs-animation-duration chart.

Verified against the live DOM: 40 tiles resolve, the tile selector matches
mutation targets, and the wallet element parses cleanly.

## 0.3.0

Verified 0.2.0 against a live 85-bet session: ledger chain read intact, no
`unknown` game or `unspecified` risk records, and animation duration captured
for the first time (mean 1939.85 ms). All four 0.2.0 fixes confirmed working.

That capture also exposed the next defect. Animation duration resolved for only
39 of 85 bets, and the loss was not random — every bet followed by another
within ~2.7 s lost its timing. A full reveal needs about server latency +
animation + the quiet period to resolve (~2.8 s typical, ~3.4 s worst case), and
a new bet superseded the pending one before its quiet timer could fire.

- Superseded bets are now closed out using the last observed DOM mutation as
  the animation end bound, rather than discarded.
- Added `animationTimingQuality` per record: `class-matched` and `quiet-period`
  are measurements; `superseded` is a bounded estimate; `interrupted` and
  `timeout` mean no end was observed and duration stays null.
- Headline animation stats now use measured values only. Estimates are reported
  separately as `animationDurationMsEstimated`, with a full count breakdown in
  `animationTimingQuality`, so a fast-play stretch can't drag the mean around.
- The dashboard's timing scatters plot measured durations only, and the summary
  tile shows the measured sample count next to the mean.

Known gaps: balance capture still returns null. `availableBalances.amount` was
spotted in the websocket stream and is the likely source, but it appears to
carry a delta rather than an absolute balance and needs a full payload sample
before it can be mapped safely.

## 0.2.0

Surfaced the running version in the popup footer, dashboard header, and all
export formats.

Fixes, all found by validating captured telemetry against stake.us's own Live
Stats panel on a real 86-bet session (Keno capture matched the site exactly:
84 bets, $1.28 wagered, $1.6445 returned, 25W/59L):

- **Hash chain ordering.** Chain order is now an explicit monotonic `seq`
  assigned at insertion, not `submittedAt`. Bets can append out of
  chronological order when one is held up awaiting its animation timestamp, so
  `submittedAt` was never a valid stand-in for insertion order. IndexedDB
  schema bumped to v2 for the `seq` index.
- **Chain append race.** Concurrent `onMessage` dispatches could both read the
  same chain tip and fork it. Appends are now serialized through a queue.
- **Net rounding drift.** `net` is stored at full precision instead of rounded
  to cents at write time; stake.us pays sub-cent amounts, so rounding early
  made per-record values stop summing to the recomputed total.
- **Bet misclassification.** A payload now needs number picks/results or a
  recognized game before it counts as a bet, so non-bet events (rakeback
  claims, promo credits) stay out of the ledger.
- **Null animation timing.** Added a DOM-quiet-period fallback for
  `animationFinishedAt`, which was null on every real record because the
  end-of-animation CSS class guess never matched the live markup.

Known gaps: balance capture still returns null (field name in stake.us
responses not yet identified); records captured before this version have no
`seq` and will read as a broken chain until the ledger is wiped.

## 0.1.0

Initial MVP: read-only network + DOM capture pipeline, hash-chained IndexedDB
ledger, dashboard with timing/RTP charts, and JSON/CSV/LLM exports.
