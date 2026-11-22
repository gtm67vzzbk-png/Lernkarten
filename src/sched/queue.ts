/**
 * Stapelbaum, Tageslimits, Zähler und Auswahl der nächsten Karte.
 */
import { CardType, Queue, type Card } from './types';
import { dayNumber, nextDayStart } from './time';

export const SEP = '::';

export interface Limits {
  newPerDay: number;
  reviewsPerDay: number;
}

/** Wert für „ohne Limit“ (als Zahl, damit er sich im Backup als JSON speichern lässt). */
export const UNLIMITED = 99999;

export const DEFAULT_LIMITS: Limits = { newPerDay: UNLIMITED, reviewsPerDay: UNLIMITED };

/** Erledigte Karten pro Stapel am heutigen Tag. */
export interface DailyDone {
  newDone: number;
  revDone: number;
}

export interface DeckNode {
  id: string; // vollständiger Name, z. B. "3. Semester::Wirtschaftsrecht"
  name: string; // letzter Namensteil
  depth: number;
  children: DeckNode[];
  parent: DeckNode | null;
  cards: Card[];
}

export interface Counts {
  newCount: number;
  learnCount: number;
  reviewCount: number;
}

export function parentIds(deckId: string): string[] {
  const parts = deckId.split(SEP);
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 1; i--) out.push(parts.slice(0, i).join(SEP));
  return out;
}

/** Baut den Stapelbaum aus Stapelnamen und Karten. Fehlende Elternstapel werden ergänzt. */
export function buildTree(deckIds: Iterable<string>, cards: Iterable<Card>): DeckNode[] {
  const nodes = new Map<string, DeckNode>();
  const ensure = (id: string): DeckNode => {
    let n = nodes.get(id);
    if (n) return n;
    const parts = id.split(SEP);
    n = { id, name: parts[parts.length - 1], depth: parts.length - 1, children: [], parent: null, cards: [] };
    nodes.set(id, n);
    if (parts.length > 1) {
      const p = ensure(parts.slice(0, -1).join(SEP));
      n.parent = p;
      p.children.push(n);
    }
    return n;
  };
  for (const id of deckIds) ensure(id);
  for (const c of cards) ensure(c.deckId).cards.push(c);
  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  const sortRec = (list: DeckNode[]) => {
    list.sort((a, b) => collator.compare(a.name, b.name));
    list.forEach((n) => sortRec(n.children));
  };
  const roots = [...nodes.values()].filter((n) => !n.parent);
  sortRec(roots);
  return roots;
}

export function findNode(roots: DeckNode[], id: string): DeckNode | null {
  for (const r of roots) {
    if (r.id === id) return r;
    const f = findNode(r.children, id);
    if (f) return f;
  }
  return null;
}

export function allCards(node: DeckNode): Card[] {
  const out = [...node.cards];
  for (const c of node.children) out.push(...allCards(c));
  return out;
}

/** Kleiner, stabiler Hash, um Wiederholungen mit gleichem Fälligkeitstag zufällig (aber fest) zu mischen. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface QueueContext {
  now: number;
  limits: Limits;
  done: (deckId: string) => DailyDone;
}

/**
 * Sammelt verfügbare Karten eines Stapels samt Unterstapeln unter Beachtung der Limits.
 * Wie bei Anki begrenzt das Limit eines Elternstapels auch die Unterstapel.
 */
function gather(
  node: DeckNode,
  budget: number,
  pick: (c: Card) => boolean,
  remaining: (n: DeckNode) => number,
  sort: (a: Card, b: Card) => number,
): Card[] {
  budget = Math.min(budget, remaining(node));
  if (budget <= 0) return [];
  const own = node.cards.filter(pick).sort(sort).slice(0, budget);
  const out = own;
  for (const child of node.children) {
    if (out.length >= budget) break;
    out.push(...gather(child, budget - out.length, pick, remaining, sort));
  }
  return out;
}

