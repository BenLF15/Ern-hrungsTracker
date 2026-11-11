// Datums- und Zeit-Hilfen in deutscher Zeit (Europe/Berlin).
export const TZ = "Europe/Berlin";

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** Teile der Berliner Ortszeit für einen Zeitpunkt. */
export function berlinParts(date = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, weekday: isoWeekday(`${p.year}-${p.month}-${p.day}`) };
}
export const todayBerlin = () => berlinParts().date;

/** Montag = 1 … Sonntag = 7 */
export function isoWeekday(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}
export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
}
export const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z"));

/** Berliner Ortszeit (Datum + HH:MM) -> UTC-Date. */
export function berlinToUtc(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = berlinParts(new Date(guess));
    const shown = Date.UTC(...p.date.split("-").map((v, k) => (k === 1 ? Number(v) - 1 : Number(v))), ...p.time.split(":").map(Number));
    guess += Date.UTC(y, m - 1, d, hh, mm) - shown;
  }
  return new Date(guess);
}
/** Montag der Woche, in der dateStr liegt. */
export const weekStart = (dateStr) => addDays(dateStr, 1 - isoWeekday(dateStr));
