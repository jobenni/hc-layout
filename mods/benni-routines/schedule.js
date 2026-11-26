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
  { id: "interval", label: "Toutes les X minutes" },
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

export function startOfMinute(time) {
  return Math.floor(time / MINUTE_MS) * MINUTE_MS;
}

function parseTime(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours < 24 && minutes < 60 ? { hours, minutes } : null;
}

export const INTERVAL_MAX_MINUTES = 720;

/** The times of a daily, weekdays or weekly schedule; one written before `times` has its `time`. */
export function timesOf(schedule) {
  return Array.isArray(schedule.times) ? schedule.times : [schedule.time];
}

const timeText = ({ hours, minutes }) => `${pad2(hours)}:${pad2(minutes)}`;

/** Its times read, sorted, without repeats, or throws on the first wrong one. */
export function sortedTimes(schedule) {
  const times = timesOf(schedule).map((text) => {
    const time = parseTime(text);
    if (!time) throw new Error(`« ${text ?? ""} » : heure au format HH:MM`);
    return time;
  });
  if (!times.length) throw new Error("ajoute au moins une heure");
  return [...new Set(times.map(timeText))].sort().map(parseTime);
}

// Hours sharing the same minutes share one cron.
function cronsByMinutes(minutesOfHour, dayFields) {
  const hoursByMinutes = new Map();
  minutesOfHour.forEach((minutes, hour) => {
    if (!minutes.length) return;
    const key = minutes.join(",");
    hoursByMinutes.set(key, [...(hoursByMinutes.get(key) ?? []), hour]);
  });
  return [...hoursByMinutes].map(([minutes, hours]) => `${minutes} ${hours.length === 24 ? "*" : hours.join(",")} ${dayFields}`);
}

// Every `every` minutes counted from midnight: the last gap of a day is shorter when `every` doesn't divide 1440.
function intervalCrons(every) {
  if (!Number.isInteger(every) || every < 1 || every > INTERVAL_MAX_MINUTES) throw new Error(`intervalle entre 1 et ${INTERVAL_MAX_MINUTES} minutes`);
  if (60 % every === 0) return [`*/${every} * * * *`];
  if (every % 60 === 0 && 1440 % every === 0) return [`0 */${every / 60} * * *`];
  const minutesOfHour = Array.from({ length: 24 }, () => []);
  for (let minute = 0; minute < 1440; minute += every) minutesOfHour[Math.floor(minute / 60)].push(minute % 60);
  return cronsByMinutes(minutesOfHour, "* * *");
}

const DAY_FIELDS = { daily: "* * *", weekdays: "* * 1-5" };

/** The crons a schedule stands for (it runs when any one matches), or throws with what is wrong. */
export function scheduleCrons(schedule) {
  if (schedule.kind === "cron") {
    parseCron(schedule.cron);
    return [schedule.cron.trim()];
  }
  if (schedule.kind === "interval") return intervalCrons(Number(schedule.every));
  if (schedule.kind === "hourly") {
    const minute = Number(schedule.minute);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("minute entre 0 et 59");
    return [`${minute} * * * *`];
  }
  const dayFields = schedule.kind === "weekly" ? `* * ${Number(schedule.weekday) || 0}` : DAY_FIELDS[schedule.kind];
  if (!dayFields) throw new Error("planification inconnue");
  const minutesOfHour = Array.from({ length: 24 }, () => []);
  for (const { hours, minutes } of sortedTimes(schedule)) minutesOfHour[hours].push(minutes);
  return cronsByMinutes(minutesOfHour, dayFields);
}

/** A schedule ready to match: any of its crons. Throws like scheduleCrons. */
export function compileSchedule(schedule) {
  const crons = scheduleCrons(schedule).map(parseCron);
  const next = (after) => crons.map((cron) => nextOccurrence(cron, after)).filter(Boolean)
    .reduce((earliest, date) => (!earliest || date < earliest ? date : earliest), null);
  return {
    /** `wall`: a wall-clock Date (see toWall). */
    matches: (wall) => crons.some((cron) => cronMatches(cron, wall)),
    /** The first matching wall-clock minute strictly after the wall-clock `after`, or null. */
    next,
    /** Matching wall-clock minutes in (from, to), oldest first, at most `cap`. */
    between(from, to, cap) {
      const found = [];
      let cursor = from;
      while (found.length < cap) {
        const date = next(cursor);
        if (!date || date.getTime() >= to.getTime()) break;
        found.push(date);
        cursor = date;
      }
      return found;
    },
  };
}

const KINDS_WITH_TIMES = new Set(["daily", "weekdays", "weekly"]);

/** As saved: times sorted without repeats, `time` their first (read by older versions), and the cron
 * "Avancé" opens on when it is a single one. Expects a valid schedule. */
export function normalizeSchedule(schedule) {
  const normalized = { ...schedule };
  if (KINDS_WITH_TIMES.has(schedule.kind)) {
    normalized.times = sortedTimes(schedule).map(timeText);
    normalized.time = normalized.times[0];
  }
  const crons = scheduleCrons(normalized);
  if (crons.length === 1) normalized.cron = crons[0];
  return normalized;
}

export function scheduleError(schedule) {
  try { scheduleCrons(schedule); return null; } catch (error) { return error.message; }
}

function describeTimes(schedule) {
  try { return sortedTimes(schedule).map(timeText).join(", "); } catch { return timesOf(schedule).join(", "); }
}

function describeInterval(every) {
  if (every % 60 === 0) return every === 60 ? "Toutes les heures" : `Toutes les ${every / 60} h`;
  return every > 60 ? `Toutes les ${Math.floor(every / 60)} h ${pad2(every % 60)}` : `Toutes les ${every} min`;
}

export function describeSchedule(schedule) {
  const at = describeTimes(schedule);
  switch (schedule.kind) {
    case "interval": return describeInterval(Number(schedule.every));
    case "hourly": return `Toutes les heures à :${pad2(schedule.minute)}`;
    case "daily": return `Chaque jour à ${at}`;
    case "weekdays": return `Jours ouvrés à ${at}`;
    case "weekly": return `Chaque ${WEEKDAYS.find((d) => d.day === Number(schedule.weekday))?.long ?? "semaine"} à ${at}`;
    default: return schedule.cron?.trim() === "* * * * *" ? "Chaque minute" : `Cron ${schedule.cron}`;
  }
}

/** The next real time a schedule runs on a machine with `machineClock`, or null. */
export function nextRunOf(schedule, machineClock = localClock, after = Date.now()) {
  try {
    const wall = compileSchedule(schedule).next(machineClock.toWall(after));
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
