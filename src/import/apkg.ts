/**
 * Liest Anki-Pakete (.apkg). Unterstützt collection.anki2, collection.anki21
 * und das neuere, mit zstd komprimierte collection.anki21b.
 */
import JSZip from 'jszip';
import { decompress as zstdDecompress } from 'fzstd';
import type { Database, SqlJsStatic } from 'sql.js';
import { CardType, Queue, type Card } from '../sched/types';
import { calendarDay, dayNumber, dayStart } from '../sched/time';
import { DEFAULT_CONFIG } from '../sched/types';

export interface ImportedMedia {
  name: string;
  data: Uint8Array;
  type: string;
}

export interface ImportResult {
  deckIds: string[];
  cards: Card[];
  media: ImportedMedia[];
  format: 'anki2' | 'anki21' | 'anki21b';
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function isZstd(d: Uint8Array): boolean {
  return d.length >= 4 && ZSTD_MAGIC.every((b, i) => d[i] === b);
}

function maybeZstd(d: Uint8Array): Uint8Array {
  return isZstd(d) ? zstdDecompress(d) : d;
}

// ------------------------------------------------------------ Protobuf (minimal)

interface PbField {
  num: number;
  wire: number;
  value: number | Uint8Array;
}

function readVarint(buf: Uint8Array, pos: { p: number }): number {
  let result = 0;
  let mult = 1;
  for (;;) {
    const b = buf[pos.p++];
    result += (b & 0x7f) * mult;
    if (!(b & 0x80)) return result;
    mult *= 128;
  }
}

function parseProto(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  const pos = { p: 0 };
  while (pos.p < buf.length) {
    const key = readVarint(buf, pos);
    const num = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) out.push({ num, wire, value: readVarint(buf, pos) });
    else if (wire === 2) {
      const len = readVarint(buf, pos);
      out.push({ num, wire, value: buf.subarray(pos.p, pos.p + len) });
      pos.p += len;
    } else if (wire === 1) pos.p += 8;
    else if (wire === 5) pos.p += 4;
    else break;
  }
  return out;
}

/** Medienliste im neuen Format: MediaEntries { repeated MediaEntry entries = 1 } mit name = 1. */
function parseMediaEntries(buf: Uint8Array): Record<string, string> {
  const map: Record<string, string> = {};
  const dec = new TextDecoder();
  parseProto(buf)
    .filter((f) => f.num === 1 && f.value instanceof Uint8Array)
    .forEach((f, i) => {
      const name = parseProto(f.value as Uint8Array).find((x) => x.num === 1);
      if (name && name.value instanceof Uint8Array) map[String(i)] = dec.decode(name.value);
    });
  return map;
}

// ------------------------------------------------------------ Hilfen

function query<T = Record<string, unknown>>(db: Database, sql: string): T[] {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])) as T);
}

