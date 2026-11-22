import { notFound, redirect } from "next/navigation";

import { SignersShell } from "@/components/envelopes/signers-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { getDraftSignerStepDataForUser } from "@/lib/envelopes";

type SignersPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function SignersPage({ params }: SignersPageProps) {
  const { id } = await params;
  let record: Awaited<ReturnType<typeof getDraftSignerStepDataForUser>> = null;
  let sender: { email: string; name: string } | undefined;
  let initialState: "error" | undefined;

  try {
    const session = await getAuthSession();
    sender = session
      ? {
          email: session.user.email,
          name:
            typeof session.user.name === "string" && session.user.name.trim()
              ? session.user.name.trim()
              : session.user.email,
        }
      : undefined;
    record = session
      ? await getDraftSignerStepDataForUser(session.user.id, id, getDb())
      : null;
  } catch {
    initialState = "error";
  }

  if (!initialState) {
    if (!record) {
      notFound();
    }

    if (record.status !== "draft") {
      redirect(`/envelopes/${id}`);
    }
  }

  return (
    <SignersShell
      envelopeId={id}
      initialState={initialState}
      key={id}
      record={record ?? undefined}
      sender={sender}
    />
  );
}
