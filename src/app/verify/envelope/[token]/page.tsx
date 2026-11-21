import type { Metadata } from "next";

import { PublicDocumentShell } from "@/components/layout/public-document-shell";
import { EnvelopeVerificationResult } from "@/components/verify/envelope-verification-result";

export const metadata: Metadata = {
  description: "View a public SignuDoc envelope completion record.",
  title: "Envelope verification",
};

export default async function EnvelopeVerificationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <PublicDocumentShell
      description="This page shows the public completion record. It does not publish signer contact details or the private audit history."
      title="Envelope verification"
    >
      <EnvelopeVerificationResult token={token} />
    </PublicDocumentShell>
  );
}
