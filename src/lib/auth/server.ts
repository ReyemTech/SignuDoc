import { createHash } from "node:crypto";

import { APIError, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth, haveIBeenPwned, twoFactor } from "better-auth/plugins";
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import type { Pool } from "pg";
import { cache } from "react";

import { type Branding } from "../branding.ts";
import { getDb, queryOne, withTransaction } from "../db/connection.ts";
import { isDurableJobsEnabled } from "../recovery/config.ts";
import { enqueueEmail } from "../recovery/email.ts";
import { tryDeliverWorkflowEmails } from "../recovery/workflow-email.ts";
import {
  createEmailService,
  type EmailService,
  type TransactionalEmailMessage,
} from "../services/email.ts";
import { withUserEmailLegalFooter } from "../services/email-legal-footer.ts";
import { consumeRateLimit } from "../security/rate-limit.ts";
import { getClientIpHeaderNames } from "../security/request.ts";
import {
  requireConfigValue,
  ServiceConfigurationError,
} from "../services/service-config.ts";
import {
  evaluateSignupRequest,
  getBranding,
  getSettings,
  isMissingSchemaError,
} from "../settings.ts";
import { enforceSessionLimits } from "../session-controls.ts";
import { clearFailedSignIns } from "../sign-in-security.ts";
import {
  getEnv,
  resolveDeploymentOrigins,
  type EnvSource,
} from "../utils/env.ts";
import { escapeHtml } from "../utils/html.ts";
import { isRunningSetup } from "./setup-context.ts";
import { signInEvents } from "./sign-in-events.ts";
import {
  mayUsePassword,
  readPasswordSignInPolicy,
  readSsoConfig,
  SSO_PROVIDER_ID,
} from "./sso.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";

type CreateAppAuthOptions = {
  database?: Pool;
  env?: EnvSource;
  emailService?: EmailService;
  includeNextCookies?: boolean;
  afterResponse?: (deliver: () => Promise<void>) => void;
};

type AppAuth = ReturnType<typeof createAppAuth>;

let cachedAuth: AppAuth | null = null;

const LOOPBACK_HOST_ALIASES = ["127.0.0.1", "localhost"] as const;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "::1" ||
    LOOPBACK_HOST_ALIASES.includes(
      hostname as (typeof LOOPBACK_HOST_ALIASES)[number],
    )
  );
}

function addTrustedOrigin(
  trustedOrigins: Set<string>,
  origin: string | null | undefined,
) {
  if (!origin) {
    return;
  }

  try {
    const parsedOrigin = new URL(origin);

    trustedOrigins.add(parsedOrigin.origin);

    if (!isLoopbackHost(parsedOrigin.hostname)) {
      return;
    }

    for (const loopbackHost of LOOPBACK_HOST_ALIASES) {
      const aliasOrigin = new URL(parsedOrigin.origin);
      aliasOrigin.hostname = loopbackHost;
      trustedOrigins.add(aliasOrigin.origin);
    }
  } catch {
    return;
  }
}

function buildEmailVerificationMessage(input: {
  branding: Branding;
  name: string;
  url: string;
}) {
  const { productName } = input.branding;
  const textBody = [
    `Hi ${input.name},`,
    "",
    `Verify your email address to finish setting up your ${productName} sender account:`,
    input.url,
    "",
    "If you didn't request this, you can ignore this email.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.name)},</p>`,
    `<p>Verify your email address to finish setting up your ${escapeHtml(productName)} sender account.</p>`,
    `<p><a href="${escapeHtml(input.url)}">Verify your email</a></p>`,
    "<p>If you didn't request this, you can ignore this email.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter(
    {
      htmlBody,
      textBody,
    },
    input.branding,
  );

  return {
    htmlBody: legalFooter.htmlBody,
    subject: `Verify your ${productName} email`,
    template: "email_verification" as const,
    textBody: legalFooter.textBody,
  };
}

