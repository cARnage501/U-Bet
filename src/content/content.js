// Runs in the ISOLATED content-script world. Listens for raw network frames
// from inject.js (page MAIN world), watches the DOM for result-animation
// timing, normalizes everything into BetRecordV1 shape, and hands it to the
// background service worker to hash-chain and store. This script never
// touches request/response objects itself — it only reads what inject.js
// already captured, plus the rendered DOM.

const SITE = location.hostname;

// --- Field-name candidates used to heuristically recognize a bet payload
// inside arbitrary JSON. These are best-effort guesses and WILL need
// calibration against real stake.us traffic (see README "Calibration").
const FIELD_CANDIDATES = {
  id: ['id', 'betId', 'wagerId', 'roundId', 'transactionId', 'uuid'],
  wager: ['wager', 'amount', 'betAmount', 'stake'],
  payout: ['payout', 'payoutAmount', 'winAmount', 'profit'],
  balance: ['balance', 'balanceAfter', 'newBalance', 'availableBalance'],
  risk: ['risk', 'riskLevel', 'riskMode', 'difficulty'],
  game: ['game', 'gameName', 'slug', 'gameSlug'],
  selected: ['numbers', 'selection', 'picks', 'selectedNumbers', 'chosenNumbers'],
  result: ['result', 'rolled', 'drawnNumbers', 'outcomeNumbers', 'resultNumbers'],
};

// Animation timing is anchored to stake.us's own state attribute, verified by
// observing a live reveal over CDP. Each keno tile carries
// data-game-tile-status, and a reveal walks the tiles in a staggered cascade:
//
//   hidden   -> revealed   (a drawn number the player did not pick)
//   selected -> match      (a drawn number the player did pick)
//
// One observed reveal: 10 tiles over 1349ms at a ~150ms per-tile stagger.
// That stagger is why raw onset deltas cluster near multiples of 150ms.
//
// This replaces an earlier className regex that matched `roll(ing)?` — which
// also matches the "roll" inside `scrollY`, so every scroll container on the
// page was stamping animationStartedAt with unrelated mutations. Anchoring on
// the game's own status attribute removes that whole class of false positive.
const TILE_SELECTOR = '[data-testid^="game-tile-"]';
const TILE_STATUS_ATTR = 'data-game-tile-status';
const REVEAL_STATUSES = new Set(['revealed', 'match']);

// The rendered wallet balance. The websocket carries `availableBalances.amount`
// but that appeared to be a delta, whereas this element holds the absolute
// figure the player actually sees.
const BALANCE_SELECTOR = '[data-testid="coin-toggle"]';

const PENDING_BET_TIMEOUT_MS = 20000;

// A reveal is a staggered cascade, so "finished" is the point where tiles stop
// flipping. Comfortably longer than the observed ~150ms inter-tile gap so the
// gaps within one cascade are never mistaken for the end of it.
const ANIMATION_QUIET_PERIOD_MS = 500;

let pendingBet = null;
let pendingTimer = null;
let quietTimer = null;
let lastRevealAt = null;

// Short history of observed wallet balances, so a bet can be matched to the
// balance immediately before and after it rather than whatever happens to be
// on screen when the record is finalized.
const BALANCE_HISTORY_LIMIT = 40;
const balanceHistory = [];

function parseBalance(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, '').match(/[0-9]*\.?[0-9]+/);
  return m ? Number(m[0]) : null;
}

function recordBalance(value) {
  if (value == null || Number.isNaN(value)) return;
  const last = balanceHistory[balanceHistory.length - 1];
  if (last && last.value === value) return;
  balanceHistory.push({ at: Date.now(), value });
  if (balanceHistory.length > BALANCE_HISTORY_LIMIT) balanceHistory.shift();
}

function readBalanceNow() {
  const el = document.querySelector(BALANCE_SELECTOR);
  if (el) recordBalance(parseBalance(el.textContent));
}

// Last balance observed at or before `t`; null if we hadn't seen one yet.
function balanceAsOf(t) {
  let found = null;
  for (const entry of balanceHistory) {
    if (entry.at <= t) found = entry.value;
    else break;
  }
  return found;
}

