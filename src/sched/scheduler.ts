/**
 * SM-2-Planer nach dem Vorbild von Anki (v3-Planer, Standardoptionen).
 * Alle Funktionen sind rein: sie verändern die übergebene Karte nicht.
 */
import { CardType, DEFAULT_CONFIG, Queue, type Ease, type SchedConfig, type SchedState } from './types';
import { dayNumber } from './time';

const DAY_SECS = 86_400;

export interface AnswerResult {
  state: SchedState;
  /** Zeit bis zur nächsten Fälligkeit in Sekunden (für die Anzeige über dem Button). */
  secs: number;
}

// ---------------------------------------------------------------- Fuzz

const FUZZ_RANGES = [
  { start: 2.5, end: 7, factor: 0.15 },
  { start: 7, end: 20, factor: 0.1 },
  { start: 20, end: Number.MAX_VALUE, factor: 0.05 },
];

/** Breite des Zufallsbereichs um ein Intervall (wie Anki). */
export function fuzzDelta(interval: number): number {
  if (interval < 2.5) return 0;
  return FUZZ_RANGES.reduce(
    (delta, r) => delta + r.factor * Math.max(0, Math.min(interval, r.end) - r.start),
    1,
  );
}

/** Untere/obere Grenze des Fuzz-Bereichs, eingeschränkt auf [minimum, maximum]. */
export function constrainedFuzzBounds(interval: number, minimum: number, maximum: number): [number, number] {
  minimum = Math.min(minimum, maximum);
  interval = Math.min(Math.max(interval, minimum), maximum);
  const delta = fuzzDelta(interval);
  let lower = Math.round(interval - delta);
  let upper = Math.round(interval + delta);
  lower = Math.min(Math.max(lower, minimum), maximum);
  upper = Math.min(Math.max(upper, minimum), maximum);
  if (upper === lower && upper > 2 && upper < maximum) upper = lower + 1;
  return [lower, upper];
}