export interface DeckQueues {
  newCards: Card[];
  reviewCards: Card[];
  /** Lernkarten mit Fälligkeit heute, nach Fälligkeit sortiert. */
  learnCards: Card[];
}

export function buildQueues(node: DeckNode, ctx: QueueContext): DeckQueues {
  const today = dayNumber(ctx.now);
  const dayEnd = nextDayStart(ctx.now);
  const newCards = gather(
    node,
    Infinity,
    (c) => c.queue === Queue.New,
    (n) => ctx.limits.newPerDay - ctx.done(n.id).newDone,
    (a, b) => a.due - b.due || (a.ord - b.ord),
  );
  const reviewCards = gather(
    node,
    Infinity,
    (c) => c.queue === Queue.Review && c.due <= today,
    (n) => ctx.limits.reviewsPerDay - ctx.done(n.id).revDone,
    (a, b) => a.due - b.due || hash(a.id + today) - hash(b.id + today),
  );
  const learnCards = allCards(node)
    .filter((c) => c.queue === Queue.Learning && c.due < dayEnd)
    .sort((a, b) => a.due - b.due);
  return { newCards, reviewCards, learnCards };
}

export function countsOf(q: DeckQueues): Counts {
  return { newCount: q.newCards.length, learnCount: q.learnCards.length, reviewCount: q.reviewCards.length };
}

export type NextCard =
  | { kind: 'card'; card: Card; queue: 'new' | 'learn' | 'review' }
  | { kind: 'wait'; until: number }
  | { kind: 'done' };

/**
 * Wählt die nächste Karte:
 * 1. Lernkarten, die jetzt fällig sind,
 * 2. Wiederholungen und neue Karten gemischt,
 * 3. Lernkarten, die bald fällig sind (innerhalb von 20 Min.),
 * 4. sonst warten oder fertig.
 * @param sessionCount Anzahl bereits gezeigter Karten (zum gleichmäßigen Mischen neuer Karten).
 */
export function pickNext(q: DeckQueues, now: number, learnAheadSecs: number, sessionCount: number, excludeId?: string): NextCard {
  const learn = q.learnCards.filter((c) => c.id !== excludeId);
  if (learn.length && learn[0].due <= now) return { kind: 'card', card: learn[0], queue: 'learn' };

  const nNew = q.newCards.length;
  const nRev = q.reviewCards.length;
  if (nNew && nRev) {
    // Neue Karten gleichmäßig zwischen die Wiederholungen streuen.
    const every = Math.max(2, Math.floor((nNew + nRev) / nNew));
    const showNew = sessionCount % every === every - 1;
    return showNew
      ? { kind: 'card', card: q.newCards[0], queue: 'new' }
      : { kind: 'card', card: q.reviewCards[0], queue: 'review' };
  }
  if (nRev) return { kind: 'card', card: q.reviewCards[0], queue: 'review' };
  if (nNew) return { kind: 'card', card: q.newCards[0], queue: 'new' };

  if (learn.length && learn[0].due <= now + learnAheadSecs * 1000) {
    return { kind: 'card', card: learn[0], queue: 'learn' };
  }
  if (learn.length) return { kind: 'wait', until: learn[0].due };
  // Nur die gerade beantwortete Karte ist noch übrig: dann trotzdem zeigen.
  const self = q.learnCards.find((c) => c.id === excludeId);
  if (self) {
    if (self.due <= now + learnAheadSecs * 1000) return { kind: 'card', card: self, queue: 'learn' };
    return { kind: 'wait', until: self.due };
  }
  return { kind: 'done' };
}

/** Welche Zählerart eine Karte gerade belegt. */
export function queueKind(c: Card): 'new' | 'learn' | 'review' {
  if (c.queue === Queue.New) return 'new';
  if (c.queue === Queue.Learning || c.ctype === CardType.Relearning) return 'learn';
  return 'review';
}
