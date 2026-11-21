import { isIP } from "node:net";

import { logSecurityEvent } from "./logging.ts";

type IpEnv = Record<string, string | undefined>;

function firstAddress(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

/** An address on a private network, or the machine itself. */
function isInternalAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);

    return (
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (version === 6) {
    const lower = address.toLowerCase();

    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80:") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.")
    );
  }

  return false;
}

/**
 * The visitor's address from an X-Forwarded-For list. Each proxy adds the
 * address it was reached from at the end, so anything at the start may be
 * the visitor's own invention. Read from the end, passing over the
 * install's own proxies on a private network: the first address left is
 * the one the outermost proxy saw.
 */
function forwardedForAddress(value: string | null): string | null {
  const addresses = (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    const address = addresses[index]!;

    if (!isInternalAddress(address)) {
      return address;
    }
  }

  return addresses[0] ?? null;
}

let warnedAboutTrustedProxyHops = false;

function configuredProxyHops(env: IpEnv): number | null {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();

  if (!raw) {
    return null;
  }

  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    if (!warnedAboutTrustedProxyHops) {
      warnedAboutTrustedProxyHops = true;
      logSecurityEvent("warn", {
        category: "client_ip_config",
        message:
          "TRUSTED_PROXY_HOPS is not a whole number of 0 or more; using the default client address handling.",
        metadata: { variable: "TRUSTED_PROXY_HOPS", value: raw },
      });
    }

    return null;
  }

  return Number(raw);
}

function addressFromRight(value: string | null, hops: number): string | null {
  const addresses = (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  return hops < addresses.length
    ? addresses[addresses.length - 1 - hops]!
    : null;
}

/**
 * The headers that carry the visitor's address, most trustworthy first.
 *
 * On Vercel, x-vercel-forwarded-for and x-real-ip are written by Vercel
 * itself and cannot be set by the visitor, so they come first.
 * https://vercel.com/docs/headers/request-headers
 *
 * Anywhere else those two names mean nothing special and anyone could send
 * them, so the usual proxy headers are used instead. There the app has to
 * sit behind a reverse proxy that sets them: X-Forwarded-For is read from
 * its end, so what a visitor puts at its start does not count. An explicit
 * TRUSTED_PROXY_HOPS setting selects the address before the configured hops.
 */
export function getClientIpHeaderNames(env: IpEnv = process.env): string[] {
  return env.VERCEL === "1"
    ? ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]
    : ["x-forwarded-for", "cf-connecting-ip", "x-real-ip"];
}

export function getClientIpAddress(
  headers: Headers,
  env: IpEnv = process.env,
): string | null {
  const offVercel = env.VERCEL !== "1";
  const proxyHops = offVercel ? configuredProxyHops(env) : null;

  if (offVercel && proxyHops !== null) {
    // When operators configure an exact X-Forwarded-For chain, do not fall
    // back to alternate headers that may not have been sanitized by it.
    return addressFromRight(headers.get("x-forwarded-for"), proxyHops);
  }

  for (const name of getClientIpHeaderNames(env)) {
    const address =
      offVercel && name === "x-forwarded-for"
        ? forwardedForAddress(headers.get(name))
        : firstAddress(headers.get(name));

    if (address) {
      return address;
    }
  }

  return null;
}

export function getRequestUserAgent(headers: Headers): string | null {
  // A header sent with no value reads as "", which the audit schema
  // rejects; it counts as no user agent at all.
  return headers.get("user-agent")?.trim() || null;
}

/** Who made a request, as the audit trail records it. */
export type RequestClient = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export function getRequestClient(
  headers: Headers | null | undefined,
  env: IpEnv = process.env,
): { ipAddress: string | null; userAgent: string | null } {
  if (!headers) {
    return { ipAddress: null, userAgent: null };
  }

  return {
    ipAddress: getClientIpAddress(headers, env),
    userAgent: getRequestUserAgent(headers),
  };
}

export function getRequestPathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/";
  }
}
