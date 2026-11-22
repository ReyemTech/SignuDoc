import { createHash } from "node:crypto";

import type pg from "pg";

// The browser suite shares one administrator, so tests that create drafts or
// send envelopes start those rate limits afresh. Their result must not depend
// on which tests ran before them.

export async function startSendLimitAfresh(
  database: pg.Client,
  userId: string,
): Promise<void> {
  const keys = ["draft-create", "envelope-send"].map((prefix) =>
    createHash("sha256").update(`${prefix}:${userId}`).digest("hex"),
  );

  await database.query("delete from public.rate_limits where key = any($1)", [
    keys,
  ]);
}