function buildChangeEmailConfirmationMessage(input: {
  branding: Branding;
  name: string;
  newEmail: string;
  url: string;
}) {
  const { productName } = input.branding;
  const textBody = [
    `Hi ${input.name},`,
    "",
    `Confirm that you want to change your ${productName} sender email to ${input.newEmail}:`,
    input.url,
    "",
    "If you didn't request this, you can ignore this email.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.name)},</p>`,
    `<p>Confirm that you want to change your ${escapeHtml(productName)} sender email to ${escapeHtml(input.newEmail)}.</p>`,
    `<p><a href="${escapeHtml(input.url)}">Confirm this email change</a></p>`,
    "<p>If you didn't request this, you can ignore this email.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter(
    {
      htmlBody,
      textBody,
    },
    input.branding,
  );

  return {
    htmlBody: legalFooter.htmlBody,
    subject: `Confirm your ${productName} email change`,
    template: "change_email_confirmation" as const,
    textBody: legalFooter.textBody,
  };
}

function buildPasswordResetMessage(input: {
  branding: Branding;
  name: string;
  url: string;
}) {
  const { productName } = input.branding;
  const textBody = [
    `Hi ${input.name},`,
    "",
    `Use the link below to reset your ${productName} password:`,
    input.url,
    "",
    "If you didn't request this reset, you can ignore this email.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.name)},</p>`,
    `<p>Use the link below to reset your ${escapeHtml(productName)} password.</p>`,
    `<p><a href="${escapeHtml(input.url)}">Reset your password</a></p>`,
    "<p>If you didn't request this reset, you can ignore this email.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter(
    {
      htmlBody,
      textBody,
    },
    input.branding,
  );

  return {
    htmlBody: legalFooter.htmlBody,
    subject: `Reset your ${productName} password`,
    template: "password_reset" as const,
    textBody: legalFooter.textBody,
  };
}

type AuthEmailContent = Omit<TransactionalEmailMessage, "to">;
type AuthEmailTemplate =
  "email_verification" | "password_reset" | "change_email_confirmation";
type AuthEmailInput = {
  buildContent: (branding: Branding) => AuthEmailContent;
  template: AuthEmailTemplate;
  to: string;
  token: string;
  url: string;
  userId: string;
};

function emailVerificationExpiry(token: string): number {
  // Better Auth generated and signed this JWT before calling us.
  const [, body] = token.split(".");
  const payload: unknown = JSON.parse(
    Buffer.from(body ?? "", "base64url").toString("utf8"),
  );
  if (
    !payload ||
    typeof payload !== "object" ||
    !("exp" in payload) ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= 0
  ) {
    throw new Error("Missing Better Auth verification expiry.");
  }
  return payload.exp;
}

async function resetPasswordVerification(
  token: string,
  userId: string,
  database: Pool,
) {
  // The native password-reset endpoint inserts this opaque token before
  // invoking the callback. Use its actual expiry rather than restarting
  // the clock after enqueue or depending on Better Auth's default TTL.
  return queryOne<{ expiresAt: number; id: string }>(
    database,
    `SELECT id, floor(extract(epoch from "expiresAt"))::bigint AS "expiresAt"
      FROM verification WHERE identifier = $1 AND value = $2`,
    [`reset-password:${token}`, userId],
  );
}

// Auth emails are sent after the response, so sign-in is never slowed down
// by the mail provider, and a message that cannot be sent (email that is not
// configured yet, for one) is logged instead of failing the request.
//
// after() keeps a Vercel function alive until the message has gone out. A
// promise that nothing waits for could be cut off when the function is
// suspended at the end of the response.
// https://nextjs.org/docs/app/api-reference/functions/after
function sendAuthEmailInBackground(input: {
  buildContent: (branding: Branding) => AuthEmailContent;
  env: EnvSource;
  getEmailService: () => EmailService;
  template: TransactionalEmailMessage["template"];
  to: string;
}) {
  const deliver = async () => {
    try {
      const branding = await getBranding(input.env);

      await input.getEmailService().send({
        ...input.buildContent(branding),
        to: input.to,
      });
    } catch (error) {
      console.error(
        `Failed to send auth email "${input.template}" to ${input.to}:`,
        error,
      );
    }
  };

  try {
    after(deliver);
  } catch {
    // Not inside a request (a script or the auth CLI), so there is no
    // response to wait for.
    void deliver();
  }
}

