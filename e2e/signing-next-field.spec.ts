import { expect, test } from "@playwright/test";

import { E2E_PASSWORD } from "./support/admin-session";
import { extractLink, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

const SIGNER_EMAIL = "next.field@example.com";

test("Next field follows incomplete signatures across pages and disables when done", async ({
  browser,
  page,
}, testInfo) => {
  await test.step("the sender places one signature field on each page", async () => {
    const runId = String(Date.now());

    await page.goto("/setup");
    await page.getByLabel("Organization name").fill("Next Field Test");
    await page.getByLabel("Your name").fill("Nora Administrator");
    await page.getByLabel("Your email").fill(`admin+${runId}@example.com`);
    await page.getByLabel("Password").fill(E2E_PASSWORD);
    await page.getByLabel("Support email").fill(`support+${runId}@example.com`);
    await page.getByLabel("Setup token").fill("e2e-setup-token");
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect(page).toHaveURL(/\/settings#organization$/);

    const pdfPath = await writeSamplePdf(testInfo.outputPath("next-field.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Next field navigation");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill("Nora Navigation");
    await page.getByLabel("Signer 1 email").fill(SIGNER_EMAIL);
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);

    for (const pageNumber of [1, 2]) {
      if (pageNumber === 2) {
        await page.getByRole("button", { name: "Next page" }).click();
      }

      await page
        .getByRole("button", { exact: true, name: "Signature" })
        .click();
      const placementTarget = page.getByLabel(
        `Place Signature on page ${String(pageNumber)}`,
      );
      const box = await placementTarget.boundingBox();

      expect(box).not.toBeNull();
      await placementTarget.click({
        position: { x: box!.width * 0.3, y: box!.height * 0.65 },
      });
      await expect(page.getByRole("status")).toHaveText("Saved");
    }

    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/review$/);
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "Send now" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+$/);
  });

  const invitation = await waitForEmail({
    template: "signing_invitation",
    to: SIGNER_EMAIL,
  });
  const signerContext = await browser.newContext({
    viewport: { height: 900, width: 1440 },
  });
  const signerPage = await signerContext.newPage();

  await signerPage.goto(extractLink(invitation.text, "/sign/"));

  const consent = signerPage.getByRole("dialog", { name: "Before you sign" });

  await consent
    .getByRole("checkbox", {
      name: "I agree to use electronic records and signatures",
    })
    .check();
  await consent.getByRole("button", { name: "Agree and continue" }).click();
  await expect(consent).toBeHidden();

  const nextField = signerPage.getByRole("button", {
    name: /Go to next required field/,
  });
  const firstField = signerPage.getByRole("button", {
    exact: true,
    name: "Signature",
  });

  await expect(signerPage.getByText("Page 1 of 2")).toBeVisible();
  await nextField.click();
  await expect(firstField).toBeFocused();
  await firstField.press("Enter");

  const firstSignatureDialog = signerPage.getByRole("dialog", {
    name: "Add your signature",
  });

  await firstSignatureDialog
    .getByLabel("Type signature")
    .fill("Nora Navigation");
  await firstSignatureDialog
    .getByRole("button", { name: "Apply signature" })
    .click();
  await expect(firstField).toBeFocused();

  await nextField.click();
  await expect(signerPage.getByText("Page 2 of 2")).toBeVisible();
  await expect(
    signerPage.getByRole("img", { name: "Rendered PDF page 2" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      signerPage.evaluate(() =>
        document.activeElement?.getAttribute("data-signing-field-id"),
      ),
    )
    .not.toBeNull();

  const secondFieldId = await signerPage.evaluate(() =>
    document.activeElement?.getAttribute("data-signing-field-id"),
  );
  const secondField = signerPage.locator(
    `[data-signing-field-id="${secondFieldId}"]`,
  );

  await expect(secondField).toBeFocused();
  await secondField.press("Enter");
  await expect(
    signerPage.getByText("All required fields complete"),
  ).toBeVisible();
  await expect(nextField).toBeDisabled();

  await signerContext.close();
});
