// Five-field cron (minute hour day-of-month month day-of-week), local time, and the presets the
// editor offers on top of it.

const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MINUTE_MS = 60000;
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
function dayMatches(cron, date) {
  const byDay = cron.days.has(date.getDate());
  const byWeekday = cron.weekdays.has(date.getDay());
  if (cron.anyDay) return byWeekday;
  if (cron.anyWeekday) return byDay;
  return byDay || byWeekday;
}

export function cronMatches(cron, date) {
  return cron.minutes.has(date.getMinutes()) && cron.hours.has(date.getHours())
    && cron.months.has(date.getMonth() + 1) && dayMatches(cron, date);
}

/** The first matching minute strictly after `after`, or null. */
export function nextOccurrence(cron, after) {
  const date = new Date(after.getTime());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after.getTime() + SEARCH_LIMIT_DAYS * 86400000;
  while (date.getTime() < limit) {
    if (!cron.months.has(date.getMonth() + 1)) { date.setMonth(date.getMonth() + 1, 1); date.setHours(0, 0); continue; }
    if (!dayMatches(cron, date)) { date.setDate(date.getDate() + 1); date.setHours(0, 0); continue; }
    if (!cron.hours.has(date.getHours())) { date.setHours(date.getHours() + 1, 0); continue; }
    if (!cron.minutes.has(date.getMinutes())) { date.setMinutes(date.getMinutes() + 1); continue; }
    return date;
  }
  return null;
}

/** Matching minutes in (from, to), oldest first, at most `cap`. */
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

export function minuteKey(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

export function nextRunOf(schedule, after = new Date()) {
  try { return nextOccurrence(parseCron(scheduleCron(schedule)), after); } catch { return null; }
}

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

/** "aujourd'hui 14:05", "demain 09:00", "lun. 3 déc. 09:00". */
export function formatWhen(time, now = new Date()) {
  const date = new Date(time);
  const dayDiff = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
  if (dayDiff === 0) return `aujourd'hui ${clock(date)}`;
  if (dayDiff === 1) return `demain ${clock(date)}`;
  if (dayDiff === -1) return `hier ${clock(date)}`;
  const year = date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : "";
  return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}${year} ${clock(date)}`;
}

export function formatDuration(ms) {
  if (!(ms >= 0)) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad2(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
}

export function compactStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

export { clock };
