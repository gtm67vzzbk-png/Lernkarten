/** Stunde, zu der ein neuer Lerntag beginnt (wie Anki: 4 Uhr nachts). */
export const ROLLOVER_HOUR = 4;

const DAY_MS = 86_400_000;

/** Tagesnummer eines lokalen Kalenderdatums (Tage seit 1970-01-01). */
function calendarDayIndex(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/**
 * Lerntag eines Zeitpunkts. Ein Lerntag beginnt um 4:00 Uhr Ortszeit;
 * 2:00 Uhr nachts gehört also noch zum Vortag.
 */
export function dayNumber(ts: number, rolloverHour = ROLLOVER_HOUR): number {
  const d = new Date(ts);
  const idx = calendarDayIndex(d);
  return d.getHours() < rolloverHour ? idx - 1 : idx;
}

/** Kalendertag (ohne 4-Uhr-Verschiebung) – so rechnet Anki das Erstelldatum der Sammlung. */
export function calendarDay(ts: number): number {
  return calendarDayIndex(new Date(ts));
}

/** Zeitpunkt, an dem der gegebene Lerntag beginnt (lokal, 4:00 Uhr). */
export function dayStart(day: number, rolloverHour = ROLLOVER_HOUR): number {
  const utc = new Date(day * DAY_MS);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), rolloverHour).getTime();
}

/** Zeitpunkt, an dem der nächste Lerntag beginnt. */
export function nextDayStart(ts: number): number {
  return dayStart(dayNumber(ts) + 1);
}