function hasTable(db: Database, name: string): boolean {
  return query(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`).length > 0;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** Dateinamen aller in den Feldern eingebundenen Bilder. */
export function referencedImages(html: string): string[] {
  const out: string[] = [];
  const re = /<img[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const src = m[1] ?? m[2] ?? m[3];
    if (src && !/^(https?:|data:|blob:)/i.test(src)) {
      try {
        out.push(decodeURIComponent(src));
      } catch {
        out.push(src);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ Hauptfunktion

export type SqlLoader = () => Promise<SqlJsStatic>;

export async function parseApkg(file: ArrayBuffer | Uint8Array | Blob, loadSql: SqlLoader, now = Date.now()): Promise<ImportResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('Die Datei ist keine gültige .apkg-Datei (kein ZIP-Archiv).');
  }

  let format: ImportResult['format'];
  let raw: Uint8Array;
  const f21b = zip.file('collection.anki21b');
  const f21 = zip.file('collection.anki21');
  const f2 = zip.file('collection.anki2');
  if (f21b) {
    format = 'anki21b';
    raw = maybeZstd(await f21b.async('uint8array'));
  } else if (f21) {
    format = 'anki21';
    raw = await f21.async('uint8array');
  } else if (f2) {
    format = 'anki2';
    raw = await f2.async('uint8array');
  } else {
    throw new Error('In der .apkg-Datei wurde keine Anki-Sammlung gefunden.');
  }

  const SQL = await loadSql();
  const db = new SQL.Database(raw);
  try {
    return { ...(await readCollection(db, zip, now)), format };
  } finally {
    db.close();
  }
}

interface RawDeck {
  id: number;
  name: string;
  dyn: boolean;
}

function readDecks(db: Database): Map<number, RawDeck> {
  const map = new Map<number, RawDeck>();
  if (hasTable(db, 'decks')) {
    // Neues Schema (v18): Namensteile durch \x1f getrennt, Typ als Protobuf in "kind".
    for (const r of query<{ id: number; name: string; kind: Uint8Array | null }>(db, 'SELECT id, name, kind FROM decks')) {
      const kind = r.kind ? parseProto(r.kind) : [];
      const dyn = kind.some((f) => f.num === 2); // 1 = normal, 2 = gefiltert
      map.set(Number(r.id), { id: Number(r.id), name: String(r.name).split('\x1f').join('::'), dyn });
    }
  } else {
    const row = query<{ decks: string }>(db, 'SELECT decks FROM col')[0];
    const decks = row ? (JSON.parse(row.decks) as Record<string, { id: number; name: string; dyn?: number }>) : {};
    for (const d of Object.values(decks)) {
      map.set(Number(d.id), { id: Number(d.id), name: d.name, dyn: !!d.dyn });
    }
  }
  return map;
}

/** Ermittelt für jede Notiztyp-ID, ob es ein Lückentext-Typ ist. */
function readClozeModels(db: Database): Set<number> {
  const set = new Set<number>();
  try {
    if (hasTable(db, 'notetypes')) {
      for (const r of query<{ id: number; config: Uint8Array }>(db, 'SELECT id, config FROM notetypes')) {
        const kind = parseProto(r.config).find((f) => f.num === 1);
        if (kind && kind.value === 1) set.add(Number(r.id));
      }
    } else {
      const row = query<{ models: string }>(db, 'SELECT models FROM col')[0];
      const models = row?.models ? (JSON.parse(row.models) as Record<string, { id: number; type?: number }>) : {};
      for (const m of Object.values(models)) if (m.type === 1) set.add(Number(m.id));
    }
  } catch {
    /* ohne Notiztyp-Infos wird anhand des Inhalts erkannt */
  }
  return set;
}

async function readCollection(db: Database, zip: JSZip, now: number): Promise<Omit<ImportResult, 'format'>> {
  const crt = Number(query<{ crt: number }>(db, 'SELECT crt FROM col')[0]?.crt ?? Math.floor(now / 1000));
  const crtDay = calendarDay(crt * 1000);
  const ankiToday = Math.max(0, dayNumber(now) - crtDay);
  const myToday = dayNumber(now);

  const decks = readDecks(db);
  const clozeModels = readClozeModels(db);

  const rows = query<{
    cid: number; nid: number; did: number; ord: number; type: number; queue: number; due: number;
    ivl: number; factor: number; reps: number; lapses: number; left: number; odue: number; odid: number;
    guid: string; mid: number; flds: string;
  }>(
    db,
    `SELECT c.id AS cid, c.nid, c.did, c.ord, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses,
            c.left, c.odue, c.odid, n.guid, n.mid, n.flds
     FROM cards c JOIN notes n ON n.id = c.nid
     ORDER BY c.due, c.id`,
  );

  const usedDecks = new Set<string>();
  const cards: Card[] = [];
  const images = new Set<string>();
  const steps = DEFAULT_CONFIG.learnSteps.length;
  const relearnSteps = DEFAULT_CONFIG.relearnSteps.length;

  for (const r of rows) {
    const didNum = Number(r.odid) ? Number(r.odid) : Number(r.did);
    const deck = decks.get(didNum);
    const deckId = deck && !deck.dyn ? deck.name : 'Standard';
    usedDecks.add(deckId);
    const fields = String(r.flds ?? '').split('\x1f');
    fields.forEach((f) => referencedImages(f).forEach((i) => images.add(i)));
    const cloze = clozeModels.has(Number(r.mid)) || /\{\{c\d+::/.test(fields[0] ?? '');

    const type = Number(r.type);
    const queue = Number(r.queue);
    const due = Number(r.odid) ? Number(r.odue) : Number(r.due);
    const ivl = Math.max(0, Number(r.ivl));
    const factor = Number(r.factor) > 0 ? Math.max(1300, Number(r.factor)) : 0;
    const left = Number(r.left) % 1000;

    let card: Pick<Card, 'ctype' | 'queue' | 'due' | 'ivl' | 'factor' | 'step'>;
    const suspended = queue === -1;
    // Begrabene Karten (-2/-3) werden wie normale Karten behandelt.
    if (type === CardType.Review) {
      card = { ctype: CardType.Review, queue: Queue.Review, due: myToday + (due - ankiToday), ivl: Math.max(1, ivl), factor: factor || 2500, step: 0 };
    } else if (type === CardType.Learning || type === CardType.Relearning) {
      let dueMs: number;
      if (queue === 3 || (queue < 0 && due < 1_000_000_000)) {
        dueMs = dayStart(myToday + (due - ankiToday)); // tagesübergreifendes Lernen: Tagnummer
      } else if (due > 1_000_000_000) {
        dueMs = due * 1000; // Sekunden-Zeitstempel
      } else {
        dueMs = now;
      }
      const total = type === CardType.Learning ? steps : relearnSteps;
      const step = Math.min(Math.max(total - (left || total), 0), Math.max(total - 1, 0));
      card = {
        ctype: type === CardType.Learning ? CardType.Learning : CardType.Relearning,
        queue: Queue.Learning,
        due: dueMs,
        ivl: type === CardType.Relearning ? Math.max(1, ivl) : 0,
        factor: factor || 2500,
        step,
      };
    } else {
      card = { ctype: CardType.New, queue: Queue.New, due, ivl: 0, factor: 0, step: 0 };
    }
    cards.push({
      id: `${r.guid}#${r.ord}`,
      noteGuid: String(r.guid),
      ord: Number(r.ord),
      deckId,
      fields,
      cloze,
      ...card,
      queue: suspended ? Queue.Suspended : card.queue,
      reps: Number(r.reps) || 0,
      lapses: Number(r.lapses) || 0,
      mod: now,
    });
  }

  // Medien (nur Bilder, die tatsächlich verwendet werden)
  const media: ImportedMedia[] = [];
  const mediaFile = zip.file('media');
  if (mediaFile && images.size) {
    const rawMap = maybeZstd(await mediaFile.async('uint8array'));
    let map: Record<string, string>;
    const text = new TextDecoder().decode(rawMap);
    if (text.trimStart().startsWith('{')) map = JSON.parse(text) as Record<string, string>;
    else map = parseMediaEntries(rawMap);
    for (const [entry, name] of Object.entries(map)) {
      if (!images.has(name)) continue;
      const f = zip.file(entry);
      if (!f) continue;
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      media.push({ name, data: maybeZstd(await f.async('uint8array')), type: MIME[ext] ?? 'application/octet-stream' });
    }
  }

  return { deckIds: [...usedDecks], cards, media };
}
