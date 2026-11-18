import { type Branding } from "./branding.ts";
import { isDurableJobsEnabled } from "./recovery/config.ts";
import { enqueueEmail } from "./recovery/email.ts";
import { tryDeliverWorkflowEmails } from "./recovery/workflow-email.ts";
import { type DbPool, getDb } from "./db/connection.ts";
import {
  renewRecipientDownloadLinks,
  type RenewedDownloadLinks,
  type RenewalEmailData,
} from "./downloads.ts";
import { getBranding } from "./settings.ts";
import { recordEmailSent } from "./services/audit.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import { RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS } from "./types/domain.ts";
import { escapeHtml } from "./utils/html.ts";

const TTL_DAYS = RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS / (24 * 60 * 60);

function buildRenewalEmail(
  { envelope, evidenceUrl, signedUrl, signer }: RenewalEmailData,
  branding: Branding,
) {
  const subject = `New download links for "${envelope.title}"`;
  const textBody = [
    `Hi ${signer.name},`,
    "",
    `Here are new download links for "${envelope.title}" in ${branding.productName}. They work for ${String(TTL_DAYS)} days.`,
    "",
    ...(signedUrl ? [`Signed PDF: ${signedUrl}`] : []),
    `Certificate: ${evidenceUrl}`,
    "",
    "Download and keep the files: they are your copy of the record.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(signer.name)},</p>`,
    `<p>Here are new download links for &ldquo;${escapeHtml(envelope.title)}&rdquo; in ${escapeHtml(branding.productName)}. They work for ${String(TTL_DAYS)} days.</p>`,
    "<p>",
    signedUrl
      ? `<a href="${escapeHtml(signedUrl)}">Download signed PDF</a><br />`
      : "",
    `<a href="${escapeHtml(evidenceUrl)}">Download certificate</a></p>`,
    "<p>Download and keep the files: they are your copy of the record.</p>",
  ].join("");
  const body = withUserEmailLegalFooter({ htmlBody, textBody }, branding);
  return {
    htmlBody: body.htmlBody,
    subject,
    template: "download_links",
    textBody: body.textBody,
    to: signer.email,
  } as const;
}

/** Sends fresh download links to the signer an expired link belonged to. */
export async function sendFreshDownloadLinks(
  token: string,
  {
    database = getDb(),
    emailService,
  }: { database?: DbPool; emailService?: EmailService } = {},
): Promise<RenewedDownloadLinks> {
  const durable = isDurableJobsEnabled();
  const service = emailService ?? (durable ? undefined : createEmailService());
  const branding = await getBranding();

  if (durable) {
    const jobs: string[] = [];
    const response = await renewRecipientDownloadLinks(token, {
      database,
      async enqueueLinks(input) {
        const {
          envelope,
          evidenceLink,
          presentedTokenHash,
          signer,
          signedLink,
        } = input;
        const links = signedLink ? [evidenceLink, signedLink] : [evidenceLink];
        const { id } = await enqueueEmail(
          {
            message: buildRenewalEmail(input, branding),
            dedupeKey: `download-renewal/${envelope.id}/${signer.id}/${presentedTokenHash}`,
            envelopeId: envelope.id,
            userId: envelope.userId,
            expiresAt: Math.min(...links.map((link) => link.exp)),
            guard: {
              kind: "recipient_download_tokens",
              signerId: signer.id!,
              tokenHashes: links.map((link) => link.tokenHash),
            },
            acknowledgement: { kind: "email_audit", signerId: signer.id },
          },
          { database: input.database },
        );
        jobs.push(id);
      },
    });
    await tryDeliverWorkflowEmails(jobs, { database, emailService: service });
    return response;
  }

  return renewRecipientDownloadLinks(token, {
    database,
    async sendLinks(input) {
      const { envelope, signer } = input;
      const delivery = await service!.send(buildRenewalEmail(input, branding));

      await recordEmailSent(
        {
          envelopeId: envelope.id,
          messageId: delivery.messageId,
          recipient: signer.email,
          signerId: signer.id,
          template: "download_links",
        },
        database,
      );
    },
  });
}
