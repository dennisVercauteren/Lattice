import { expect, field, nav, selectOption, test } from "../fixtures";

test.describe("catalog", () => {
  test("create an application and find it in the catalog", async ({ page }) => {
    await page.goto("/catalog");
    await page.getByRole("button", { name: "New" }).click();

    const dialog = page.getByRole("dialog", { name: "New component" });
    await selectOption(page, dialog, "Type", "Application");
    await field(dialog, "Name").fill("Billing API");
    await field(dialog, "Description").fill("Issues invoices and tracks payment state.");
    await dialog.getByRole("button", { name: "Create" }).click();

    await expect(page).toHaveURL(/\/catalog\/cmp_/);
    await expect(page.getByRole("main").getByRole("textbox").first()).toHaveValue("Billing API");

    await nav(page, "Catalog").click();
    await expect(page.getByRole("link", { name: /Billing API/ })).toBeVisible();
  });

  test("delete a component", async ({ page }) => {
    await page.goto("/catalog");
    await page.getByRole("link", { name: /Northstar Web/ }).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

    await expect(page).toHaveURL(/\/catalog$/);
    await expect(page.getByRole("link", { name: /Northstar Web/ })).toHaveCount(0);
  });
});
