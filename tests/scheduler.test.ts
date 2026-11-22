process.env.TZ = 'Europe/Berlin';

import { describe, expect, it } from 'vitest';
import { constrainedFuzzBounds, formatInterval, fuzzDelta, Scheduler } from '../src/sched/scheduler';
import { CardType, DEFAULT_CONFIG, Queue, type SchedState } from '../src/sched/types';
import { dayNumber, dayStart, nextDayStart } from '../src/sched/time';

const NOW = new Date(2026, 10, 22, 14, 0, 0).getTime(); // 22.11.2026, 14:00 Uhr
const TODAY = dayNumber(NOW);

const plain = new Scheduler({ ...DEFAULT_CONFIG, fuzz: false });
const fuzzy = new Scheduler();

function newCard(): SchedState {
  return { ctype: CardType.New, queue: Queue.New, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0, step: 0 };
}

function reviewCard(ivl: number, factor = 2500, due = TODAY): SchedState {
  return { ctype: CardType.Review, queue: Queue.Review, due, ivl, factor, reps: 5, lapses: 0, step: 0 };
}

describe('Lerntag (Tageswechsel um 4 Uhr)', () => {
  it('03:59 gehört zum Vortag, 04:00 zum neuen Tag', () => {
    const a = new Date(2026, 10, 23, 3, 59).getTime();
    const b = new Date(2026, 10, 23, 4, 0).getTime();
    expect(dayNumber(a)).toBe(TODAY);
    expect(dayNumber(b)).toBe(TODAY + 1);
  });

  it('dayStart liefert 4:00 Uhr Ortszeit, auch über die Zeitumstellung', () => {
    expect(new Date(dayStart(TODAY)).getHours()).toBe(4);
    const summer = dayNumber(new Date(2026, 2, 29, 12).getTime()); // Tag der Umstellung auf Sommerzeit
    expect(new Date(dayStart(summer)).getHours()).toBe(4);
    expect(new Date(dayStart(summer + 1)).getHours()).toBe(4);
    expect(nextDayStart(NOW)).toBe(new Date(2026, 10, 23, 4).getTime());
  });
});

describe('Anzeige der Intervalle', () => {
  it('formatiert wie Anki, auf Deutsch', () => {
    expect(formatInterval(60)).toBe('<1 Min.');
    expect(formatInterval(330)).toBe('<6 Min.');
    expect(formatInterval(600)).toBe('<10 Min.');
    expect(formatInterval(900)).toBe('<15 Min.');
    expect(formatInterval(1500)).toBe('25 Min.');
    expect(formatInterval(3 * 3600)).toBe('3 Std.');
    expect(formatInterval(86400)).toBe('1 Tg.');
    expect(formatInterval(2 * 86400)).toBe('2 Tg.');
    expect(formatInterval(12 * 86400)).toBe('12 Tg.');
    expect(formatInterval(36 * 86400)).toBe('1,2 Mon.');
    expect(formatInterval(60 * 86400)).toBe('2 Mon.');
    expect(formatInterval(400 * 86400)).toBe('1,1 J.');
  });
});

describe('Neue Karten und Lernschritte (1 Min., 10 Min.)', () => {
  it('liefert die richtigen Intervalle für alle vier Buttons', () => {
    expect(plain.previewSecs(newCard(), NOW)).toEqual([60, 330, 600, 4 * 86400]);
  });

  it('Nochmal: zurück auf Schritt 1, in 1 Minute', () => {
    const { state } = plain.answer(newCard(), 1, NOW);
    expect(state.ctype).toBe(CardType.Learning);
    expect(state.queue).toBe(Queue.Learning);
    expect(state.step).toBe(0);
    expect(state.due).toBe(NOW + 60_000);
    expect(state.reps).toBe(1);
  });

  it('Gut: nächster Schritt (10 Min.), danach Abschluss mit 1 Tag', () => {
    const s1 = plain.answer(newCard(), 3, NOW).state;
    expect(s1.step).toBe(1);
    expect(s1.due).toBe(NOW + 600_000);
    expect(plain.previewSecs(s1, NOW)).toEqual([60, 600, 86400, 4 * 86400]);
    const s2 = plain.answer(s1, 3, NOW + 600_000).state;
    expect(s2.ctype).toBe(CardType.Review);
    expect(s2.queue).toBe(Queue.Review);
    expect(s2.ivl).toBe(1);
    expect(s2.due).toBe(TODAY + 1);
    expect(s2.factor).toBe(2500);
  });

  it('Einfach bei neuen Karten: sofort 4 Tage, Start-Ease 250 %', () => {
    const { state } = fuzzy.answer(newCard(), 4, NOW, 'x');
    expect(state.ivl).toBe(4);
    expect(state.due).toBe(TODAY + 4);
    expect(state.factor).toBe(2500);
  });

  it('Schwer bleibt im aktuellen Schritt', () => {
    const s1 = plain.answer(newCard(), 3, NOW).state; // Schritt 2
    const s2 = plain.answer(s1, 2, NOW).state;
    expect(s2.step).toBe(1);
    expect(s2.due).toBe(NOW + 600_000);
  });
});

