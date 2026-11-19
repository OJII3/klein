const JAPAN_TIME_ZONE_OFFSET_MS = 9 * 60 * 60 * 1_000;
const MINUTES_PER_DAY = 24 * 60;

export function parseJapanTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("時刻は HH:mm で指定してください。");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("有効な時刻を指定してください。");
  return { hour, minute };
}

export function isWithinQuietHours(
  quietHours: { start: string; end: string },
  now: number,
): boolean {
  const start = toMinuteOfDay(parseJapanTime(quietHours.start));
  const end = toMinuteOfDay(parseJapanTime(quietHours.end));
  if (start === end) return false;

  const current = getJapanMinuteOfDay(now);
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function japanDateKey(now: number): string {
  const local = new Date(now + JAPAN_TIME_ZONE_OFFSET_MS);
  return [
    local.getUTCFullYear().toString().padStart(4, "0"),
    (local.getUTCMonth() + 1).toString().padStart(2, "0"),
    local.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

export function isAtOrAfterJapanTime(time: string, now: number): boolean {
  return getJapanMinuteOfDay(now) >= toMinuteOfDay(parseJapanTime(time));
}

export function japanTimestampForToday(time: string, now: number): number {
  parseJapanTime(time);
  return Date.parse(`${japanDateKey(now)}T${time}:00+09:00`);
}

function getJapanMinuteOfDay(now: number): number {
  const local = new Date(now + JAPAN_TIME_ZONE_OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function toMinuteOfDay(time: { hour: number; minute: number }): number {
  return (time.hour * 60 + time.minute) % MINUTES_PER_DAY;
}
