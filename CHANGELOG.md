# Changelog

The version in `manifest.json` is bumped on every functional change, so the
build loaded in Chrome (`chrome://extensions`, or the label in the popup
footer / dashboard header) can always be matched against what's in the repo.

Every export also carries an `extensionVersion` field — check it before
treating an anomaly in old capture data as real signal, since it may be a bug
that a later version fixed.

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
