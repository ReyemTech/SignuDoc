import { createHash, randomBytes } from "node:crypto";

import { queryOne, getDb, type DbExecutor } from "./db/connection.ts";
import { getEnv, type EnvSource } from "./utils/env.ts";

export function createPublicVerificationToken(): {
  token: string;
  tokenHash: string;
} {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashPublicVerificationToken(token) };
}

export function hashPublicVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function buildPublicVerificationUrl(
  token: string,
  env: EnvSource = process.env,
): string {
  const appUrl = getEnv(env).appUrl;
  if (!appUrl) throw new Error("APP_URL is required for public verification links.");
  return new URL(`/verify/envelope/${encodeURIComponent(token)}`, appUrl).toString();
}

export type PublicEnvelopeVerification = {
  completedAt: number;
  signerCount: number;
  signedPdfSha256: string | null;
  status: "completed";
  title: string;
};

export async function verifyEnvelopeToken(
  token: string,
  database: DbExecutor = getDb(),
): Promise<PublicEnvelopeVerification | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;

  return queryOne<PublicEnvelopeVerification>(
    database,
    `
      SELECT e.title, e.status, e.completed_at AS "completedAt",
        e.signed_pdf_sha256 AS "signedPdfSha256",
        (SELECT count(*)::int FROM signers s
         WHERE s.envelope_id = e.id AND s.role = 'signer') AS "signerCount"
      FROM envelopes e
      WHERE e.public_verification_token_hash = $1
        AND e.status = 'completed'
        AND e.completed_at IS NOT NULL
      LIMIT 1
    `,
    [hashPublicVerificationToken(token)],
  );
}
