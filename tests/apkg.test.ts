process.env.TZ = 'Europe/Berlin';

import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApkg, loadSqlNode, type Format, type FixtureNote } from './fixtures/buildApkg';
import { parseApkg } from '../src/import/apkg';
import { AppStore } from '../src/store';
import { CardType, Queue } from '../src/sched/types';
import { dayNumber, calendarDay } from '../src/sched/time';
import { countsOf, findNode } from '../src/sched/queue';

const NOW = new Date(2026, 10, 22, 14, 0, 0).getTime();
const TODAY = dayNumber(NOW);
// Sammlung wurde vor 100 Tagen um 4 Uhr angelegt -> Anki-"heute" = 100
const CRT = Math.floor(new Date(2026, 10, 22 - 100, 4, 0, 0).getTime() / 1000);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const NOTES: FixtureNote[] = [
  { guid: 'neu1', deck: '3. Semester::Wirtschaftsrecht', fields: ['Was ist ein <b>Vertrag</b>?', '<ul><li>Zwei Willenserklärungen</li></ul>'] },
  { guid: 'neu2', deck: '3. Semester::Wirtschaftsrecht', fields: ['Frage 2', 'Antwort 2 <img src="bild.png">'] },
  {
    guid: 'wdh1', deck: '3. Semester::BWL', fields: ['Fällig in 5 Tagen', 'A'],
    cards: [{ type: 2, queue: 2, due: 105, ivl: 12, factor: 2650, reps: 7, lapses: 1 }],
  },
  {
    guid: 'wdh2', deck: '3. Semester::BWL', fields: ['Überfällig', 'A'],
    cards: [{ type: 2, queue: 2, due: 97, ivl: 4, factor: 2300, reps: 3 }],
  },
  {
    guid: 'lern1', deck: '3. Semester', fields: ['In Lernschritt 2', 'A'],
    cards: [{ type: 1, queue: 1, due: Math.floor(NOW / 1000) + 300, left: 1001, factor: 0, reps: 1 }],
  },
  {
    guid: 'gesp', deck: 'Englisch', fields: ['Gesperrt', 'A'],
    cards: [{ type: 2, queue: -1, due: 120, ivl: 30, factor: 2500, reps: 4 }],
  },
  { guid: 'rev', deck: 'Englisch', fields: ['Hund', 'dog'], cards: [{ ord: 0 }, { ord: 1 }] },
  { guid: 'lt', deck: 'Englisch', cloze: true, fields: ['Die Hauptstadt ist {{c1::Berlin}}.', ''] },
  {
    guid: 'gefiltert', deck: 'Englisch', fields: ['Im gefilterten Stapel', 'A'],
    cards: [{ type: 2, queue: 2, due: 100, odue: 110, odid: 1, ivl: 20, factor: 2500, reps: 2 }],
  },
];

const FORMATS: Format[] = ['anki2', 'anki21', 'anki21b'];
const files = new Map<Format, Uint8Array>();

beforeAll(async () => {
  for (const f of FORMATS) {
    files.set(f, await buildApkg({ format: f, crt: CRT, notes: NOTES, media: [{ name: 'bild.png', data: PNG }], filteredDecks: ['Filter 1'] }));
  }
});

describe.each(FORMATS)('Import von %s', (format) => {
  it('erkennt das Format', async () => {
    const res = await parseApkg(files.get(format)!, loadSqlNode, NOW);
    expect(res.format).toBe(format);
  });

  it('liest Stapel inkl. Unterstapel', async () => {
    const res = await parseApkg(files.get(format)!, loadSqlNode, NOW);
    expect(new Set(res.deckIds)).toEqual(new Set(['3. Semester::Wirtschaftsrecht', '3. Semester::BWL', '3. Semester', 'Englisch']));
    expect(res.deckIds).not.toContain('Filter 1');
    expect(res.deckIds).not.toContain('Default');
  });

  it('liest Notizfelder (\\x1f-getrennt) mit HTML', async () => {
    const res = await parseApkg(files.get(format)!, loadSqlNode, NOW);
    const c = res.cards.find((x) => x.noteGuid === 'neu1')!;
    expect(c.fields).toEqual(['Was ist ein <b>Vertrag</b>?', '<ul><li>Zwei Willenserklärungen</li></ul>']);
    expect(c.deckId).toBe('3. Semester::Wirtschaftsrecht');
    expect(c.ctype).toBe(CardType.New);
    expect(res.cards).toHaveLength(10);
  });

  it('übernimmt den Lernfortschritt von Wiederholungskarten', async () => {
    const res = await parseApkg(files.get(format)!, loadSqlNode, NOW);
    const w1 = res.cards.find((x) => x.noteGuid === 'wdh1')!;
    expect(w1).toMatchObject({ ctype: CardType.Review, queue: Queue.Review, ivl: 12, factor: 2650, reps: 7, lapses: 1, due: TODAY + 5 });
    const w2 = res.cards.find((x) => x.noteGuid === 'wdh2')!;
    expect(w2.due).toBe(TODAY - 3);
  });

  it('übernimmt Lernkarten (Schritt und Fälligkeit)', async () => {
    const res = await parseApkg(files.get(format)!, loadSqlNode, NOW);
    const l = res.cards.find((x) => x.noteGuid === 'lern1')!;
    expect(l.ctype).toBe(CardType.Learning);
    expect(l.queue).toBe(Queue.Learning);
    expect(l.step).toBe(1); // 1 Schritt übrig von 2 -> zweiter Schritt
    expect(l.due).toBe((Math.floor(NOW / 1000) + 300) * 1000);
    expect(l.factor).toBe(2500);
  });

  it('gesperrte Karten bleiben gesperrt, gefilterte kommen in ihren Ursprungsstapel', async () => {
    const res = await parseApkg(files.get(format)!, loadSqlNode, NOW);
    expect(res.cards.find((x) => x.noteGuid === 'gesp')!.queue).toBe(Queue.Suspended);
    const g = res.cards.find((x) => x.noteGuid === 'gefiltert')!;
    expect(g.deckId).toBe('Englisch');
    expect(g.due).toBe(TODAY + 10);
  });

  it('erkennt umgekehrte Karten und Lückentexte', async () => {
    const res = await parseApkg(files.get(format)!, loadSqlNode, NOW);
    const rev = res.cards.filter((x) => x.noteGuid === 'rev').map((x) => x.ord).sort();
    expect(rev).toEqual([0, 1]);
    expect(res.cards.find((x) => x.noteGuid === 'lt')!.cloze).toBe(true);
    expect(res.cards.find((x) => x.noteGuid === 'neu1')!.cloze).toBe(false);
  });

  it('liest verwendete Bilder aus der Mediendatei', async () => {
    const res = await parseApkg(files.get(format)!, loadSqlNode, NOW);
    expect(res.media).toHaveLength(1);
    expect(res.media[0].name).toBe('bild.png');
    expect(res.media[0].type).toBe('image/png');
    expect([...res.media[0].data]).toEqual([...PNG]);
  });
});

