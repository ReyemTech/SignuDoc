"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import type { PublicEnvelopeVerification } from "@/lib/public-verification";

export function EnvelopeVerificationResult({ token }: { token: string }) {
  const [record, setRecord] = useState<PublicEnvelopeVerification | null>(null);
  const [state, setState] = useState<"loading" | "missing" | "ready">("loading");

  useEffect(() => {
    let active = true;
    fetch(`/api/verify/envelope/${encodeURIComponent(token)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("not-found");
        return (await response.json()) as PublicEnvelopeVerification;
      })
      .then((result) => {
        if (active) {
          setRecord(result);
          setState("ready");
        }
      })
      .catch(() => {
        if (active) setState("missing");
      });
    return () => {
      active = false;
    };
  }, [token]);

  if (state === "loading") return <p>Loading the public completion record…</p>;
  if (state === "missing" || !record) {
    return (
      <div className="notice notice-warning" role="status">
        <p>This verification link is invalid or the record is no longer available.</p>
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-(--border) bg-(--surface) p-5">
      <p className="pill pill-success">Completed record found</p>
      <h2 className="text-xl font-extrabold text-(--fg)">{record.title}</h2>
      <p className="text-sm text-(--secondary)">
        Completed {new Date(record.completedAt * 1000).toLocaleString()} · {record.signerCount} signer{record.signerCount === 1 ? "" : "s"}
      </p>
      <div className="rounded-xl bg-(--surface-strong) p-4">
        <p className="text-sm font-bold text-(--fg)">Recorded signed PDF SHA-256</p>
        <code className="mt-2 block break-all text-xs text-(--secondary)">
          {record.signedPdfSha256 ?? "Not available"}
        </code>
      </div>
      <p className="text-sm leading-6 text-(--secondary)">
        This confirms the completion record associated with this link. To check a PDF file’s exact bytes, use the upload verifier on the{" "}
        <Link className="font-semibold text-(--accent-ink) underline" href="/verify">
          verification page
        </Link>
        .
      </p>
    </section>
  );
}
