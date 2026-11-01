export const SCHEDULE_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number];

export type RecurringSchedule =
  | { readonly type: "daily"; readonly time: string }
  | {
      readonly type: "weekly";
      readonly time: string;
      readonly weekdays: readonly ScheduleWeekday[];
    }
  | { readonly type: "every"; readonly minutes: number };

export type StoredSchedule = { readonly type: "once"; readonly at: string } | RecurringSchedule;

export type ScheduleInput =
  | { readonly type: "after"; readonly minutes: number }
  | { readonly type: "at"; readonly date?: string; readonly time: string }
  | RecurringSchedule;

export interface ResolvedSchedule {
  readonly schedule: StoredSchedule;
  readonly nextRunAt: string;
}

const JAPAN_TIME_ZONE_OFFSET_MS = 9 * 60 * 60 * 1_000;

export function resolveSchedule(input: ScheduleInput, now: number): ResolvedSchedule {
  switch (input.type) {
    case "after": {
      if (!Number.isInteger(input.minutes) || input.minutes < 1) {
        throw new Error("相対時間は1分以上で指定してください。");
      }
      const at = new Date(now + input.minutes * 60_000).toISOString();
      return { schedule: { type: "once", at }, nextRunAt: at };
    }
    case "at": {
      const date = input.date ?? getJapanDate(now);
      let timestamp = parseJapanDateTime(date, input.time);
      if (!input.date && timestamp <= now) timestamp += 24 * 60 * 60 * 1_000;
      if (input.date && timestamp <= now) throw new Error("指定した日時は未来にしてください。");
      const at = new Date(timestamp).toISOString();
      return { schedule: { type: "once", at }, nextRunAt: at };
    }
    case "daily":
    case "weekly":
    case "every": {
      const nextRunAt = getFirstRunAt(input, now);
      return { schedule: input, nextRunAt };
    }
  }
}

export function getNextRunAt(schedule: StoredSchedule, now: number): string | undefined {
  if (schedule.type === "once") return undefined;
  return new Date(getNextRecurringTimestamp(schedule, now)).toISOString();
}

export function isRecurringSchedule(schedule: StoredSchedule): schedule is RecurringSchedule {
  return schedule.type !== "once";
}

export function formatSchedule(schedule: StoredSchedule): string {
  switch (schedule.type) {
    case "once":
      return `${formatJapanDateTime(schedule.at)} JST`;
    case "daily":
      return `毎日 ${schedule.time} JST`;
    case "weekly":
      return `毎週 ${schedule.weekdays.join(",")} ${schedule.time} JST`;
    case "every":
      return `${schedule.minutes}分ごと`;
  }
}

export function formatJapanDateTime(timestamp: string): string {
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

export function parseStoredSchedule(value: unknown): StoredSchedule {
  if (typeof value !== "object" || value === null) {
    throw new Error("スケジュールの保存形式が不正です。");
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "once":
      if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) {
        throw new Error("一回だけのスケジュールには有効な日時が必要です。");
      }
      return { type: "once", at: record.at };
    case "daily":
      if (typeof record.time !== "string") {
        throw new Error("毎日のスケジュールには時刻が必要です。");
      }
      parseTime(record.time);
      return { type: "daily", time: record.time };
    case "weekly": {
      if (typeof record.time !== "string") {
        throw new Error("毎週のスケジュールには時刻が必要です。");
      }
      parseTime(record.time);
      if (
        !Array.isArray(record.weekdays) ||
        record.weekdays.length === 0 ||
        !record.weekdays.every(
          (weekday) => typeof weekday === "string" && isScheduleWeekday(weekday),
        )
      ) {
        throw new Error("毎週のスケジュールには1つ以上の曜日が必要です。");
      }
      return {
        type: "weekly",
        time: record.time,
        weekdays: record.weekdays as ScheduleWeekday[],
      };
    }
    case "every":
      if (!Number.isInteger(record.minutes) || (record.minutes as number) < 1) {
        throw new Error("間隔スケジュールは1分以上で指定してください。");
      }
      return { type: "every", minutes: record.minutes as number };
    default:
      throw new Error("スケジュールの種類が不正です。");
  }
}

function getFirstRunAt(schedule: RecurringSchedule, now: number): string {
  return new Date(getNextRecurringTimestamp(schedule, now)).toISOString();
}

function getNextRecurringTimestamp(schedule: RecurringSchedule, now: number): number {
  switch (schedule.type) {
    case "daily":
      return getNextDailyTimestamp(schedule.time, now);
    case "weekly":
      return getNextWeeklyTimestamp(schedule.time, schedule.weekdays, now);
    case "every":
      if (!Number.isInteger(schedule.minutes) || schedule.minutes < 1) {
        throw new Error("間隔は1分以上で指定してください。");
      }
      return now + schedule.minutes * 60_000;
  }
}

function isScheduleWeekday(value: string): value is ScheduleWeekday {
  return (SCHEDULE_WEEKDAYS as readonly string[]).includes(value);
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
  weekdays: readonly ScheduleWeekday[],
  now: number,
): number {
  if (weekdays.length === 0) throw new Error("毎週の曜日を1つ以上指定してください。");
  const { hour, minute } = parseTime(time);
  const localNow = new Date(now + JAPAN_TIME_ZONE_OFFSET_MS);
  const today = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  const weekdayNumbers = weekdays.map((weekday) => SCHEDULE_WEEKDAYS.indexOf(weekday));

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

  throw new Error("次回のスケジュール日時を計算できませんでした。");
}
