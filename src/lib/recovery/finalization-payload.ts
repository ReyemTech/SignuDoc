import { z } from "zod";
import {
  envelopeRecordSchema,
  envelopePageSchema,
  auditEventRecordSchema,
} from "../schemas/envelope.ts";
import { fieldRecordSchema } from "../schemas/field.ts";
import { signerRecordSchema, copyRecipientSchema } from "../schemas/signer.ts";
import {
  emailSchema,
  idSchema,
  unixTimestampSchema,
} from "../schemas/common.ts";

const objectHash = z.object({
  key: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const finalizationPayload = z
  .object({
    version: z.literal(1),
    publicVerificationToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    generatedAt: unixTimestampSchema,
    envelope: envelopeRecordSchema.extend({ status: z.literal("sent") }),
    fields: z.array(fieldRecordSchema),
    signers: z
      .array(
        signerRecordSchema
          .omit({
            accessCode: true,
            signingTokenHash: true,
            signingTokenExpiresAt: true,
          })
          .extend({
            id: idSchema,
            status: z.literal("signed"),
          }),
      )
      .min(1),
    copyRecipients: z.array(copyRecipientSchema.extend({ id: idSchema })),
    pages: z.array(envelopePageSchema),
    auditEvents: z.array(auditEventRecordSchema),
    images: z.array(objectHash),
    revision: objectHash.nullable(),
    sender: z.object({ email: emailSchema, name: z.string().nullable() }),
  })
  .refine(({ envelope, revision }) => {
    if ((envelope.signatureLevel ?? "simple") === "simple")
      return revision === null;
    return (
      revision !== null &&
      revision.key === envelope.revisionKey &&
      revision.sha256 === envelope.revisionSha256
    );
  }, "Provider revision must match the accepted envelope.")
  .refine(({ envelope, signers, fields, pages, auditEvents }) => {
    const signerIds = new Set(signers.map((signer) => signer.id));
    return (
      signers.every((signer) => signer.envelopeId === envelope.id) &&
      fields.every(
        (field) =>
          field.envelopeId === envelope.id && signerIds.has(field.signerId),
      ) &&
      pages.every((page) => page.envelopeId === envelope.id) &&
      auditEvents.every((event) => event.envelopeId === envelope.id)
    );
  }, "Finalization records must belong to the accepted envelope.");
