/** Kartentyp wie in Anki. */
export const CardType = { New: 0, Learning: 1, Review: 2, Relearning: 3 } as const;
export type CardType = (typeof CardType)[keyof typeof CardType];

/** Warteschlange wie in Anki (vereinfacht). */
export const Queue = { Suspended: -1, New: 0, Learning: 1, Review: 2 } as const;
export type Queue = (typeof Queue)[keyof typeof Queue];

export type Ease = 1 | 2 | 3 | 4; // Nochmal, Schwer, Gut, Einfach

export interface SchedState {
  ctype: CardType;
  queue: Queue;
  /**
   * Neu: Position in der Reihenfolge.
   * Lernen/Wiederlernen: Zeitstempel (ms), ab wann die Karte fällig ist.
   * Wiederholen: Lerntag-Nummer (siehe time.ts).
   */
  due: number;
  /** Intervall in Tagen (für Wiederholungskarten). */
  ivl: number;
  /** Ease in Promille (2500 = 250 %). */
  factor: number;
  reps: number;
  lapses: number;
  /** Index des aktuellen Lern- bzw. Wiederlernschritts. */
  step: number;
}

export interface Card extends SchedState {
  /** Eindeutige ID (aus Notiz-GUID und Kartennummer). */
  id: string;
  deckId: string;
  noteGuid: string;
  /** Kartennummer innerhalb der Notiz (0 = Vorderseite, 1 = umgekehrt …). */
  ord: number;
  fields: string[];
  /** Lückentext-Notiz ({{c1::…}}). */
  cloze: boolean;
  /** Letzte Änderung (ms). */
  mod: number;
}

export interface SchedConfig {
  learnSteps: number[]; // Minuten
  relearnSteps: number[]; // Minuten
  graduatingIvl: number; // Tage
  easyIvl: number; // Tage
  startingEase: number; // Promille
  easyBonus: number;
  hardFactor: number;
  intervalModifier: number;
  maxIvl: number;
  lapseMult: number; // neues Intervall nach "Nochmal" (0 = Minimum)
  minLapseIvl: number;
  minEase: number;
  /** Lernkarten, die innerhalb dieser Zeit fällig werden, dürfen vorgezogen werden (Sek.). */
  learnAheadSecs: number;
  fuzz: boolean;
}

export const DEFAULT_CONFIG: SchedConfig = {
  learnSteps: [1, 10],
  relearnSteps: [10],
  graduatingIvl: 1,
  easyIvl: 4,
  startingEase: 2500,
  easyBonus: 1.3,
  hardFactor: 1.2,
  intervalModifier: 1,
  maxIvl: 36500,
  lapseMult: 0,
  minLapseIvl: 1,
  minEase: 1300,
  learnAheadSecs: 1200,
  fuzz: true,
};
