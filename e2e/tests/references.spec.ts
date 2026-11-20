import { addReference, createComponent, expect, field, refList, selectOption, test } from "../fixtures";

test.describe("references", () => {
  test.beforeEach(async ({ page }) => {
    await createComponent(page, "Application", "Invoice Reports");
    await page.getByRole("tab", { name: "References" }).click();
  });

  test("a new component starts with no references", async ({ page }) => {
    await expect(refList(page, "Outgoing")).toContainText("None");
    await expect(refList(page, "Incoming")).toContainText("None");
  });

  test("only legal reference types are offered for the chosen target", async ({ page }) => {
    const panel = page.getByRole("tabpanel");

    // Application → Capability: the metamodel allows only "supports".
    await field(panel, "Target").click();
    await page.getByRole("option", { name: "Invoicing", exact: true }).click();
    await field(panel, "Type").click();
    await expect(page.getByRole("option")).toHaveText(["supports"]);
    await page.keyboard.press("Escape");

    // Application → Technology: "uses" or "runs on".
    await field(panel, "Target").click();
    await page.getByRole("option", { name: "PostgreSQL", exact: true }).click();
    await field(panel, "Type").click();
    await expect(page.getByRole("option")).toHaveText(["uses", "runs on"]);
  });

  test("an outgoing reference shows as incoming on the target", async ({ page }) => {
    await addReference(page, "Invoicing", "supports");
    const outgoing = refList(page, "Outgoing");
    await expect(outgoing).toContainText("supports Invoicing");

    await outgoing.getByRole("link", { name: "Invoicing" }).click();
    await page.getByRole("tab", { name: "References" }).click();
    await expect(refList(page, "Incoming")).toContainText("supports Invoice Reports");
  });

  test("integrates with can go via an interface", async ({ page }) => {
    await addReference(page, "Stripe", "integrates with", "Stripe Payments API");
    await expect(refList(page, "Outgoing")).toContainText("integrates with Stripe via Stripe Payments API");
  });

  test("the add-reference draft does not carry over to another component", async ({ page }) => {
    await addReference(page, "Invoicing", "supports");

    // Leave an unsaved "integrates with Stripe via Stripe Payments API" draft in the bar.
    const panel = page.getByRole("tabpanel");
    await selectOption(page, panel, "Target", "Stripe");
    await selectOption(page, panel, "Type", "integrates with");
    await selectOption(page, panel, "Via interface", "Stripe Payments API");

    // Follow the link to the Invoicing capability: same route, different component.
    await refList(page, "Outgoing").getByRole("link", { name: "Invoicing" }).click();
    await expect(page.getByRole("main").getByRole("textbox").first()).toHaveValue("Invoicing");
    await page.getByRole("tab", { name: "References" }).click();

    const fresh = page.getByRole("tabpanel");
    await expect(field(fresh, "Target")).toHaveText("Choose object");
    await expect(field(fresh, "Type")).not.toHaveText("integrates with");
    await expect(fresh.getByText("Via interface", { exact: true })).toHaveCount(0);
  });

  test("removing a reference clears it on both sides", async ({ page }) => {
    await addReference(page, "PostgreSQL", "uses");
    const outgoing = refList(page, "Outgoing");
    await expect(outgoing).toContainText("uses PostgreSQL");

    await outgoing.getByRole("button", { name: "Remove" }).click();
    await expect(outgoing).toContainText("None");

    await page.reload();
    await page.getByRole("tab", { name: "References" }).click();
    await expect(refList(page, "Outgoing")).toContainText("None");
  });
});
