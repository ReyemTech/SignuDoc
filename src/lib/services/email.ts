import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Resend } from "resend";

import { type DbExecutor } from "../db/connection.ts";
import {
  getSettings,
  readStoredSettings,
  resolveSettings,
} from "../settings.ts";
import { type EmailTemplateKind } from "../types/domain.ts";
import { getEnv, isLocalDeployment, type EnvSource } from "../utils/env.ts";
import { buildEmailAddresses, type EmailAddresses } from "./email-addresses.ts";
import {
  assertServiceConfig,
  ServiceConfigurationError,
} from "./service-config.ts";

// The addresses mail is sent from and replied to are not needed here: they
// come from RESEND_FROM_EMAIL and SUPPORT_EMAIL when those are set, and from
// the install's settings otherwise, and are looked up when a message is sent.
const EMAIL_ENV_KEYS = ["RESEND_API_KEY"] as const;

const DEFAULT_CAPTURE_DIR = ".data/outbox";
const DEFAULT_CAPTURE_SENDER_ADDRESS = "dev@signudoc.localhost";

export type EmailDriver = "capture" | "resend";

export type EmailAttachment = {
  content: Uint8Array;
  contentType: string;
  filename: string;
};

/**
 * Resend accepts up to 40 MB per message once attachments are base64
 * encoded, which makes them a third larger. Above this the message goes out
 * with links only.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function fitsAsAttachments(
  attachments: readonly EmailAttachment[],
): boolean {
  return (
    attachments.reduce((total, item) => total + item.content.byteLength, 0) <=
    MAX_ATTACHMENT_BYTES
  );
}

export type TransactionalEmailMessage = {
  /** Not allowed in sendBatch: Resend's batch endpoint takes none. */
  attachments?: EmailAttachment[];
  htmlBody?: string;
  replyTo?: string;
  subject: string;
  template: EmailTemplateKind;
  textBody: string;
  to: string;
};

export type EmailDeliveryResult = {
  accepted: string[];
  messageId?: string;
  rejected: string[];
};

export type EmailSendOptions = {
  /** Frozen addresses supplied by a durable job. */
  addresses?: EmailAddresses;
  idempotencyKey?: string;
  /** Cancels the provider request. An aborted request may already be accepted. */
  signal?: AbortSignal;
};

type CreateEmailServiceOptions = {
  env?: EnvSource;
  /** Replaced in tests, where there is no database to read settings from. */
  resolveAddresses?: () => Promise<EmailAddresses>;
  resendClient?: Resend;
  /** Replaced in tests, so that they do not really wait. */
  wait?: (milliseconds: number) => Promise<void>;
};

/** How often a message Resend turned away for rate is tried again. */
const RATE_LIMIT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

type ResendResult = {
  error: { name: string } | null;
  headers: Record<string, string> | null;
};

function rateLimitWaitMs(headers: Record<string, string> | null): number {
  const seconds = Number(headers?.["retry-after"]);

  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RATE_LIMIT_WAIT_MS)
    : DEFAULT_RATE_LIMIT_WAIT_MS;
}

/**
 * Resend allows a team so many requests a second, across everything that
 * uses its key. A request over that is refused, not queued, so the message
 * would be lost: a signer would never get their copy. It is tried again
 * after the wait Resend names. A used-up daily or monthly quota is also a
 * 429, and is not retried: a second's wait does not bring it back.
 */
async function sendWithinRateLimit<T extends ResendResult>(
  request: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await request();

    if (
      result.error?.name !== "rate_limit_exceeded" ||
      attempt >= RATE_LIMIT_RETRIES
    ) {
      return result;
    }

    await wait(rateLimitWaitMs(result.headers));
  }
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getResendErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return "Email delivery failed.";
}

function buildResendOptions(options?: EmailSendOptions) {
  return {
    idempotencyKey: options?.idempotencyKey,
    signal: options?.signal,
  };
}

function buildResendPayload(
  message: TransactionalEmailMessage,
  config: EmailAddresses,
) {
  return {
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            content: Buffer.from(attachment.content),
            contentType: attachment.contentType,
            filename: attachment.filename,
          })),
        }
      : {}),
    from: config.senderAddress,
    html: message.htmlBody,
    replyTo: message.replyTo ?? config.supportAddress ?? undefined,
    subject: message.subject,
    tags: [
      {
        name: "category",
        value: message.template,
      },
    ],
    text: message.textBody,
    to: [message.to],
  };
}

export interface EmailService {
  send(
    message: TransactionalEmailMessage,
    options?: EmailSendOptions,
  ): Promise<EmailDeliveryResult>;
  sendBatch(
    messages: readonly TransactionalEmailMessage[],
    options?: EmailSendOptions,
  ): Promise<EmailDeliveryResult[]>;
}

export function resolveEmailDriver(env: EnvSource = process.env): EmailDriver {
  const configuredDriver = env.EMAIL_DRIVER?.trim().toLowerCase();

  if (!configuredDriver) {
    return "resend";
  }

  if (configuredDriver === "capture" || configuredDriver === "resend") {
    return configuredDriver;
  }

  throw new Error(
    `Unknown EMAIL_DRIVER "${configuredDriver}". Use "resend" or "capture".`,
  );
}

/**
 * Development and test driver: nothing is sent. Each message is written as a
 * JSON file so a person (or the end-to-end test) can read the links in it.
 */