describe('Wiederholungskarten', () => {
  it('Schwer ×1,2 / Gut ×Ease / Einfach ×Ease×1,3 (ohne Fuzz)', () => {
    expect(plain.passingIntervals(reviewCard(10), TODAY, null)).toEqual([12, 25, 33]);
  });

  it('verspätete Karten bekommen einen Bonus wie bei Anki', () => {
    // 4 Tage zu spät: Gut = (10 + 4/2) × 2,5 = 30, Einfach = (10 + 4) × 2,5 × 1,3 = 45,5
    expect(plain.passingIntervals(reviewCard(10, 2500, TODAY - 4), TODAY, null)).toEqual([12, 30, 46]);
  });

  it('Mindestabstände: Schwer ≥ Intervall+1, Gut ≥ Schwer+1, Einfach ≥ Gut+1', () => {
    expect(plain.passingIntervals(reviewCard(1), TODAY, null)).toEqual([2, 3, 4]);
    expect(plain.passingIntervals(reviewCard(1, 1300), TODAY, null)).toEqual([2, 3, 4]);
  });

  it('passt die Ease an: Schwer −15 %, Gut ±0, Einfach +15 %', () => {
    expect(plain.answer(reviewCard(10), 2, NOW).state.factor).toBe(2350);
    expect(plain.answer(reviewCard(10), 3, NOW).state.factor).toBe(2500);
    expect(plain.answer(reviewCard(10), 4, NOW).state.factor).toBe(2650);
    expect(plain.answer(reviewCard(10, 1350), 2, NOW).state.factor).toBe(1300);
  });

  it('setzt Fälligkeit = heute + Intervall', () => {
    const { state, secs } = plain.answer(reviewCard(10), 3, NOW);
    expect(state.ivl).toBe(25);
    expect(state.due).toBe(TODAY + 25);
    expect(secs).toBe(25 * 86400);
  });

  it('Nochmal: Ease −20 %, Wiederlernen in 10 Min., neues Intervall 1 Tag', () => {
    const { state, secs } = plain.answer(reviewCard(30), 1, NOW);
    expect(secs).toBe(600);
    expect(formatInterval(secs)).toBe('<10 Min.');
    expect(state.ctype).toBe(CardType.Relearning);
    expect(state.queue).toBe(Queue.Learning);
    expect(state.factor).toBe(2300);
    expect(state.lapses).toBe(1);
    expect(state.ivl).toBe(1);
    expect(state.due).toBe(NOW + 600_000);
  });

  it('Ease fällt nie unter 130 %', () => {
    expect(plain.answer(reviewCard(30, 1400), 1, NOW).state.factor).toBe(1300);
    expect(plain.answer(reviewCard(30, 1300), 1, NOW).state.factor).toBe(1300);
  });

  it('Wiederlernen: Gut → zurück in die Wiederholung mit 1 Tag, Schwer → 15 Min., Einfach → 2 Tage', () => {
    const lapsed = plain.answer(reviewCard(30), 1, NOW).state;
    expect(plain.previewSecs(lapsed, NOW)).toEqual([600, 900, 86400, 2 * 86400]);
    const back = plain.answer(lapsed, 3, NOW + 600_000).state;
    expect(back.ctype).toBe(CardType.Review);
    expect(back.ivl).toBe(1);
    expect(back.due).toBe(TODAY + 1);
    expect(back.factor).toBe(2300); // keine zweite Ease-Strafe
  });

  it('Beispiel aus der Aufgabe: Buttons zeigen z. B. „<10 Min.“, „2 Tg.“ …', () => {
    const labels = plain.previewSecs(reviewCard(1), NOW).map((s) => formatInterval(s));
    expect(labels).toEqual(['<10 Min.', '2 Tg.', '3 Tg.', '4 Tg.']);
    const labels2 = plain.previewSecs(reviewCard(14), NOW).map((s) => formatInterval(s));
    expect(labels2).toEqual(['<10 Min.', '17 Tg.', '1,2 Mon.', '1,5 Mon.']);
  });

  it('maximales Intervall 100 Jahre', () => {
    expect(plain.answer(reviewCard(36000, 3000), 4, NOW).state.ivl).toBe(36500);
  });
});

describe('Fuzz (Zufallsfaktor)', () => {
  it('Fuzz-Breite wie Anki', () => {
    expect(fuzzDelta(2)).toBe(0);
    expect(fuzzDelta(5)).toBeCloseTo(1.375);
    expect(fuzzDelta(250)).toBeCloseTo(14.475);
    expect(constrainedFuzzBounds(250, 1, 36500)).toEqual([236, 264]);
    expect(constrainedFuzzBounds(3, 2, 36500)).toEqual([2, 4]);
  });

  it('bleibt in den Grenzen, streut und ist pro Karte reproduzierbar', () => {
    const results = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const seed = `karte-${i}`;
      const a = fuzzy.answer(reviewCard(100), 3, NOW, seed).state.ivl;
      const b = fuzzy.answer(reviewCard(100), 3, NOW, seed).state.ivl;
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(236);
      expect(a).toBeLessThanOrEqual(264);
      results.add(a);
    }
    expect(results.size).toBeGreaterThan(15);
  });

  it('Vorschau über dem Button = tatsächliches Ergebnis', () => {
    const card = reviewCard(20);
    const preview = fuzzy.previewSecs(card, NOW, 'abc');
    for (const ease of [2, 3, 4] as const) {
      expect(fuzzy.answer(card, ease, NOW, 'abc').secs).toBe(preview[ease - 1]);
    }
  });

  it('auch mit Fuzz gilt: Schwer < Gut < Einfach', () => {
    for (let i = 0; i < 200; i++) {
      const [h, g, e] = fuzzy.passingIntervals(reviewCard(1 + (i % 40)), TODAY, (i * 0.137) % 1);
      expect(h).toBeLessThan(g);
      expect(g).toBeLessThan(e);
      expect(h).toBeGreaterThan(1 + (i % 40));
    }
  });
});
