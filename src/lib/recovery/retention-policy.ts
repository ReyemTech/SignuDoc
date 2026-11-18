import { type DbExecutor, queryOne } from "../db/connection.ts";

export const RETENTION_WARNING_DAYS = 30;
export const RETENTION_MIN_NOTICE_DAYS = RETENTION_WARNING_DAYS;
export const RETENTION_DAY_SECONDS = 86_400;

export type RetentionPolicy = { days: number; generation: number };

export function readRetentionPolicy(database: DbExecutor, lock = false) {
  return queryOne<RetentionPolicy>(
    database,
    `SELECT retention_days AS days, retention_policy_generation AS generation
      FROM app_settings WHERE id AND retention_days > 0 ${lock ? "FOR SHARE" : ""}`,
  );
}
