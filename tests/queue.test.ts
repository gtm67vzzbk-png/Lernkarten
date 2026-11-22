process.env.TZ = 'Europe/Berlin';

import { describe, expect, it } from 'vitest';
import { buildQueues, buildTree, countsOf, findNode, pickNext, type DailyDone } from '../src/sched/queue';
import { CardType, Queue, type Card } from '../src/sched/types';
import { dayNumber } from '../src/sched/time';

const NOW = new Date(2026, 10, 22, 14, 0, 0).getTime();
const TODAY = dayNumber(NOW);

let n = 0;
function card(deckId: string, kind: 'new' | 'review' | 'learn', extra: Partial<Card> = {}): Card {
  n++;
  const base: Card = {
    id: `c${n}`, deckId, noteGuid: `g${n}`, ord: 0, fields: ['F', 'A'], cloze: false, mod: 0,
    ctype: CardType.New, queue: Queue.New, due: n, ivl: 0, factor: 0, reps: 0, lapses: 0, step: 0,
  };
  if (kind === 'review') Object.assign(base, { ctype: CardType.Review, queue: Queue.Review, due: TODAY, ivl: 5, factor: 2500 });
  if (kind === 'learn') Object.assign(base, { ctype: CardType.Learning, queue: Queue.Learning, due: NOW - 1000, factor: 2500 });
  return { ...base, ...extra };
}

const ctx = (done: Record<string, Partial<DailyDone>> = {}, limits = { newPerDay: 20, reviewsPerDay: 200 }) => ({
  now: NOW,
  limits,
  done: (id: string) => ({ newDone: 0, revDone: 0, ...done[id] }),
});

describe('Stapelbaum', () => {
  it('baut Unterstapel aus "::"-Namen und sortiert natürlich', () => {
    const tree = buildTree(['3. Semester::Wirtschaftsrecht', '3. Semester::BWL', '10. Semester', '2. Semester'], []);
    expect(tree.map((t) => t.name)).toEqual(['2. Semester', '3. Semester', '10. Semester']);
    const sem3 = findNode(tree, '3. Semester')!;
    expect(sem3.children.map((c) => c.name)).toEqual(['BWL', 'Wirtschaftsrecht']);
    expect(sem3.children[0].depth).toBe(1);
  });
});

describe('Tageslimits', () => {
  it('höchstens 20 neue Karten pro Tag', () => {
    const cards = Array.from({ length: 30 }, () => card('A', 'new'));
    const node = buildTree(['A'], cards)[0];
    expect(countsOf(buildQueues(node, ctx())).newCount).toBe(20);
    expect(countsOf(buildQueues(node, ctx({ A: { newDone: 15 } }))).newCount).toBe(5);
    expect(countsOf(buildQueues(node, ctx({ A: { newDone: 25 } }))).newCount).toBe(0);
  });

  it('höchstens 200 Wiederholungen pro Tag, nur fällige', () => {
    const cards = [
      ...Array.from({ length: 250 }, () => card('A', 'review')),
      card('A', 'review', { due: TODAY + 1 }),
    ];
    const node = buildTree(['A'], cards)[0];
    expect(countsOf(buildQueues(node, ctx())).reviewCount).toBe(200);
  });

  it('Limit des Elternstapels begrenzt auch die Unterstapel', () => {
    const cards = [...Array.from({ length: 15 }, () => card('P::A', 'new')), ...Array.from({ length: 15 }, () => card('P::B', 'new'))];
    const tree = buildTree(['P::A', 'P::B'], cards);
    const p = findNode(tree, 'P')!;
    expect(countsOf(buildQueues(p, ctx())).newCount).toBe(20);
    expect(countsOf(buildQueues(findNode(tree, 'P::A')!, ctx())).newCount).toBe(15);
    expect(countsOf(buildQueues(p, ctx({ P: { newDone: 18 } }))).newCount).toBe(2);
  });

  it('Lernkarten zählen, wenn sie heute fällig sind; Gesperrte nicht', () => {
    const cards = [
      card('A', 'learn'),
      card('A', 'learn', { due: NOW + 5 * 60_000 }),
      card('A', 'learn', { due: NOW + 3 * 86_400_000 }),
      card('A', 'new', { queue: Queue.Suspended }),
    ];
    const c = countsOf(buildQueues(buildTree(['A'], cards)[0], ctx()));
    expect(c).toEqual({ newCount: 0, learnCount: 2, reviewCount: 0 });
  });
});

describe('Auswahl der nächsten Karte', () => {
  it('fällige Lernkarten zuerst, dann Wiederholungen/Neue, dann vorgezogene Lernkarten', () => {
    const l = card('A', 'learn');
    const soon = card('A', 'learn', { due: NOW + 5 * 60_000 });
    const r = card('A', 'review');
    const nw = card('A', 'new');
    const q = buildQueues(buildTree(['A'], [l, soon, r, nw])[0], ctx());
    expect(pickNext(q, NOW, 1200, 0)).toMatchObject({ kind: 'card', card: { id: l.id }, queue: 'learn' });

    const q2 = buildQueues(buildTree(['A'], [soon])[0], ctx());
    expect(pickNext(q2, NOW, 1200, 0)).toMatchObject({ kind: 'card', card: { id: soon.id } });

    const later = card('A', 'learn', { due: NOW + 60 * 60_000 });
    const q3 = buildQueues(buildTree(['A'], [later])[0], ctx());
    expect(pickNext(q3, NOW, 1200, 0)).toEqual({ kind: 'wait', until: later.due });

    expect(pickNext(buildQueues(buildTree(['A'], [])[0], ctx()), NOW, 1200, 0)).toEqual({ kind: 'done' });
  });

  it('mischt neue Karten gleichmäßig unter die Wiederholungen', () => {
    const cards = [...Array.from({ length: 10 }, () => card('A', 'review')), ...Array.from({ length: 5 }, () => card('A', 'new'))];
    const q = buildQueues(buildTree(['A'], cards)[0], ctx());
    const kinds = Array.from({ length: 6 }, (_, i) => (pickNext(q, NOW, 1200, i) as { queue: string }).queue);
    expect(kinds).toEqual(['review', 'review', 'new', 'review', 'review', 'new']);
  });
});
