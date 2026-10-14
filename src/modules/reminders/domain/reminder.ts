export const REMINDER_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type ReminderWeekday = (typeof REMINDER_WEEKDAYS)[number];
export type ReminderRepeat = "daily" | "weekly";

export interface Reminder {
  readonly id: string;
  readonly sessionKey: string;
  readonly channelId: string;
  readonly ownerFeaturesAllowed: boolean;
  readonly message: string;
  readonly createdAt: string;
  readonly dueAt: string;
  readonly repeat?: ReminderRepeat;
  readonly time?: string;
  readonly weekdays?: readonly ReminderWeekday[];
}

export type ReminderSchedule =
  | { readonly type: "after"; readonly minutes: number }
  | { readonly type: "at"; readonly date?: string; readonly time: string }
  | { readonly type: "daily"; readonly time: string }
  | {
      readonly type: "weekly";
      readonly time: string;
      readonly weekdays: readonly ReminderWeekday[];
    };

const JAPAN_TIME_ZONE_OFFSET_MS = 9 * 60 * 60 * 1_000;

export function getReminderDueAt(schedule: ReminderSchedule, now: number): string {
  switch (schedule.type) {
    case "after": {
      if (!Number.isInteger(schedule.minutes) || schedule.minutes < 1) {
        throw new Error("相対時間は1分以上で指定してください。");
      }
      return new Date(now + schedule.minutes * 60_000).toISOString();
    }
    case "at": {
      const date = schedule.date ?? getJapanDate(now);
      let timestamp = parseJapanDateTime(date, schedule.time);
      if (!schedule.date && timestamp <= now) timestamp += 24 * 60 * 60 * 1_000;
      if (schedule.date && timestamp <= now) throw new Error("指定した日時は未来にしてください。");
      return new Date(timestamp).toISOString();
    }
    case "daily":
      return new Date(getNextDailyTimestamp(schedule.time, now)).toISOString();
    case "weekly":
      return new Date(getNextWeeklyTimestamp(schedule.time, schedule.weekdays, now)).toISOString();
  }
}

export function getNextReminderDueAt(reminder: Reminder, now: number): string | undefined {
  if (!reminder.repeat || !reminder.time) return undefined;
  const timestamp =
    reminder.repeat === "daily"
      ? getNextDailyTimestamp(reminder.time, now)
      : getNextWeeklyTimestamp(reminder.time, reminder.weekdays ?? [], now);
  return new Date(timestamp).toISOString();
}

export function formatReminderDateTime(timestamp: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

function parseJapanDateTime(date: string, time: string): number {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/u.exec(time);
  if (!dateMatch || !timeMatch) throw new Error("日時はYYYY-MM-DDとHH:mmで指定してください。");

  const [, year, month, day] = dateMatch;
  const [, hour, minute] = timeMatch;
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59
  ) {
    throw new Error("有効な日付と時刻を指定してください。");
  }
  return timestamp - JAPAN_TIME_ZONE_OFFSET_MS;
}

function getJapanDate(timestamp: number): string {
  const localDate = new Date(timestamp + JAPAN_TIME_ZONE_OFFSET_MS);
  return [
    localDate.getUTCFullYear().toString().padStart(4, "0"),
    (localDate.getUTCMonth() + 1).toString().padStart(2, "0"),
    localDate.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

function parseTime(time: string): { readonly hour: number; readonly minute: number } {
  const match = /^(\d{2}):(\d{2})$/u.exec(time);
  if (!match) throw new Error("時刻はHH:mmで指定してください。");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("有効な時刻を指定してください。");
  return { hour, minute };
}

function getNextDailyTimestamp(time: string, now: number): number {
  const { hour, minute } = parseTime(time);
  const localNow = new Date(now + JAPAN_TIME_ZONE_OFFSET_MS);
  let timestamp = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
    hour,
    minute,
  );
  if (timestamp <= now + JAPAN_TIME_ZONE_OFFSET_MS) timestamp += 24 * 60 * 60 * 1_000;
  return timestamp - JAPAN_TIME_ZONE_OFFSET_MS;
}

function getNextWeeklyTimestamp(
  time: string,
  weekdays: readonly ReminderWeekday[],
  now: number,
): number {
  if (weekdays.length === 0) throw new Error("毎週の曜日を1つ以上指定してください。");
  const { hour, minute } = parseTime(time);
  const localNow = new Date(now + JAPAN_TIME_ZONE_OFFSET_MS);
  const today = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  const weekdayNumbers = weekdays.map((weekday) => REMINDER_WEEKDAYS.indexOf(weekday));

  for (let daysAhead = 0; daysAhead <= 7; daysAhead += 1) {
    const date = today + daysAhead * 24 * 60 * 60 * 1_000;
    const timestamp = date + (hour * 60 + minute) * 60_000;
    if (
      timestamp > now + JAPAN_TIME_ZONE_OFFSET_MS &&
      weekdayNumbers.includes(new Date(date).getUTCDay())
    ) {
      return timestamp - JAPAN_TIME_ZONE_OFFSET_MS;
    }
  }

  throw new Error("次回のリマインダー日時を計算できませんでした。");
}
