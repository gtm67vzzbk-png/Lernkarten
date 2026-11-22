/**
 * Erzeugt echte .apkg-Dateien (wie Anki sie exportiert) für Tests und als Beispiel.
 * Läuft unter Node (sql.js, JSZip, zstd aus node:zlib).
 */
import initSqlJs from 'sql.js';
import JSZip from 'jszip';
import { zstdCompressSync } from 'node:zlib';
import { createRequire } from 'node:module';

export type Format = 'anki2' | 'anki21' | 'anki21b';

export interface FixtureCard {
  ord?: number;
  type?: number;
  queue?: number;
  due?: number;
  ivl?: number;
  factor?: number;
  reps?: number;
  lapses?: number;
  left?: number;
  odid?: number;
  odue?: number;
  /** Stapel (vollständiger Name), überschreibt den Stapel der Notiz. */
  deck?: string;
}

export interface FixtureNote {
  guid: string;
  fields: string[];
  deck: string;
  cloze?: boolean;
  cards?: FixtureCard[];
}

export interface FixtureOptions {
  format: Format;
  /** Erstellzeit der Sammlung (Sekunden). */
  crt: number;
  notes: FixtureNote[];
  media?: { name: string; data: Uint8Array }[];
  /** Gefilterte Stapel (Name -> ID werden automatisch vergeben). */
  filteredDecks?: string[];
}

const require = createRequire(import.meta.url);

async function sql() {
  const wasmDir = require.resolve('sql.js/dist/sql-wasm.wasm').replace(/sql-wasm\.wasm$/, '');
  return initSqlJs({ locateFile: (f: string) => wasmDir + f } as unknown as Parameters<typeof initSqlJs>[0]);
}

const LEGACY_SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null,
  flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null,
  ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null,
  odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
`;

const V18_EXTRA = `
CREATE TABLE decks (id integer primary key not null, name text not null, mtime_secs integer not null,
  usn integer not null, common blob not null, kind blob not null);
CREATE TABLE notetypes (id integer not null primary key, name text not null, mtime_secs integer not null,
  usn integer not null, config blob not null);
