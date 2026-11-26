// Five-field cron (minute hour day-of-month month day-of-week) in the local time of the routine's
// machine, and the presets the editor offers on top of it.
//
// Matching works on a machine's "wall clock": a Date whose UTC fields read that machine's local time
// (toWall), so two clients in different time zones compute the same minutes. formatWhen and
// formatDuration show real times in this client's own time.

const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MINUTE_MS = 60000;

/** This computer's clock: its own time zone, daylight saving included. */
export const localClock = {
  toWall: (time) => new Date(time - new Date(time).getTimezoneOffset() * MINUTE_MS),
  toTime(wall) {
    const guess = wall.getTime() + new Date(wall.getTime()).getTimezoneOffset() * MINUTE_MS;
    return wall.getTime() + new Date(guess).getTimezoneOffset() * MINUTE_MS;
  },
};

/** Another machine's clock, from its UTC offset in minutes (`date +%z`, read again every hour). */
export function offsetClock(offsetMinutes) {
  return {
    toWall: (time) => new Date(time + offsetMinutes * MINUTE_MS),
    toTime: (wall) => wall.getTime() - offsetMinutes * MINUTE_MS,
  };
}

/** "+0100" -> 60, "-0430" -> -270, or null. */
export function parseUtcOffset(text) {
  const match = /^([+-])(\d\d)(\d\d)$/.exec((text ?? "").trim());
  if (!match) return null;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}
const SEARCH_LIMIT_DAYS = 366 * 5;

export const PRESETS = [
  { id: "hourly", label: "Toutes les heures" },
  { id: "daily", label: "Chaque jour" },
  { id: "weekdays", label: "Jours ouvrés" },
  { id: "weekly", label: "Chaque semaine" },
  { id: "cron", label: "Avancé (cron)" },
];

export const WEEKDAYS = [
  { day: 1, short: "L", long: "lundi" },
  { day: 2, short: "M", long: "mardi" },
  { day: 3, short: "M", long: "mercredi" },
  { day: 4, short: "J", long: "jeudi" },
  { day: 5, short: "V", long: "vendredi" },
  { day: 6, short: "S", long: "samedi" },
  { day: 0, short: "D", long: "dimanche" },
];

const MONTH_NAMES = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const DAY_NAMES = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

