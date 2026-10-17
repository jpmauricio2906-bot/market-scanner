// Calendar and time-zone decisions shared by the scheduled close reader and tests.
const ZONE = 'America/New_York';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function newYorkParts(now = Date.now()) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('SCHEDULE_TIME_INVALID');
  const parts = Object.fromEntries(formatter.formatToParts(instant).filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}
export function auditInstant(sessionDate) {
  if (!validDate(sessionDate)) throw new Error('SESSION_INVALID');
  const desired = Date.parse(`${sessionDate}T20:30:00Z`);
  let instant = desired;
  for (let pass = 0; pass < 3; pass++) {
    const local = newYorkParts(instant);
    const represented = Date.parse(`${local.date}T${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}:00Z`);
    const adjustment = desired - represented;
    instant += adjustment;
    if (!adjustment) break;
  }
  const actual = newYorkParts(instant);
  if (actual.date !== sessionDate || actual.hour !== 20 || actual.minute !== 30) throw new Error('SCHEDULE_TIME_INVALID');
  return new Date(instant).toISOString();
}
export function validateCalendar(calendar) {
  if (!calendar || calendar.timeZone !== ZONE || !Number.isSafeInteger(calendar.firstYear) ||
    !Number.isSafeInteger(calendar.lastYear) || calendar.firstYear < 2000 || calendar.lastYear > 2200 ||
    calendar.lastYear < calendar.firstYear || !Array.isArray(calendar.holidays) || !Array.isArray(calendar.earlyCloses)) {
    throw new Error('CALENDAR_INVALID');
  }
  for (const dates of [calendar.holidays, calendar.earlyCloses]) {
    if (new Set(dates).size !== dates.length || dates.some(date => !validDate(date) ||
      Number(date.slice(0, 4)) < calendar.firstYear || Number(date.slice(0, 4)) > calendar.lastYear)) {
      throw new Error('CALENDAR_INVALID');
    }
  }
  return calendar;
}
export function scheduledSession(calendar, now = Date.now()) {
  validateCalendar(calendar);
  const local = newYorkParts(now), year = Number(local.date.slice(0, 4));
  if (year < calendar.firstYear || year > calendar.lastYear) throw new Error('CALENDAR_OUT_OF_RANGE');
  const weekday = new Date(`${local.date}T12:00:00Z`).getUTCDay();
  const tradingDay = weekday >= 1 && weekday <= 5 && !calendar.holidays.includes(local.date);
  const minutes = local.hour * 60 + local.minute;
  return { due: tradingDay && minutes >= 20 * 60 + 30 && minutes < 22 * 60 + 30,
    session: local.date, tradingDay, localTime: `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`,
    auditAt: auditInstant(local.date) };
}
