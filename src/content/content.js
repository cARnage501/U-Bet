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

// DOM heuristics for animation timing. These selectors are placeholders —
// step 3 of the build order ("verify 100 bets manually") means watching the
// dashboard's raw event log next to the live page and tightening these.
const ANIMATION_START_CLASS_RE = /animat|reveal|spinn|roll(ing)?/i;
const ANIMATION_END_CLASS_RE = /settle|complete|idle|done|finished/i;
const PENDING_BET_TIMEOUT_MS = 20000;

// Fallback for when ANIMATION_END_CLASS_RE never matches the live site's
// actual markup (confirmed happening in practice: animationFinishedAt was
// null on every real-world record). Once the animation has visibly started,
// treat a stretch of DOM quiet as "the reveal settled."
const ANIMATION_QUIET_PERIOD_MS = 500;

let lastKnownBalance = null;
let pendingBet = null;
let pendingTimer = null;
let quietTimer = null;
let lastMutationAt = null;

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
    balanceBefore: lastKnownBalance,
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
      bet.animationFinishedAt = lastMutationAt;
      flushPendingBet('quiet-period');
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

  if (normalized.balanceAfter !== null) lastKnownBalance = normalized.balanceAfter;

  // A new bet arrives while the previous one is still awaiting its animation
  // end. Measured against real play, this was losing timing on ~54% of bets:
  // a full reveal needs roughly server latency + animation + the quiet period
  // (~2.8s, up to ~3.4s) to resolve, and anything placed faster than that
  // superseded the pending bet before its quiet timer could fire.
  //
  // Visually the new bet's reveal replaces the old one, so the last mutation
  // observed before this bet arrived bounds when the old animation ended.
  // That's an estimate, not a clean measurement, so it's tagged as such —
  // estimates must never silently pool with measured values in the stats.
  if (pendingBet) {
    if (pendingBet.animationStartedAt !== null && pendingBet.animationFinishedAt === null && lastMutationAt !== null) {
      pendingBet.animationFinishedAt = lastMutationAt;
      flushPendingBet('superseded');
    } else {
      flushPendingBet('interrupted');
    }
  }

  lastMutationAt = null;
  pendingBet = {
    ...normalized,
    animationStartedAt: null,
    animationFinishedAt: null,
    animationTimingQuality: null,
  };
  schedulePendingFlush();
}

window.addEventListener('ubet:network', (event) => handleNetworkEvent(event.detail));

// --- DOM animation timing ---
const observer = new MutationObserver((mutations) => {
  if (!pendingBet) return;

  for (const m of mutations) {
    if (m.type !== 'attributes' || m.attributeName !== 'class') continue;
    const target = m.target;
    if (!(target instanceof Element)) continue;
    const classes = typeof target.className === 'string' ? target.className : '';

    if (pendingBet.animationStartedAt === null && ANIMATION_START_CLASS_RE.test(classes)) {
      pendingBet.animationStartedAt = Date.now();
    } else if (pendingBet.animationStartedAt !== null && pendingBet.animationFinishedAt === null && ANIMATION_END_CLASS_RE.test(classes)) {
      pendingBet.animationFinishedAt = Date.now();
      flushPendingBet('class-matched');
      return;
    }
  }

  // No recognized "finished" class this batch. As long as the reveal has
  // started, keep pushing the quiet-period fallback out on every mutation;
  // it fires once the DOM actually stops changing.
  if (pendingBet && pendingBet.animationStartedAt !== null && pendingBet.animationFinishedAt === null) {
    lastMutationAt = Date.now();
    scheduleQuietCheck();
  }
});

function startObserving() {
  if (document.body) {
    observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
  } else {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  }
}

startObserving();