function findField(obj, names, depth = 0, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || depth > 4 || seen.has(obj)) return undefined;
  seen.add(obj);
  for (const key of Object.keys(obj)) {
    if (names.includes(key) && (typeof obj[key] === 'number' || typeof obj[key] === 'string' || Array.isArray(obj[key]))) {
      return obj[key];
    }
  }
  for (const key of Object.keys(obj)) {
    const found = findField(obj[key], names, depth + 1, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function toNumberArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(toNumber).filter((n) => n !== null);
}

function inferGameFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const known = ['keno', 'dice', 'mines', 'plinko', 'limbo', 'crash', 'roulette', 'blackjack'];
    for (const g of known) {
      if (path.includes(g)) return g;
    }
  } catch {
    // ignore malformed URLs
  }
  return null;
}

function classifyNetworkEvent(evt) {
  let responseJson = null;
  try {
    responseJson = evt.responseBody ? JSON.parse(evt.responseBody) : null;
  } catch {
    responseJson = null;
  }
  if (!responseJson) return { isCompleteBet: false };

  const wager = toNumber(findField(responseJson, FIELD_CANDIDATES.wager));
  const payout = toNumber(findField(responseJson, FIELD_CANDIDATES.payout));

  // Require both a wager and payout figure before calling this a settled bet;
  // otherwise it's left for the raw/unclassified log rather than guessed at.
  if (wager === null || payout === null) return { isCompleteBet: false };

  const resolvedGame = findField(responseJson, FIELD_CANDIDATES.game) || inferGameFromUrl(evt.url) || null;
  const selectedNumbers = toNumberArray(findField(responseJson, FIELD_CANDIDATES.selected));
  const resultNumbers = toNumberArray(findField(responseJson, FIELD_CANDIDATES.result));

  // A wager+payout match alone isn't strong enough evidence: non-bet payloads
  // (rakeback claims, promo credits, balance pushes) can coincidentally have
  // fields named "amount" and "profit"/"payout". Require a recognized game or
  // actual number picks/results too, otherwise treat it as unclassified so it
  // shows up in the dashboard's raw log instead of polluting the bet ledger.
  if (!resolvedGame && selectedNumbers.length === 0 && resultNumbers.length === 0) {
    return { isCompleteBet: false };
  }

  const balanceAfter = toNumber(findField(responseJson, FIELD_CANDIDATES.balance));
  const id = findField(responseJson, FIELD_CANDIDATES.id);

  return {
    isCompleteBet: true,
    betId: id ? String(id) : `synth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    game: resolvedGame || 'unknown',
    riskMode: findField(responseJson, FIELD_CANDIDATES.risk) ?? null,
    selectedNumbers: toNumberArray(findField(responseJson, FIELD_CANDIDATES.selected)),
    resultNumbers: toNumberArray(findField(responseJson, FIELD_CANDIDATES.result)),
    wager,
    payout,
    // Both are filled from the rendered wallet in handleNetworkEvent; any
    // payload-derived figure is only a fallback, since the field spotted in
    // the websocket stream (availableBalances.amount) looked like a delta.
    balanceBefore: null,
    balanceAfter: balanceAfter ?? null,
    submittedAt: evt.submittedAt || evt.respondedAt,
    serverResultAt: evt.respondedAt,
    rawEvent: evt,
  };
}

function sendToBackground(normalized) {
  chrome.runtime.sendMessage({ type: 'UBET_CAPTURE_EVENT', payload: { ...normalized, site: SITE } }, () => {
    // Swallow errors from a torn-down extension context (e.g. reload mid-flight).
    void chrome.runtime.lastError;
  });
}

function flushPendingBet(quality) {
  if (!pendingBet) return;
  if (quality && pendingBet.animationTimingQuality === null) {
    pendingBet.animationTimingQuality = quality;
  }
  // Resolved at flush time so the post-bet wallet update has had a chance to
  // land; balanceBefore still reads from the moment the bet was submitted.
  readBalanceNow();
  if (pendingBet.balanceAfter == null) {
    pendingBet.balanceAfter = balanceHistory.length ? balanceHistory[balanceHistory.length - 1].value : null;
  }
  sendToBackground(pendingBet);
  pendingBet = null;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (quietTimer) {
    clearTimeout(quietTimer);
    quietTimer = null;
  }
}

function scheduleQuietCheck() {
  if (quietTimer) clearTimeout(quietTimer);
  const bet = pendingBet;
  quietTimer = setTimeout(() => {
    // Guard against a stale timer firing after `bet` was already flushed
    // and pendingBet reassigned to a different, newer bet.
    if (pendingBet === bet && bet.animationStartedAt !== null && bet.animationFinishedAt === null) {
      bet.animationFinishedAt = lastRevealAt;
      flushPendingBet('tile-cascade');
    }
  }, ANIMATION_QUIET_PERIOD_MS);
}

function schedulePendingFlush() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => flushPendingBet('timeout'), PENDING_BET_TIMEOUT_MS);
}

function handleNetworkEvent(evt) {
  const normalized = classifyNetworkEvent(evt);

  if (!normalized.isCompleteBet) {
    sendToBackground({
      isCompleteBet: false,
      url: evt.url,
      channel: evt.channel,
      rawEvent: evt,
    });
    return;
  }

  // A new bet arrives while the previous one is still awaiting its animation
  // end. Measured against real play, this was losing timing on ~54% of bets:
  // a full reveal needs roughly server latency + animation + the quiet period
  // (~2.8s, up to ~3.4s) to resolve, and anything placed faster than that
  // superseded the pending bet before its quiet timer could fire.
  //
  // Visually the new bet's reveal replaces the old one, so the last tile flip
  // seen before this bet arrived bounds when the old animation ended. That's
  // an estimate, not a clean measurement, so it's tagged as such — estimates
  // must never silently pool with measured values in the stats.
  if (pendingBet) {
    if (pendingBet.animationStartedAt !== null && pendingBet.animationFinishedAt === null && lastRevealAt !== null) {
      pendingBet.animationFinishedAt = lastRevealAt;
      flushPendingBet('superseded');
    } else {
      flushPendingBet('interrupted');
    }
  }

  lastRevealAt = null;
  readBalanceNow();
  pendingBet = {
    ...normalized,
    // Prefer the rendered wallet figure, which is absolute, over anything
    // guessed out of the payload.
    balanceBefore: balanceAsOf(normalized.submittedAt) ?? normalized.balanceBefore ?? null,
    balanceAfter: null,
    animationStartedAt: null,
    animationFinishedAt: null,
    animationTimingQuality: null,
  };
  schedulePendingFlush();
}

window.addEventListener('ubet:network', (event) => handleNetworkEvent(event.detail));

// --- DOM animation timing, anchored to the tiles' own status attribute ---
const tileObserver = new MutationObserver((mutations) => {
  if (!pendingBet) return;

  let sawReveal = false;
  for (const m of mutations) {
    if (m.type !== 'attributes' || m.attributeName !== TILE_STATUS_ATTR) continue;
    const target = m.target;
    if (!(target instanceof Element) || !target.matches(TILE_SELECTOR)) continue;
    if (!REVEAL_STATUSES.has(target.getAttribute(TILE_STATUS_ATTR))) continue;

    sawReveal = true;
    if (pendingBet.animationStartedAt === null) pendingBet.animationStartedAt = Date.now();
  }

  if (!sawReveal) return;

  // Each tile in the cascade extends the reveal; the last one to flip is the
  // end of it, confirmed once no further tile turns over for the quiet period.
  lastRevealAt = Date.now();
  scheduleQuietCheck();
});

// Balance is tracked continuously rather than sampled per bet: the wallet can
// update slightly before or after the bet's network response lands, so a
// timestamped history is what lets before/after be attributed correctly.
const balanceObserver = new MutationObserver(() => readBalanceNow());

function startObserving() {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    return;
  }

  tileObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: [TILE_STATUS_ATTR],
  });

  balanceObserver.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  readBalanceNow();
}

startObserving();
