import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  e2eAppUrl,
  e2eCronSecret,
  e2eOutboxDir,
  e2eRecoveryEnabled,
} from "../../playwright.config";

export type CapturedEmail = {
  capturedAt?: string;
  attachments?: { filename: string; sha256: string }[];
  html?: string;
  replyTo?: string;
  subject: string;
  template: string;
  text: string;
  to: string[];
};

async function readOutbox(): Promise<CapturedEmail[]> {
  let fileNames: string[];

  try {
    fileNames = await readdir(e2eOutboxDir);
  } catch {
    return [];
  }

  const emails = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .sort()
      .reverse()
      .map(async (fileName) => {
        try {
          return JSON.parse(
            await readFile(path.join(e2eOutboxDir, fileName), "utf8"),
          ) as CapturedEmail;
        } catch {
          // Unreadable right now: the next poll picks it up.
          return null;
        }
      }),
  );

  return emails
    .filter((email) => email !== null)
    .sort((left, right) => capturedAt(right) - capturedAt(left));
}

function capturedAt(email: CapturedEmail) {
  return Date.parse(email.capturedAt ?? "") || 0;
}

// A synchronous test scheduler. It starts only after a producer has run and
// there are no background requests to stop when a test fails.
async function drainRecovery() {
  const response = await fetch(new URL("/api/internal/recovery", e2eAppUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${e2eCronSecret}` },
    redirect: "error",
    signal: AbortSignal.timeout(25_000),
  });
  const summary = await response.json();
  if (!response.ok || summary?.status !== "ran" || summary.enabled !== true) {
    throw new Error(
      `The recovery fixture could not drain the queue (HTTP ${response.status}).`,
    );
  }
}

/** Waits for the newest captured email with this template and recipient. */
export async function waitForEmail(
  input: { template: string; to: string; linkPath?: string },
  timeoutMs = 30_000,
): Promise<CapturedEmail> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const match = (await readOutbox()).find(
      (email) =>
        email.template === input.template &&
        email.to.includes(input.to) &&
        (!input.linkPath ||
          extractLinks(email.text).some(
            (link) => new URL(link).pathname === input.linkPath,
          )),
    );

    if (match) {
      return match;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `No "${input.template}" email for ${input.to} within ${String(timeoutMs)} ms.`,
      );
    }

    if (e2eRecoveryEnabled) await drainRecovery();

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function extractLinks(text: string): string[] {
  return text.match(/https?:\/\/[^\s<>"]+/g) ?? [];
}

export function extractLink(text: string, pathPrefix: string): string {
  const link = extractLinks(text).find((candidate) =>
    new URL(candidate).pathname.startsWith(pathPrefix),
  );

  if (!link) {
    throw new Error(`No link starting with ${pathPrefix} in the email.`);
  }

  return link;
}
