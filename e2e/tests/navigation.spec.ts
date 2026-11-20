import { expect, nav, test } from "../fixtures";

test.describe("navigation", () => {
  test("home opens on the Northstar sample", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("button", { name: "Northstar" })).toBeVisible();
    await expect(page.getByText("Components", { exact: true })).toBeVisible();
  });

  test("sidebar reaches every section", async ({ page }) => {
    await page.goto("/");
    for (const [label, url] of [
      ["Catalog", /\/catalog$/],
      ["Pages", /\/pages/],
      ["Diagrams", /\/diagrams/],
      ["Metamodel", /\/settings\/metamodel$/],
      ["Home", /\/$/],
    ] as const) {
      await nav(page, label).click();
      await expect(page).toHaveURL(url);
    }
  });

  test("global search opens a component", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Search catalog and pages").fill("Northstar Web");
    await page.getByRole("button", { name: /Northstar Web/ }).first().click();
    await expect(page).toHaveURL(/\/catalog\/cmp_/);
    await expect(page.getByRole("main").getByRole("textbox").first()).toHaveValue("Northstar Web");
  });
});