`;

const BASIC_MID = 1700000000001;
const CLOZE_MID = 1700000000002;

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

function pbBytes(field: number, data: Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(data.length), ...data];
}

export async function buildApkg(opts: FixtureOptions): Promise<Uint8Array> {
  const SQL = await sql();
  const db = new SQL.Database();
  const v18 = opts.format === 'anki21b';
  db.run(LEGACY_SCHEMA + (v18 ? V18_EXTRA : ''));

  // Stapel sammeln (inkl. Elternstapel)
  const deckNames = new Set<string>(['Default']);
  for (const n of opts.notes) {
    deckNames.add(n.deck);
    n.cards?.forEach((c) => c.deck && deckNames.add(c.deck));
  }
  for (const name of [...deckNames]) {
    const parts = name.split('::');
    for (let i = 1; i < parts.length; i++) deckNames.add(parts.slice(0, i).join('::'));
  }
  const deckIds = new Map<string, number>();
  let nextDeck = 1;
  for (const name of deckNames) deckIds.set(name, name === 'Default' ? 1 : 1600000000000 + nextDeck++);
  const filtered = new Map<string, number>();
  for (const name of opts.filteredDecks ?? []) filtered.set(name, 1650000000000 + nextDeck++);

  const models = {
    [BASIC_MID]: { id: BASIC_MID, name: 'Einfach', type: 0, flds: [{ name: 'Vorderseite' }, { name: 'Rückseite' }] },
    [CLOZE_MID]: { id: CLOZE_MID, name: 'Lückentext', type: 1, flds: [{ name: 'Text' }, { name: 'Extra' }] },
  };

  if (v18) {
    db.run(`INSERT INTO col VALUES (1, ?, 0, 0, 18, 0, 0, 0, '', '', '', '', '')`, [opts.crt]);
    for (const [name, id] of deckIds) {
      db.run('INSERT INTO decks VALUES (?, ?, 0, 0, ?, ?)', [id, name.split('::').join('\x1f'), new Uint8Array([]), new Uint8Array([0x0a, 0x00])]);
    }
    for (const [name, id] of filtered) {
      db.run('INSERT INTO decks VALUES (?, ?, 0, 0, ?, ?)', [id, name, new Uint8Array([]), new Uint8Array([0x12, 0x00])]);
    }
    db.run('INSERT INTO notetypes VALUES (?, ?, 0, 0, ?)', [BASIC_MID, 'Einfach', new Uint8Array([])]);
    db.run('INSERT INTO notetypes VALUES (?, ?, 0, 0, ?)', [CLOZE_MID, 'Lückentext', new Uint8Array([0x08, 0x01])]);
  } else {
    const decks: Record<string, unknown> = {};
    for (const [name, id] of deckIds) decks[id] = { id, name, dyn: 0 };
    for (const [name, id] of filtered) decks[id] = { id, name, dyn: 1 };
    db.run(`INSERT INTO col VALUES (1, ?, 0, 0, 11, 0, 0, 0, '{}', ?, ?, '{}', '{}')`, [
      opts.crt,
      JSON.stringify(models),
      JSON.stringify(decks),
    ]);
  }

  let nid = 1500000000000;
  let cid = 1500000000000;
  let pos = 0;
  for (const n of opts.notes) {
    nid++;
    db.run(`INSERT INTO notes VALUES (?, ?, ?, 0, 0, '', ?, 0, 0, 0, '')`, [nid, n.guid, n.cloze ? CLOZE_MID : BASIC_MID, n.fields.join('\x1f')]);
    const cards = n.cards ?? [{}];
    for (const c of cards) {
      cid++;
      pos++;
      const deck = c.deck ?? n.deck;
      const did = c.odid !== undefined ? [...filtered.values()][0] : deckIds.get(deck)!;
      db.run(`INSERT INTO cards VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')`, [
        cid, nid, did, c.ord ?? 0, c.type ?? 0, c.queue ?? c.type ?? 0, c.due ?? pos, c.ivl ?? 0, c.factor ?? 0,
        c.reps ?? 0, c.lapses ?? 0, c.left ?? 0, c.odue ?? 0, c.odid !== undefined ? deckIds.get(deck)! : 0,
      ]);
    }
  }

  const collection = db.export();
  db.close();

  const zip = new JSZip();
  const media = opts.media ?? [];
  if (opts.format === 'anki21b') {
    zip.file('collection.anki21b', zstdCompressSync(collection));
    // Anki legt zusätzlich eine Dummy-Sammlung für alte Versionen bei.
    const dummy = new SQL.Database();
    dummy.run(LEGACY_SCHEMA);
    dummy.run(`INSERT INTO col VALUES (1, 0, 0, 0, 11, 0, 0, 0, '{}', '{}', '{}', '{}', '{}')`);
    zip.file('collection.anki2', dummy.export());
    dummy.close();
    const entries: number[] = [];
    for (const m of media) {
      const entry = [...pbBytes(1, new TextEncoder().encode(m.name)), 0x10, ...varint(m.data.length)];
      entries.push(...pbBytes(1, new Uint8Array(entry)));
    }
    zip.file('media', zstdCompressSync(new Uint8Array(entries)));
    media.forEach((m, i) => zip.file(String(i), zstdCompressSync(m.data)));
  } else {
    zip.file(opts.format === 'anki21' ? 'collection.anki21' : 'collection.anki2', collection);
    zip.file('media', JSON.stringify(Object.fromEntries(media.map((m, i) => [String(i), m.name]))));
    media.forEach((m, i) => zip.file(String(i), m.data));
  }
  return zip.generateAsync({ type: 'uint8array' });
}

/** Lädt sql.js unter Node (für Tests). */
export const loadSqlNode = sql;
