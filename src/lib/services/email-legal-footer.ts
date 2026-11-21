import { SIGNUDOC_NAME, type Branding } from "../branding.ts";
import {
  buildBrandPalette,
  DEFAULT_BRAND_COLOR,
} from "../brand-color.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";
import { escapeHtml } from "../utils/html.ts";
import { requireConfigValue } from "./service-config.ts";

type EmailBodyContent = {
  htmlBody: string;
  textBody: string;
};

type FooterLink = {
  label: string;
  url: string;
};

// Links may be pages on this site ("/terms") or the organization's own
// absolute URLs. Either way the email gets an absolute URL.
function buildFooterLinks(branding: Branding, env: EnvSource): FooterLink[] {
  const candidates: Array<[label: string, url: string | null]> = [
    ["Terms of Service", branding.termsUrl],
    // Without the organization's own policy, the notice built from the
    // install's settings.
    branding.privacyUrl || branding.hosted
      ? ["Privacy Policy", branding.privacyUrl]
      : ["Privacy notice", getEnv(env).appUrl ? "/signer-privacy" : null],
    ["Contact", branding.contactUrl],
  ];
  const links = candidates.filter((candidate): candidate is [string, string] =>
    Boolean(candidate[1]),
  );

  if (links.length === 0) {
    return [];
  }

  const appUrl = requireConfigValue("app", "APP_URL", getEnv(env).appUrl);

  return links.map(([label, url]) => ({
    label,
    url: new URL(url, appUrl).toString(),
  }));
}

/**
 * The install's logo for the top of an email, or nothing when it has none.
 * Email programs fetch it from this site, so it needs the site's address;
 * many hide pictures until asked, which is why the name is the alt text.
 */
function buildLogoHeader(branding: Branding, env: EnvSource): string {
  const appUrl = getEnv(env).appUrl;

  if (!branding.logoUrl || !appUrl) {
    return "";
  }

  const source = new URL(branding.logoUrl, appUrl).toString();

  return [
    '<p style="margin:0 0 24px;">',
    `<img src="${escapeHtml(source)}" alt="${escapeHtml(branding.productName)}" height="40" `,
    'style="display:block;height:40px;width:auto;max-width:240px;border:0;" />',
    "</p>",
  ].join("");
}

/**
 * Appends the footer every email to a person carries: the install's terms,
 * privacy and contact links, where it has them. On a neutral install the
 * footer also names the organization's support address and says the message
 * was sent with SignuDoc, and the organization's logo, when it has one,
 * goes at the top.
 */
export function withUserEmailLegalFooter(
  input: EmailBodyContent,
  branding: Branding,
  env: EnvSource = process.env,
): EmailBodyContent {
  const links = buildFooterLinks(branding, env);
  const logoHeader = buildLogoHeader(branding, env);
  // The shared frame uses a normalized, contrast-safe color. Hosted mode
  // intentionally has no install branding and therefore uses SignuDoc's
  // default color.
  const palette = buildBrandPalette(
    branding.hosted
      ? DEFAULT_BRAND_COLOR
      : (branding.brandColor ?? DEFAULT_BRAND_COLOR),
  );
  const accent = palette?.accent ?? DEFAULT_BRAND_COLOR;
  const accentInk = palette?.accentInk ?? accent;
  const textLines: string[] = [];
  const htmlLines: string[] = [];

  for (const link of links) {
    textLines.push("", `${link.label}:`, link.url);
    htmlLines.push(`<a href="${escapeHtml(link.url)}">${link.label}</a>`);
  }

  if (!branding.hosted) {
    if (branding.supportAddress) {
      textLines.push("", `Questions? Contact ${branding.supportAddress}.`);
      htmlLines.push(
        `Questions? Contact <a href="mailto:${escapeHtml(branding.supportAddress)}">${escapeHtml(branding.supportAddress)}</a>.`,
      );
    }

    const sentBy = branding.organizationName
      ? `Sent by ${branding.organizationName} using ${SIGNUDOC_NAME}.`
      : `Sent using ${SIGNUDOC_NAME}.`;

    textLines.push("", sentBy);
    htmlLines.push(escapeHtml(sentBy));
  }

  const htmlFooter = htmlLines.length
    ? [
        '<hr style="margin:24px 0;border:none;border-top:1px solid #e2e2e2;" />',
        `<p style="margin:0;color:#5b6072;font:12px/1.6 Arial,sans-serif;">${htmlLines.join("<br />")}</p>`,
      ].join("")
    : "";
  const brandName = escapeHtml(
    branding.hosted
      ? branding.productName
      : (branding.organizationName ?? branding.productName),
  );
  const htmlFrame = [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#f5f6fa;">',
    '<tbody><tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #e3e5ec;border-radius:12px;">',
    `<tbody><tr><td style="height:5px;background:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>`,
    `<tr><td style="padding:28px 32px 32px;font:15px/1.6 Arial,sans-serif;color:#202332;"><p style="margin:0 0 20px;color:${accentInk};font:600 13px/1.4 Arial,sans-serif;">${brandName}</p>`,
    input.htmlBody,
    htmlFooter,
    '</td></tr></tbody></table></td></tr></tbody></table>',
  ].join("");

  return {
    // Keep the logo first for mail clients that hide later remote images;
    // every value in the frame's CSS comes from the safe palette above.
    htmlBody: `${logoHeader}${htmlFrame}`,
    // Each entry starts with an empty line; one more newline puts that
    // empty line between the message and the footer.
    textBody: `${input.textBody}\n${textLines.join("\n")}`,
  };
}