function createCaptureEmailService(
  env: EnvSource,
  resolveAddresses: () => Promise<EmailAddresses>,
): EmailService {
  // Allowed in development, and for a production build that is being run on
  // localhost (which is what the end-to-end test does). Never on a real site.
  if (env.NODE_ENV === "production" && !isLocalDeployment(env)) {
    throw new Error(
      "EMAIL_DRIVER=capture drops every email and cannot be used in production.",
    );
  }

  // The comment stops Turbopack from tracing the whole project into the
  // server bundle because of a path it cannot analyse.
  const captureDir = path.resolve(
    /*turbopackIgnore: true*/ env.EMAIL_CAPTURE_DIR?.trim() ||
      DEFAULT_CAPTURE_DIR,
  );

  async function capture(
    message: TransactionalEmailMessage,
    options?: EmailSendOptions,
  ): Promise<EmailDeliveryResult> {
    options?.signal?.throwIfAborted();
    const config = options?.addresses ?? (await resolveAddresses());
    const stableId = options?.idempotencyKey
      ? createHash("sha256").update(options.idempotencyKey).digest("hex")
      : null;
    const messageId = `capture-${stableId ?? randomUUID()}`;
    const filePath = path.join(
      /*turbopackIgnore: true*/ captureDir,
      stableId
        ? `${messageId}.json`
        : `${String(Date.now())}-${messageId}.json`,
    );
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const payload = {
      ...buildResendPayload({ ...message, attachments: undefined }, config),
      // Fingerprints describe what would be sent without keeping another PDF.
      attachments: message.attachments?.length
        ? message.attachments.map((attachment) => ({
            bytes: attachment.content.byteLength,
            contentType: attachment.contentType,
            filename: attachment.filename,
            sha256: createHash("sha256")
              .update(attachment.content)
              .digest("hex"),
          }))
        : undefined,
      template: message.template,
    };
    const payloadDigest = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    const delivery = { accepted: [message.to], messageId, rejected: [] };

    // Publish the whole message atomically. A keyed delivery uses a hard
    // link so concurrent processes cannot replace the winning snapshot.
    await mkdir(captureDir, { recursive: true });
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify(
          {
            ...payload,
            capturedAt: new Date().toISOString(),
            messageId,
            payloadDigest,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      if (stableId) {
        try {
          await link(temporaryPath, filePath);
        } catch (error) {
          if (!(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            throw error;
          const existing = JSON.parse(await readFile(filePath, "utf8"));
          if (existing.payloadDigest !== payloadDigest) {
            throw new Error(
              "Email capture idempotency key conflicts with a different payload.",
            );
          }
          return delivery;
        }
      } else {
        await rename(temporaryPath, filePath);
      }
      console.info(`[email:capture] ${message.template} -> ${messageId}`);
      return delivery;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  return {
    send: capture,
    async sendBatch(messages) {
      const results: EmailDeliveryResult[] = [];

      for (const message of messages) {
        results.push(await capture(message));
      }

      return results;
    },
  };
}

/** The addresses this install sends from, as configured right now. */
export async function resolveEmailAddresses(
  env: EnvSource = process.env,
  database?: DbExecutor,
): Promise<EmailAddresses> {
  const settings = database
    ? resolveSettings(await readStoredSettings(database), env)
    : await getSettings(env);

  return resolveEmailDriver(env) === "capture"
    ? buildEmailAddresses(settings, DEFAULT_CAPTURE_SENDER_ADDRESS)
    : buildEmailAddresses(settings);
}

/** What a sender is told when an action needs email and none is connected. */
export const EMAIL_NOT_CONNECTED_MESSAGE =
  "Email is not set up yet, so signers can't be emailed. An administrator can finish email setup in Settings, Organization.";

/**
 * Whether an error is createEmailService's refusal for a missing provider
 * key: a known setup state, not a server failure (issue #53).
 */
export function isEmailNotConnectedError(error: unknown): boolean {
  return (
    error instanceof ServiceConfigurationError &&
    error.message.startsWith("email service ")
  );
}

export function createEmailService({
  env = process.env,
  resolveAddresses = () => resolveEmailAddresses(env),
  resendClient,
  wait = waitFor,
}: CreateEmailServiceOptions = {}): EmailService {
  if (!resendClient && resolveEmailDriver(env) === "capture") {
    return createCaptureEmailService(env, resolveAddresses);
  }

  if (!resendClient) {
    assertServiceConfig("email", EMAIL_ENV_KEYS, env);
  }

  const client = resendClient ?? new Resend(getEnv(env).email.apiKey!);

  return {
    async send(message, options) {
      const config = options?.addresses ?? (await resolveAddresses());
      const send = () =>
        client.emails.send(
          buildResendPayload(message, config),
          buildResendOptions(options),
        );
      // The durable worker owns the retry schedule when it supplies a signal.
      const { data, error } = options?.signal
        ? await send()
        : await sendWithinRateLimit(send, wait);

      if (error) {
        throw new Error(getResendErrorMessage(error));
      }

      return {
        accepted: [message.to],
        messageId: data?.id,
        rejected: [],
      };
    },

    async sendBatch(messages, options) {
      if (messages.length === 0) {
        return [];
      }

      if (messages.some((message) => message.attachments?.length)) {
        throw new Error("Messages with attachments must be sent one by one.");
      }

      const config = await resolveAddresses();
      const { data, error } = await sendWithinRateLimit(
        () =>
          client.batch.send(
            messages.map((message) => buildResendPayload(message, config)),
            buildResendOptions(options),
          ),
        wait,
      );

      if (error) {
        throw new Error(getResendErrorMessage(error));
      }

      return messages.map((message, index) => ({
        accepted: [message.to],
        messageId: data?.data[index]?.id,
        rejected: [],
      }));
    },
  };
}
