import * as db from './db.js';
import { buildRecord, canonicalize, sha256Hex, verifyChain } from './ledger.js';

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

async function getOrCreateSession() {
  const now = Date.now();
  const current = await db.getMeta('currentSession');
  if (current && now - current.lastActivityAt < SESSION_IDLE_TIMEOUT_MS) {
    current.lastActivityAt = now;
    await db.setMeta('currentSession', current);
    return current.sessionId;
  }
  const sessionId = `sess_${now}_${Math.random().toString(36).slice(2, 8)}`;
  await db.setMeta('currentSession', { sessionId, startedAt: now, lastActivityAt: now });
  return sessionId;
}

async function isCaptureEnabled() {
  const stored = await chrome.storage.local.get('captureEnabled');
  return stored.captureEnabled !== false; // default on
}

async function handleCaptureEvent(normalized) {
  if (!(await isCaptureEnabled())) return { stored: false, reason: 'capture disabled' };

  normalized.sessionId = normalized.sessionId || (await getOrCreateSession());

  if (!normalized.isCompleteBet) {
    await db.addRawEvent({
      capturedAt: Date.now(),
      sessionId: normalized.sessionId,
      site: normalized.site,
      url: normalized.url,
      channel: normalized.channel,
      note: normalized.note || 'unclassified network event, needs adapter calibration',
      rawEvent: normalized.rawEvent,
    });
    return { stored: true, classified: false };
  }

  const last = await db.getLastBetRecord();
  const previousRecordHash = last ? await sha256Hex(canonicalize(last)) : null;
  const record = await buildRecord(normalized, previousRecordHash);
  await db.addBetRecord(record);
  return { stored: true, classified: true, betId: record.betId };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'UBET_CAPTURE_EVENT': {
        const result = await handleCaptureEvent(message.payload);
        sendResponse(result);
        break;
      }
      case 'UBET_GET_BETS': {
        sendResponse(await db.getAllBets());
        break;
      }
      case 'UBET_GET_RAW': {
        sendResponse(await db.getAllRaw(message.limit || 200));
        break;
      }
      case 'UBET_GET_CAPTURE_ENABLED': {
        sendResponse(await isCaptureEnabled());
        break;
      }
      case 'UBET_SET_CAPTURE_ENABLED': {
        await chrome.storage.local.set({ captureEnabled: !!message.enabled });
        sendResponse({ ok: true });
        break;
      }
      case 'UBET_VERIFY_CHAIN': {
        const bets = await db.getAllBets();
        bets.sort((a, b) => a.submittedAt - b.submittedAt);
        sendResponse(await verifyChain(bets));
        break;
      }
      case 'UBET_CLEAR_ALL': {
        if (message.confirm === 'WIPE_LOCAL_DATA') {
          await db.clearAll();
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, reason: 'confirmation token missing' });
        }
        break;
      }
      default:
        sendResponse({ error: 'unknown message type' });
    }
  })();
  return true; // keep the message channel open for the async response
});