function parseField(text, [min, max]) {
  const values = new Set();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`« ${part} » n'est pas compris`);
    const [, range, stepText] = match;
    const step = stepText ? Number(stepText) : 1;
    if (step < 1) throw new Error(`pas invalide dans « ${part} »`);
    let [from, to] = range === "*" ? [min, max] : range.split("-").map(Number);
    if (to === undefined) to = stepText ? max : from;
    if (from < min || to > max || from > to) throw new Error(`« ${part} » sort de ${min}-${max}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** @returns {{minutes: Set<number>, hours: Set<number>, days: Set<number>, months: Set<number>, weekdays: Set<number>, anyDay: boolean, anyWeekday: boolean}} */
export function parseCron(expression) {
  const fields = (expression ?? "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("il faut 5 champs : minute heure jour mois jour-de-semaine");
  const [minutes, hours, days, months, weekdays] = fields.map((field, index) => parseField(field, FIELD_RANGES[index]));
  if (weekdays.delete(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, anyDay: fields[2] === "*", anyWeekday: fields[4] === "*" };
}

export function cronError(expression) {
  try { parseCron(expression); return null; } catch (error) { return error.message; }
}

// As in cron: when both the day of month and the day of week are restricted, either one matches.
function dayMatches(cron, wall) {
  const byDay = cron.days.has(wall.getUTCDate());
  const byWeekday = cron.weekdays.has(wall.getUTCDay());
  if (cron.anyDay) return byWeekday;
  if (cron.anyWeekday) return byDay;
  return byDay || byWeekday;
}

/** `wall`: a wall-clock Date (see toWall). */
export function cronMatches(cron, wall) {
  return cron.minutes.has(wall.getUTCMinutes()) && cron.hours.has(wall.getUTCHours())
    && cron.months.has(wall.getUTCMonth() + 1) && dayMatches(cron, wall);
}

/** The first matching wall-clock minute strictly after the wall-clock `after`, or null. */
export function nextOccurrence(cron, after) {
  const date = new Date(after.getTime());
  date.setUTCSeconds(0, 0);
  date.setUTCMinutes(date.getUTCMinutes() + 1);
  const limit = after.getTime() + SEARCH_LIMIT_DAYS * 86400000;
  while (date.getTime() < limit) {
    if (!cron.months.has(date.getUTCMonth() + 1)) { date.setUTCMonth(date.getUTCMonth() + 1, 1); date.setUTCHours(0, 0); continue; }
    if (!dayMatches(cron, date)) { date.setUTCDate(date.getUTCDate() + 1); date.setUTCHours(0, 0); continue; }
    if (!cron.hours.has(date.getUTCHours())) { date.setUTCHours(date.getUTCHours() + 1, 0); continue; }
    if (!cron.minutes.has(date.getUTCMinutes())) { date.setUTCMinutes(date.getUTCMinutes() + 1); continue; }
    return date;
  }
  return null;
}

/** Matching wall-clock minutes in (from, to), oldest first, at most `cap`. */
export function occurrencesBetween(cron, from, to, cap) {
  const found = [];
  let cursor = from;
  while (found.length < cap) {
    const next = nextOccurrence(cron, cursor);
    if (!next || next.getTime() >= to.getTime()) break;
    found.push(next);
    cursor = next;
  }
  return found;
}

export function startOfMinute(time) {
  return Math.floor(time / MINUTE_MS) * MINUTE_MS;
}

function parseTime(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours < 24 && minutes < 60 ? { hours, minutes } : null;
}

/** The cron a schedule stands for, or throws with what is wrong. */
export function scheduleCron(schedule) {
  if (schedule.kind === "cron") {
    parseCron(schedule.cron);
    return schedule.cron.trim();
  }
  if (schedule.kind === "hourly") {
    const minute = Number(schedule.minute);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("minute entre 0 et 59");
    return `${minute} * * * *`;
  }
  const time = parseTime(schedule.time);
  if (!time) throw new Error("heure au format HH:MM");
  const at = `${time.minutes} ${time.hours}`;
  if (schedule.kind === "daily") return `${at} * * *`;
  if (schedule.kind === "weekdays") return `${at} * * 1-5`;
  if (schedule.kind === "weekly") return `${at} * * ${Number(schedule.weekday) || 0}`;
  throw new Error("planification inconnue");
}

export function scheduleError(schedule) {
  try { scheduleCron(schedule); return null; } catch (error) { return error.message; }
}

export function describeSchedule(schedule) {
  const time = parseTime(schedule.time);
  const at = time ? `${String(time.hours).padStart(2, "0")}:${String(time.minutes).padStart(2, "0")}` : schedule.time;
  switch (schedule.kind) {
    case "hourly": return `Toutes les heures à :${String(schedule.minute).padStart(2, "0")}`;
    case "daily": return `Chaque jour à ${at}`;
    case "weekdays": return `Jours ouvrés à ${at}`;
    case "weekly": return `Chaque ${WEEKDAYS.find((d) => d.day === Number(schedule.weekday))?.long ?? "semaine"} à ${at}`;
    default: return schedule.cron?.trim() === "* * * * *" ? "Chaque minute" : `Cron ${schedule.cron}`;
  }
}

/** The next real time a schedule runs on a machine with `machineClock`, or null. */
export function nextRunOf(schedule, machineClock = localClock, after = Date.now()) {
  try {
    const wall = nextOccurrence(parseCron(scheduleCron(schedule)), machineClock.toWall(after));
    return wall ? new Date(machineClock.toTime(wall)) : null;
  } catch { return null; }
}

const pad2 = (n) => String(n).padStart(2, "0");
const localClockText = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
/** "14:05" on a wall-clock Date. */
const clock = (wall) => `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}`;

/** "aujourd'hui 14:05", "demain 09:00", "lun. 3 déc. 09:00". */
export function formatWhen(time, now = new Date()) {
  const date = new Date(time);
  const dayDiff = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
  if (dayDiff === 0) return `aujourd'hui ${localClockText(date)}`;
  if (dayDiff === 1) return `demain ${localClockText(date)}`;
  if (dayDiff === -1) return `hier ${localClockText(date)}`;
  const year = date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : "";
  return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}${year} ${localClockText(date)}`;
}

export function formatDuration(ms) {
  if (!(ms >= 0)) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad2(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
}

/** "20261126-0905" on a wall-clock Date. */
export function compactStamp(wall) {
  return `${wall.getUTCFullYear()}${pad2(wall.getUTCMonth() + 1)}${pad2(wall.getUTCDate())}-${pad2(wall.getUTCHours())}${pad2(wall.getUTCMinutes())}`;
}

export { clock };