/** Deterministischer Zufallswert in [0,1) – gleiche Karte + gleiche Wiederholungszahl = gleicher Wert. */
export function fuzzFactor(seedText: string, reps: number): number {
  let h = 2166136261 ^ reps;
  const s = `${seedText}#${reps}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // mulberry32-Schritt für gute Verteilung
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- Planer

export class Scheduler {
  constructor(public config: SchedConfig = DEFAULT_CONFIG) {}

  private reviewIvl(interval: number, minimum: number, fuzz: number | null): number {
    const c = this.config;
    interval *= c.intervalModifier;
    const min = Math.min(Math.max(minimum, 1), c.maxIvl);
    if (fuzz === null || !c.fuzz) return Math.min(Math.max(Math.round(interval), min), c.maxIvl);
    const [lower, upper] = constrainedFuzzBounds(interval, min, c.maxIvl);
    return Math.floor(lower + fuzz * (1 + upper - lower));
  }

  /** Die drei Intervalle (Schwer, Gut, Einfach) für eine Wiederholungskarte. */
  passingIntervals(card: SchedState, today: number, fuzz: number | null): [number, number, number] {
    const c = this.config;
    const cur = Math.max(card.ivl, 1);
    const daysLate = Math.max(0, today - card.due);
    const ease = card.factor / 1000;
    const hardMin = c.hardFactor <= 1 ? 0 : cur + 1;
    const hard = this.reviewIvl(cur * c.hardFactor, hardMin, fuzz);
    const goodMin = c.hardFactor <= 1 ? cur + 1 : hard + 1;
    const good = this.reviewIvl((cur + daysLate / 2) * ease, goodMin, fuzz);
    const easy = this.reviewIvl((cur + daysLate) * ease * c.easyBonus, good + 1, fuzz);
    return [hard, good, easy];
  }

  /** Verzögerung (Minuten) für "Schwer" im aktuellen Lernschritt. */
  private hardDelay(steps: number[], step: number): number {
    if (step === 0) {
      if (steps.length > 1) return (steps[0] + steps[1]) / 2;
      return Math.min(steps[0] * 1.5, steps[0] + 1440);
    }
    return steps[step];
  }

  private toReview(card: SchedState, ivl: number, today: number): SchedState {
    return {
      ...card,
      ctype: CardType.Review,
      queue: Queue.Review,
      ivl,
      due: today + ivl,
      step: 0,
      factor: card.factor || this.config.startingEase,
    };
  }

  private learnStepResult(card: SchedState, ctype: CardType, step: number, delayMin: number, now: number): AnswerResult {
    const secs = Math.round(delayMin * 60);
    return {
      state: { ...card, ctype, queue: Queue.Learning, step, due: now + secs * 1000 },
      secs,
    };
  }

  /**
   * Berechnet den neuen Zustand einer Karte nach einer Antwort.
   * @param seed Text für den deterministischen Fuzz (z. B. Karten-ID).
   */
  answer(card: SchedState, ease: Ease, now: number, seed = ''): AnswerResult {
    const c = this.config;
    const today = dayNumber(now);
    const base: SchedState = { ...card, reps: card.reps + 1 };
    const fuzz = fuzzFactor(seed, card.reps);

    // --- Neu oder in Lernschritten
    if (card.ctype === CardType.New || card.ctype === CardType.Learning) {
      const steps = c.learnSteps;
      const step = card.ctype === CardType.New ? 0 : Math.min(card.step, steps.length - 1);
      const learning = { ...base, factor: card.factor || c.startingEase };
      if (steps.length === 0 && ease !== 4) ease = 3;
      switch (ease) {
        case 1:
          return this.learnStepResult(learning, CardType.Learning, 0, steps[0], now);
        case 2:
          return this.learnStepResult(learning, CardType.Learning, step, this.hardDelay(steps, step), now);
        case 3:
          if (step + 1 < steps.length) {
            return this.learnStepResult(learning, CardType.Learning, step + 1, steps[step + 1], now);
          }
          return { state: this.toReview(learning, c.graduatingIvl, today), secs: c.graduatingIvl * DAY_SECS };
        case 4:
          return { state: this.toReview(learning, c.easyIvl, today), secs: c.easyIvl * DAY_SECS };
      }
    }

    // --- Wiederlernen nach "Nochmal"
    if (card.ctype === CardType.Relearning) {
      const steps = c.relearnSteps;
      const step = Math.min(card.step, Math.max(steps.length - 1, 0));
      if (steps.length > 0) {
        if (ease === 1) return this.learnStepResult(base, CardType.Relearning, 0, steps[0], now);
        if (ease === 2) return this.learnStepResult(base, CardType.Relearning, step, this.hardDelay(steps, step), now);
        if (ease === 3 && step + 1 < steps.length) {
          return this.learnStepResult(base, CardType.Relearning, step + 1, steps[step + 1], now);
        }
      }
      const ivl = ease === 4 ? card.ivl + 1 : card.ivl;
      const clamped = Math.min(Math.max(ivl, 1), c.maxIvl);
      return { state: this.toReview(base, clamped, today), secs: clamped * DAY_SECS };
    }

    // --- Wiederholungskarte
    if (ease === 1) {
      const factor = Math.max(c.minEase, card.factor - 200);
      const ivl = Math.min(Math.max(c.minLapseIvl, Math.round(card.ivl * c.lapseMult)), c.maxIvl);
      const lapsed: SchedState = { ...base, factor, ivl, lapses: card.lapses + 1 };
      if (c.relearnSteps.length === 0) {
        return { state: this.toReview(lapsed, ivl, today), secs: ivl * DAY_SECS };
      }
      return this.learnStepResult(lapsed, CardType.Relearning, 0, c.relearnSteps[0], now);
    }
    const [hard, good, easy] = this.passingIntervals(card, today, fuzz);
    let factor = card.factor;
    let ivl = good;
    if (ease === 2) {
      factor = Math.max(c.minEase, factor - 150);
      ivl = hard;
    } else if (ease === 4) {
      factor = factor + 150;
      ivl = easy;
    }
    return { state: this.toReview({ ...base, factor }, ivl, today), secs: ivl * DAY_SECS };
  }

  /** Sekunden bis zur nächsten Fälligkeit für alle vier Buttons. */
  previewSecs(card: SchedState, now: number, seed = ''): [number, number, number, number] {
    return ([1, 2, 3, 4] as Ease[]).map((e) => this.answer(card, e, now, seed).secs) as [number, number, number, number];
  }
}

// ---------------------------------------------------------------- Anzeige

function fmtNum(n: number, decimals: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}

/**
 * Formatiert eine Zeitspanne wie die Anki-Antwortbuttons, auf Deutsch:
 * "<1 Min.", "<10 Min.", "2 Std.", "4 Tg.", "1,2 Mon.", "2,5 J."
 */
export function formatInterval(secs: number, learnAheadSecs = DEFAULT_CONFIG.learnAheadSecs): string {
  let s: string;
  if (secs < 60) s = `${Math.max(1, Math.round(secs))} Sek.`;
  else if (secs < 3600) s = `${Math.round(secs / 60)} Min.`;
  else if (secs < DAY_SECS) s = `${Math.round(secs / 3600)} Std.`;
  else if (secs < 30 * DAY_SECS) s = `${Math.round(secs / DAY_SECS)} Tg.`;
  else if (secs < 365 * DAY_SECS) s = `${fmtNum(Math.round((secs / DAY_SECS / 30) * 10) / 10, 1)} Mon.`;
  else s = `${fmtNum(Math.round((secs / DAY_SECS / 365) * 10) / 10, 1)} J.`;
  return secs < learnAheadSecs ? `<${s}` : s;
}
