import { NextResponse } from "next/server";

import {
  applyPublicLinkRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { hashPublicVerificationToken, verifyEnvelopeToken } from "@/lib/public-verification";

type RouteContext = { params: Promise<{ token: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const { token } = await params;
  const limited = await applyPublicLinkRateLimit({
    category: "public_envelope_verification",
    key: buildRateLimitKey(["envelope-verification", hashPublicVerificationToken(token)]),
    limit: 30,
    request,
    windowMs: 10 * 60 * 1000,
  });
  if (limited) return limited;

  try {
    const record = await verifyEnvelopeToken(token);
    if (!record) {
      return NextResponse.json(
        { error: "Verification record not found." },
        { headers: { "cache-control": "no-store" }, status: 404 },
      );
    }
    return NextResponse.json(record, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Verification is temporarily unavailable." },
      { headers: { "cache-control": "no-store" }, status: 500 },
    );
  }
}