// In production, new passwords are checked against the Have I Been Pwned
// breach list, which needs outbound HTTPS to api.pwnedpasswords.com. If the
// check cannot be reached, sign-up fails rather than accepting the password.
// PASSWORD_BREACH_CHECK=off turns it off for networks without that access
// and for the end-to-end test.
function isPasswordBreachCheckEnabled(env: EnvSource): boolean {
  return (
    env.NODE_ENV === "production" &&
    env.PASSWORD_BREACH_CHECK?.trim().toLowerCase() !== "off"
  );
}

// Where a password is used or handed out. A reset link is only sent where
// a password may be used, so turning password sign-in off cannot be undone
// with "Forgot your password?".
const PASSWORD_PATHS = new Set([
  "/request-password-reset",
  "/sign-in/email",
  "/sign-up/email",
]);

export function createAppAuth({
  database = getDb(),
  env = process.env,
  emailService: injectedEmailService,
  includeNextCookies = true,
  afterResponse = after,
}: CreateAppAuthOptions = {}) {
  const appEnv = getEnv(env);
  const authEnv = appEnv.auth;
  const secret = requireConfigValue(
    "auth",
    "BETTER_AUTH_SECRET",
    authEnv.betterAuthSecret,
  );
  const baseURL = requireConfigValue(
    "auth",
    "BETTER_AUTH_URL",
    authEnv.betterAuthUrl,
  );
  const durable = isDurableJobsEnabled(env);
  let cachedEmailService: EmailService | null = injectedEmailService ?? null;
  const emailService = () => {
    cachedEmailService ??= createEmailService({ env });

    return cachedEmailService;
  };
  async function sendAuthEmail(input: AuthEmailInput) {
    if (!durable) {
      sendAuthEmailInBackground({
        ...input,
        env,
        getEmailService: emailService,
      });
      return;
    }

    // The adapter owns its user/verification writes. Await this independent
    // queue commit inside the callback; only delivery belongs in after().
    const verification =
      input.template === "password_reset"
        ? await resetPasswordVerification(input.token, input.userId, database)
        : null;
    if (input.template === "password_reset" && !verification) return;
    const expiresAt =
      verification?.expiresAt ?? emailVerificationExpiry(input.token);
    const requestDigest = createHash("sha256").update(input.url).digest("hex");

    const job = await withTransaction(async (tx) => {
      // Better Auth calls signup verification after its account commit.
      // This lock orders existing-account callbacks with account purge.
      const account = await queryOne<{ id: string }>(
        tx,
        'SELECT id FROM "user" WHERE id = $1 FOR KEY SHARE',
        [input.userId],
      );
      if (!account) return;
      const branding = await getBranding(env, tx);
      return enqueueEmail(
        {
          message: { ...input.buildContent(branding), to: input.to },
          dedupeKey: `auth/${input.template}/${input.userId}/${requestDigest}`,
          userId: input.userId,
          expiresAt,
          guard: verification
            ? { kind: "password_reset", verificationId: verification.id }
            : undefined,
        },
        { database: tx, env },
      );
    }, database);
    if (!job) return;
    const { id } = job;

    try {
      afterResponse(async () => {
        await tryDeliverWorkflowEmails([id], {
          database,
          env,
          emailService: injectedEmailService,
        });
      });
    } catch {
      // Outside a Next request the scheduled worker can deliver the intent.
    }
  }
  const sso = readSsoConfig(env);
  const passwordPolicy = readPasswordSignInPolicy(env);
  const plugins = [
    // Single sign-on with the organization's identity provider (sso.ts).
    // Its sign-ins do not ask for this app's second step: the provider's
    // own sign-in, with its own MFA, is the check.
    ...(sso
      ? [
          genericOAuth({
            config: [
              {
                clientId: sso.clientId,
                clientSecret: sso.clientSecret,
                discoveryUrl: sso.discoveryUrl,
                // A provider whose discovery cannot vouch for its ID tokens
                // is left out rather than trusted unchecked.
                requireIdTokenVerification: true,
                // Microsoft Entra ID leaves email_verified out of its
                // tokens. The organization's own directory is trusted for
                // its addresses unless it says one is not verified.
                mapProfileToUser: (profile) => ({
                  emailVerified:
                    profile.email_verified !== false &&
                    profile.email_verified !== "false",
                }),
                name: sso.name,
                pkce: true,
                providerId: SSO_PROVIDER_ID,
                scopes: ["openid", "email", "profile"],
              },
            ],
          }),
        ]
      : []),
    ...(isPasswordBreachCheckEnabled(env)
      ? [
          haveIBeenPwned({
            customPasswordCompromisedMessage:
              "This password has appeared in a breach. Choose a different password.",
          }),
        ]
      : []),
    // Two-step sign-in with an authenticator app, and ten single-use backup
    // codes for when the phone is not at hand. Both are stored encrypted
    // with BETTER_AUTH_SECRET. "Trust this device" is not offered, so every
    // sign-in asks for the second step.
    twoFactor({
      accountLockout: {
        durationSeconds: 15 * 60,
        enabled: true,
        maxFailedAttempts: 10,
      },
      backupCodeOptions: { amount: 10, length: 10 },
      skipVerificationOnEnable: false,
    }),
    // After the two-factor plugin: see sign-in-events.ts.
    signInEvents(),
    ...(includeNextCookies ? [nextCookies()] : []),
  ];
  return betterAuth({
    trustedOrigins: async () => {
      const trustedOrigins = new Set<string>();

      addTrustedOrigin(trustedOrigins, appEnv.appUrl);
      addTrustedOrigin(trustedOrigins, baseURL);

      // On Vercel the same deployment also answers on its own vercel.app
      // URLs, which are the same app and so are trusted too.
      for (const origin of resolveDeploymentOrigins(env)) {
        addTrustedOrigin(trustedOrigins, origin);
      }

      return Array.from(trustedOrigins);
    },
    advanced: {
      // The tables are made by this app's own migrations (db/migrations),
      // and the setup page already says so when they are missing. Better
      // Auth's check would add nothing but a failure it remembers for the
      // life of the process: an app that was opened before its database was
      // migrated would refuse every sign-in until it was restarted.
      database: { validateSchema: false },
      // Where the visitor's address is read from, for rate limits and
      // sessions: the same headers the rest of the app trusts.
      ipAddress: { ipAddressHeaders: getClientIpHeaderNames(env) },
      // Secure cookies whenever the site is served over HTTPS, which is
      // always in production except for a build run on localhost.
      useSecureCookies: baseURL.startsWith("https://"),
    },
    baseURL,
    database,
    emailVerification: {
      sendOnSignIn: true,
      sendOnSignUp: true,
      sendVerificationEmail: async ({ token, url, user }) => {
        // The administrator created by first-run setup is verified by
        // setup itself; there is no working email to send through yet.
        if (isRunningSetup()) {
          return;
        }

        await sendAuthEmail({
          buildContent: (branding) =>
            buildEmailVerificationMessage({
              branding,
              name: user.name,
              url,
            }),
          template: "email_verification",
          to: user.email,
          token,
          url,
          userId: user.id,
        });
      },
    },
    emailAndPassword: {
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 15,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }) => {
        try {
          // The new password ends a lockout from wrong guesses at the old one.
          await clearFailedSignIns(user.email);
          await recordSystemAuditEvent({
            actorEmail: user.email,
            actorUserId: user.id,
            event: "password_reset",
            targetUserId: user.id,
          });
        } catch (error) {
          console.error("[auth] Could not record a password reset:", error);
        }
      },
      sendResetPassword: async ({ token, url, user }) => {
        await sendAuthEmail({
          buildContent: (branding) =>
            buildPasswordResetMessage({
              branding,
              name: user.name,
              url,
            }),
          template: "password_reset",
          to: user.email,
          token,
          url,
          userId: user.id,
        });
      },
    },
    hooks: {
      // The sign-up rule, asked before anything else so the person filling
      // in the form is told. The same rule is enforced again in
      // validateUserInfo below, but a refusal there is answered as if the
      // sign-up had worked: Better Auth cannot let it look different from
      // "this address already has an account". The rule is about the
      // address's domain and is printed on the sign-up page, so saying it
      // here gives nothing away.
      before: createAuthMiddleware(async (ctx) => {
        if (isRunningSetup()) {
          return;
        }

        const body: unknown = ctx.body;
        const email =
          typeof body === "object" &&
          body !== null &&
          "email" in body &&
          typeof body.email === "string"
            ? body.email
            : "";

        // With password sign-in turned off, only the addresses kept for
        // when the identity provider is down may use one (sso.ts).
        if (
          sso &&
          PASSWORD_PATHS.has(ctx.path ?? "") &&
          !mayUsePassword(passwordPolicy, email)
        ) {
          throw new APIError("FORBIDDEN", {
            code: "PASSWORD_SIGN_IN_OFF",
            message: `Password sign-in is turned off here. Continue with ${sso.name} instead.`,
          });
        }

        if (ctx.path !== "/sign-up/email") {
          return;
        }

        const decision = await evaluateSignupRequest(email, env);

        if (!decision.allowed) {
          throw new APIError("FORBIDDEN", {
            code: decision.code,
            message: decision.message,
          });
        }
      }),
    },
    // Better Auth limits its own routes (three sign-in or sign-up attempts
    // in ten seconds, for one). Its counts go in the same Postgres table as
    // the app's other limits, so they hold across instances.
    rateLimit: {
      customStorage: {
        consume: async (key, rule) => {
          const decision = await consumeRateLimit({
            key: `auth:${key}`,
            limit: rule.max,
            windowMs: rule.window * 1000,
          });

          return {
            allowed: decision.allowed,
            retryAfter: decision.allowed ? null : decision.retryAfterSeconds,
          };
        },
      },
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
      deferSessionRefresh: true,
    },
    plugins,
    secret,
    user: {
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ newEmail, token, url, user }) => {
          await sendAuthEmail({
            buildContent: (branding) =>
              buildChangeEmailConfirmationMessage({
                branding,
                name: user.name,
                newEmail,
                url,
              }),
            template: "change_email_confirmation",
            to: user.email,
            token,
            url,
            userId: user.id,
          });
        },
        updateEmailWithoutVerification: false,
      },
      // Decides who may create an account. Runs for every new user, however
      // the account comes to be created, so the check in hooks.before above
      // is not the only thing standing in the way.
      validateUserInfo: async ({ source, user }) => {
        if (source.action !== "create-user" || isRunningSetup()) {
          return;
        }

        const decision = await evaluateSignupRequest(
          typeof user.email === "string" ? user.email : "",
          env,
        );

        if (!decision.allowed) {
          return {
            error: decision.code,
            errorDescription: decision.message,
          };
        }
      },
    },
  });
}

