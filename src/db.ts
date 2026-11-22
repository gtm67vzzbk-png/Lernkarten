/** Schlanker Promise-Wrapper um IndexedDB. */

const DB_NAME = 'merkwerk';
const DB_VERSION = 1;

export type StoreName = 'decks' | 'cards' | 'media' | 'daily' | 'meta';

export interface DeckRecord {
  id: string;
}
export interface MediaRecord {
  name: string;
  data: Blob;
}
export interface DailyRecord {
  key: string; // `${deckId}|${day}`
  deckId: string;
  day: number;
  newDone: number;
  revDone: number;
}
export interface MetaRecord {
  key: string;
  value: unknown;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('decks')) db.createObjectStore('decks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('cards')) {
        const s = db.createObjectStore('cards', { keyPath: 'id' });
        s.createIndex('deckId', 'deckId');
      }
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('daily')) db.createObjectStore('daily', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Datenbank ist blockiert. Bitte andere Tabs der App schließen.'));
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaktion abgebrochen'));
  });
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function putMany(store: StoreName, items: unknown[]): Promise<void> {
  if (!items.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  for (const it of items) s.put(it);
  await done(tx);
}

export async function put(store: StoreName, item: unknown): Promise<void> {
  return putMany(store, [item]);
}

export async function deleteMany(store: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (!keys.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  for (const k of keys) s.delete(k);
  await done(tx);
}

/** Mehrere Speicher in einer Transaktion schreiben (atomar). */
export async function writeTx(stores: StoreName[], fn: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(stores, 'readwrite');
  fn(tx);
  await done(tx);
}
