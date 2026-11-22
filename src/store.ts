/**
 * Zentraler App-Zustand: hält alle Daten im Speicher und schreibt Änderungen nach IndexedDB.
 */
import * as db from './db';
import type { DailyRecord, MediaRecord } from './db';
import { Scheduler } from './sched/scheduler';
import { dayNumber } from './sched/time';
import { type Card, type Ease, Queue } from './sched/types';
import {
  buildQueues, buildTree, DEFAULT_LIMITS, findNode, parentIds, SEP,
  type DailyDone, type DeckNode, type DeckQueues, type Limits,
} from './sched/queue';
import type { ImportResult } from './import/apkg';

export interface UndoEntry {
  before: Card;
  kind: 'new' | 'learn' | 'review';
  day: number;
  deckIds: string[];
}

export interface ImportSummary {
  added: number;
  updated: number;
  decks: string[];
  media: number;
}

export interface BackupFile {
  app: 'merkwerk';
  version: 1;
  exportedAt: string;
  decks: string[];
  cards: Card[];
  daily: DailyRecord[];
  settings: Limits;
  collapsed: string[];
}

export class AppStore {
  decks = new Set<string>();
  cards = new Map<string, Card>();
  daily = new Map<string, DailyRecord>();
  settings: Limits = { ...DEFAULT_LIMITS };
  collapsed = new Set<string>();
  scheduler = new Scheduler();
  undoStack: UndoEntry[] = [];
  private mediaUrls = new Map<string, string>();

  async load(): Promise<void> {
    const [decks, cards, daily, settings, collapsed] = await Promise.all([
      db.getAll<db.DeckRecord>('decks'),
      db.getAll<Card>('cards'),
      db.getAll<DailyRecord>('daily'),
      db.get<db.MetaRecord>('meta', 'settings'),
      db.get<db.MetaRecord>('meta', 'collapsed'),
    ]);
    this.decks = new Set(decks.map((d) => d.id));
    this.cards = new Map(cards.map((c) => [c.id, c]));
    this.daily = new Map(daily.map((d) => [d.key, d]));
    if (settings) this.settings = { ...DEFAULT_LIMITS, ...(settings.value as Limits) };
    if (this.settings.newPerDay === 20 && this.settings.reviewsPerDay === 200) this.settings = { ...DEFAULT_LIMITS };
    if (collapsed) this.collapsed = new Set(collapsed.value as string[]);
    this.cleanupDaily();
  }

  /** Alte Tageszähler entfernen (älter als 7 Tage). */
  private cleanupDaily(): void {
    const today = dayNumber(Date.now());
    const old = [...this.daily.values()].filter((d) => d.day < today - 7).map((d) => d.key);
    old.forEach((k) => this.daily.delete(k));
    void db.deleteMany('daily', old);
  }

  tree(): DeckNode[] {
    return buildTree(this.decks, this.cards.values());
  }

  done(deckId: string, now = Date.now()): DailyDone {
    const d = this.daily.get(`${deckId}|${dayNumber(now)}`);
    return { newDone: d?.newDone ?? 0, revDone: d?.revDone ?? 0 };
  }

  queuesFor(node: DeckNode, now = Date.now()): DeckQueues {
    return buildQueues(node, { now, limits: this.settings, done: (id) => this.done(id, now) });
  }

  queues(deckId: string, now = Date.now()): DeckQueues | null {
    const node = findNode(this.tree(), deckId);
    return node ? this.queuesFor(node, now) : null;
  }

  private async bumpDaily(deckIds: string[], day: number, kind: 'new' | 'review', delta: number): Promise<void> {
    const changed: DailyRecord[] = [];
    for (const id of deckIds) {
      const key = `${id}|${day}`;
      const rec = this.daily.get(key) ?? { key, deckId: id, day, newDone: 0, revDone: 0 };
      if (kind === 'new') rec.newDone = Math.max(0, rec.newDone + delta);
      else rec.revDone = Math.max(0, rec.revDone + delta);
      this.daily.set(key, rec);
      changed.push(rec);
    }
    await db.putMany('daily', changed);
  }