export function getAuth(): AppAuth {
  if (cachedAuth) {
    return cachedAuth;
  }

  cachedAuth = createAppAuth();

  return cachedAuth;
}

export async function getAuthSessionFromHeaders(requestHeaders: Headers) {
  const session = await getAuth().api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    return null;
  }

  // The session cookie can vouch for a session for a few minutes on its
  // own. Its row decides: one that was ended (signed out everywhere, reset
  // by an administrator) or that is past the install's limits does not
  // count. See session-controls.ts.
  try {
    const allowed = await enforceSessionLimits(
      session.session.token,
      await getSettings(),
    );

    return allowed ? session : null;
  } catch (error) {
    // A database from before the session controls: nothing to enforce yet.
    if (isMissingSchemaError(error)) {
      return session;
    }

    throw error;
  }
}

const getCachedAuthSession = cache(async () => {
  const requestHeaders = await headers();

  return getAuthSessionFromHeaders(requestHeaders);
});

export function getAuthSession() {
  return getCachedAuthSession();
}

/**
 * For the sign-in and sign-up pages: someone who is already signed in is
 * sent on to their documents. This asks the auth server, so a cookie left
 * over from a session that no longer exists does not count as signed in.
 */
export async function redirectIfSignedIn(): Promise<void> {
  let signedIn = false;

  try {
    signedIn = (await getAuthSession()) !== null;
  } catch (error) {
    // Next.js throws to say a page cannot be built ahead of time. That is
    // not a failure, and it is Next's to handle.
    unstable_rethrow(error);

    // Not being able to ask is no reason to fail a page that shows a form.
    if (!(error instanceof ServiceConfigurationError)) {
      console.error("[auth] Could not check for a session:", error);
    }
  }

  if (signedIn) {
    redirect("/dashboard");
  }
}
