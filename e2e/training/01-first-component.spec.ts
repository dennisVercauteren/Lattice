import { expect, field, selectOption, test } from "../fixtures";

test("Add your first component to the catalog", async ({ page, guide }) => {
  test.info().annotations.push({
    type: "summary",
    description:
      "Components are the building blocks of the architecture graph. This guide adds an application to the Northstar sample and shows where it appears.",
  });

  await page.goto("/");
  await guide.step(
    "Start on Home",
    "Home summarises the current workspace: how many components, references, pages and diagrams it holds.",
    page.getByRole("main").getByText("Components", { exact: true }).locator("xpath=.."),
  );

  const catalogLink = page.getByRole("complementary").getByRole("link", { name: "Catalog", exact: true });
  await guide.step("Open the Catalog", "The Catalog lists every component in the graph, grouped by type.", catalogLink);
  await catalogLink.click();

  const newButton = page.getByRole("button", { name: "New" });
  await guide.step("Create a component", "Click New to open the create dialog.", newButton);
  await newButton.click();

  const dialog = page.getByRole("dialog", { name: "New component" });
  await selectOption(page, dialog, "Type", "Application");
  await field(dialog, "Name").fill("Billing API");
  await field(dialog, "Description").fill("Issues invoices and tracks payment state.");
  await guide.step(
    "Choose a type and name it",
    "Pick the type first: it decides which fields and relationships are allowed, and it cannot be changed later.",
    dialog,
  );

  await dialog.getByRole("button", { name: "Create" }).click();
  const name = page.getByRole("main").getByRole("textbox").first();
  await expect(name).toHaveValue("Billing API");
  await guide.step(
    "Fill in the details",
    "You land on the component page. Use Fields for properties, Docs for prose, and References to connect it to the rest of the graph.",
    page.getByRole("tablist"),
  );
});