  async answer(card: Card, ease: Ease, kind: 'new' | 'learn' | 'review', now = Date.now()): Promise<Card> {
    const { state } = this.scheduler.answer(card, ease, now, card.id);
    const updated: Card = { ...card, ...state, mod: now };
    const day = dayNumber(now);
    const deckIds = [card.deckId, ...parentIds(card.deckId)];
    this.cards.set(card.id, updated);
    this.undoStack.push({ before: card, kind, day, deckIds });
    if (this.undoStack.length > 50) this.undoStack.shift();
    await db.put('cards', updated);
    if (kind !== 'learn') await this.bumpDaily(deckIds, day, kind, 1);
    return updated;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Macht die letzte Bewertung rückgängig und gibt die betroffene Karte zurück. */
  async undo(): Promise<Card | null> {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.cards.set(e.before.id, e.before);
    await db.put('cards', e.before);
    if (e.kind !== 'learn') await this.bumpDaily(e.deckIds, e.day, e.kind, -1);
    return e.before;
  }

  // ---------------------------------------------------------------- Import

  async applyImport(res: ImportResult, now = Date.now()): Promise<ImportSummary> {
    let maxPos = 0;
    for (const c of this.cards.values()) if (c.queue === Queue.New || c.ctype === 0) maxPos = Math.max(maxPos, c.due);
    // Neue Karten hinter die vorhandenen einreihen, Reihenfolge innerhalb des Pakets beibehalten.
    const newOnes = res.cards.filter((c) => !this.cards.has(c.id) && c.ctype === 0);
    const positions = [...new Set(newOnes.map((c) => c.due))].sort((a, b) => a - b);
    const posMap = new Map(positions.map((p, i) => [p, maxPos + 1 + i]));

    let added = 0;
    let updated = 0;
    const toWrite: Card[] = [];
    for (const c of res.cards) {
      const existing = this.cards.get(c.id);
      if (existing) {
        // Inhalt aktualisieren, eigenen Lernfortschritt behalten.
        const merged: Card = { ...existing, fields: c.fields, cloze: c.cloze, deckId: c.deckId, mod: now };
        this.cards.set(c.id, merged);
        toWrite.push(merged);
        updated++;
      } else {
        const card = c.ctype === 0 ? { ...c, due: posMap.get(c.due) ?? maxPos + 1 } : c;
        this.cards.set(c.id, card);
        toWrite.push(card);
        added++;
      }
    }
    const deckIds = new Set<string>();
    for (const d of res.deckIds) {
      deckIds.add(d);
      parentIds(d).forEach((p) => deckIds.add(p));
    }
    deckIds.forEach((d) => this.decks.add(d));
    const media: MediaRecord[] = res.media.map((m) => ({
      name: m.name,
      data: new Blob([m.data as Uint8Array<ArrayBuffer>], { type: m.type }),
    }));
    await db.writeTx(['cards', 'decks', 'media'], (tx) => {
      const cs = tx.objectStore('cards');
      toWrite.forEach((c) => cs.put(c));
      const ds = tx.objectStore('decks');
      deckIds.forEach((id) => ds.put({ id }));
      const ms = tx.objectStore('media');
      media.forEach((m) => ms.put(m));
    });
    media.forEach((m) => {
      const old = this.mediaUrls.get(m.name);
      if (old) URL.revokeObjectURL(old);
      this.mediaUrls.delete(m.name);
    });
    const topDecks = [...new Set(res.deckIds.map((d) => d.split(SEP)[0]))];
    return { added, updated, decks: topDecks, media: media.length };
  }

  async deleteDeck(deckId: string): Promise<number> {
    const isInside = (id: string) => id === deckId || id.startsWith(deckId + SEP);
    const cardIds = [...this.cards.values()].filter((c) => isInside(c.deckId)).map((c) => c.id);
    const deckIds = [...this.decks].filter(isInside);
    cardIds.forEach((id) => this.cards.delete(id));
    deckIds.forEach((id) => this.decks.delete(id));
    await db.deleteMany('cards', cardIds);
    await db.deleteMany('decks', deckIds);
    this.undoStack = this.undoStack.filter((u) => this.cards.has(u.before.id));
    return cardIds.length;
  }

  // ---------------------------------------------------------------- Einstellungen

  async saveSettings(s: Limits): Promise<void> {
    this.settings = { ...s };
    await db.put('meta', { key: 'settings', value: this.settings });
  }

  async toggleCollapsed(deckId: string): Promise<void> {
    if (this.collapsed.has(deckId)) this.collapsed.delete(deckId);
    else this.collapsed.add(deckId);
    await db.put('meta', { key: 'collapsed', value: [...this.collapsed] });
  }

  // ---------------------------------------------------------------- Medien

  async mediaUrl(name: string): Promise<string | null> {
    const cached = this.mediaUrls.get(name);
    if (cached) return cached;
    const rec = await db.get<MediaRecord>('media', name);
    if (!rec) return null;
    const url = URL.createObjectURL(rec.data);
    this.mediaUrls.set(name, url);
    return url;
  }

  // ---------------------------------------------------------------- Backup

  exportBackup(): BackupFile {
    return {
      app: 'merkwerk',
      version: 1,
      exportedAt: new Date().toISOString(),
      decks: [...this.decks],
      cards: [...this.cards.values()],
      daily: [...this.daily.values()],
      settings: this.settings,
      collapsed: [...this.collapsed],
    };
  }

  /** Spielt ein Backup ein. Karten aus dem Backup überschreiben gleiche Karten auf dem Gerät. */
  async importBackup(data: unknown): Promise<number> {
    const b = data as Partial<BackupFile>;
    if (!b || b.app !== 'merkwerk' || !Array.isArray(b.cards) || !Array.isArray(b.decks)) {
      throw new Error('Diese Datei ist kein gültiges Merkwerk-Backup.');
    }
    const cards = b.cards.filter((c) => c && typeof c.id === 'string' && typeof c.deckId === 'string' && Array.isArray(c.fields));
    const daily = (b.daily ?? []).filter((d) => d && typeof d.key === 'string');
    await db.writeTx(['cards', 'decks', 'daily', 'meta'], (tx) => {
      const cs = tx.objectStore('cards');
      cards.forEach((c) => cs.put(c));
      const ds = tx.objectStore('decks');
      b.decks!.forEach((id) => ds.put({ id }));
      const dl = tx.objectStore('daily');
      daily.forEach((d) => dl.put(d));
      if (b.settings) tx.objectStore('meta').put({ key: 'settings', value: { ...DEFAULT_LIMITS, ...b.settings } });
      if (b.collapsed) tx.objectStore('meta').put({ key: 'collapsed', value: b.collapsed });
    });
    this.undoStack = [];
    await this.load();
    return cards.length;
  }
}
