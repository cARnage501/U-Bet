const DB_NAME = 'ubet-telemetry';
const DB_VERSION = 1;
const STORE_BETS = 'bets';
const STORE_RAW = 'raw';
const STORE_META = 'meta';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BETS)) {
        const bets = db.createObjectStore(STORE_BETS, { keyPath: 'betId' });
        bets.createIndex('sessionId', 'sessionId');
        bets.createIndex('submittedAt', 'submittedAt');
        bets.createIndex('game', 'game');
      }
      if (!db.objectStoreNames.contains(STORE_RAW)) {
        const raw = db.createObjectStore(STORE_RAW, { keyPath: 'seq', autoIncrement: true });
        raw.createIndex('capturedAt', 'capturedAt');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addBetRecord(record) {
  const db = await openDb();
  return reqToPromise(tx(db, STORE_BETS, 'readwrite').add(record));
}

export async function addRawEvent(event) {
  const db = await openDb();
  return reqToPromise(tx(db, STORE_RAW, 'readwrite').add(event));
}

export async function getAllBets() {
  const db = await openDb();
  return reqToPromise(tx(db, STORE_BETS, 'readonly').getAll());
}

export async function getBetsBySession(sessionId) {
  const db = await openDb();
  const store = tx(db, STORE_BETS, 'readonly');
  return reqToPromise(store.index('sessionId').getAll(sessionId));
}

export async function getAllRaw(limit = 200) {
  const db = await openDb();
  const all = await reqToPromise(tx(db, STORE_RAW, 'readonly').getAll());
  return all.slice(-limit);
}

export async function getMeta(key) {
  const db = await openDb();
  const result = await reqToPromise(tx(db, STORE_META, 'readonly').get(key));
  return result ? result.value : undefined;
}

export async function setMeta(key, value) {
  const db = await openDb();
  return reqToPromise(tx(db, STORE_META, 'readwrite').put({ key, value }));
}

export async function getLastBetRecord() {
  const db = await openDb();
  const store = tx(db, STORE_BETS, 'readonly').index('submittedAt');
  return new Promise((resolve, reject) => {
    const req = store.openCursor(null, 'prev');
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearAll() {
  const db = await openDb();
  await Promise.all([
    reqToPromise(tx(db, STORE_BETS, 'readwrite').clear()),
    reqToPromise(tx(db, STORE_RAW, 'readwrite').clear()),
    reqToPromise(tx(db, STORE_META, 'readwrite').clear()),
  ]);
}