describe('Import in die App', () => {
  it('doppelter Import erzeugt keine Duplikate und behält den Fortschritt', async () => {
    const store = new AppStore();
    await store.load();
    const file = files.get('anki21b')!;
    const s1 = await store.applyImport(await parseApkg(file, loadSqlNode, NOW), NOW);
    expect(s1.added).toBe(10);
    expect(s1.decks.sort()).toEqual(['3. Semester', 'Englisch']);

    // Eine neue Karte lernen
    const card = store.cards.get('neu1#0')!;
    await store.answer(card, 4, 'new', NOW);
    expect(store.cards.get('neu1#0')!.ivl).toBe(4);

    // Gleiche Datei erneut importieren
    const s2 = await store.applyImport(await parseApkg(file, loadSqlNode, NOW), NOW);
    expect(s2.added).toBe(0);
    expect(s2.updated).toBe(10);
    expect(store.cards.size).toBe(10);
    expect(store.cards.get('neu1#0')!.ivl).toBe(4);

    // Daten liegen dauerhaft in IndexedDB
    const fresh = new AppStore();
    await fresh.load();
    expect(fresh.cards.size).toBe(10);
    expect(fresh.cards.get('neu1#0')!.ctype).toBe(CardType.Review);
    expect(fresh.decks.has('3. Semester::BWL')).toBe(true);
    expect(await fresh.done('3. Semester', NOW).newDone).toBe(1);
  });

  it('mehrere Stapel nacheinander importieren, Zähler und Rückgängig', async () => {
    const store = new AppStore();
    await store.load();
    const other = await buildApkg({
      format: 'anki21',
      crt: CRT,
      notes: Array.from({ length: 25 }, (_, i) => ({ guid: `fr${i}`, deck: 'Französisch', fields: [`F${i}`, `A${i}`] })),
    });
    await store.applyImport(await parseApkg(other, loadSqlNode, NOW), NOW);
    const fr = findNode(store.tree(), 'Französisch')!;
    expect(countsOf(store.queuesFor(fr, NOW))).toEqual({ newCount: 25, learnCount: 0, reviewCount: 0 });
    expect(store.decks.has('Englisch')).toBe(true); // vorheriger Import noch da

    const q = store.queuesFor(fr, NOW);
    const first = q.newCards[0];
    expect(first.fields[0]).toBe('F0'); // Reihenfolge bleibt erhalten
    await store.answer(first, 3, 'new', NOW);
    expect(countsOf(store.queuesFor(findNode(store.tree(), 'Französisch')!, NOW))).toEqual({ newCount: 24, learnCount: 1, reviewCount: 0 });

    const restored = await store.undo();
    expect(restored!.id).toBe(first.id);
    expect(countsOf(store.queuesFor(findNode(store.tree(), 'Französisch')!, NOW))).toEqual({ newCount: 25, learnCount: 0, reviewCount: 0 });
  });

  it('Backup exportieren und wieder einspielen', async () => {
    const store = new AppStore();
    await store.load();
    const backup = JSON.parse(JSON.stringify(store.exportBackup()));
    const n = store.cards.size;
    await store.deleteDeck('Französisch');
    expect(store.cards.size).toBe(n - 25);
    const restored = await store.importBackup(backup);
    expect(restored).toBe(n);
    expect(store.cards.size).toBe(n);
    await expect(store.importBackup({ foo: 1 })).rejects.toThrow('kein gültiges');
  });

  it('meldet ungültige Dateien verständlich', async () => {
    await expect(parseApkg(new Uint8Array([1, 2, 3]), loadSqlNode)).rejects.toThrow('keine gültige .apkg');
  });

  it('Kalendertag der Sammlung', () => {
    expect(TODAY - calendarDay(CRT * 1000)).toBe(100);
  });
});
