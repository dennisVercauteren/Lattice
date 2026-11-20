import { createComponent, expect, field, refList, test } from "../fixtures";

test("Connect components with references", async ({ page, guide }) => {
  test.info().annotations.push({
    type: "summary",
    description:
      "References are the typed links between components (supports, uses, integrates with, …). They are what turn a list of components into an architecture graph, and they drive the live maps. This guide connects a new reporting application to the rest of Northstar.",
  });

  await test.step("Setup: create the Invoice Reports application", () =>
    createComponent(page, "Application", "Invoice Reports", "Monthly revenue and overdue-invoice reports."),
  );

  const refsTab = page.getByRole("tab", { name: "References" });
  await guide.step(
    "Open the References tab",
    "Every component page has a References tab. It shows what this component points to (outgoing) and what points to it (incoming).",
    refsTab,
  );
  await refsTab.click();

  const panel = page.getByRole("tabpanel");
  await guide.step(
    "A new component is not connected yet",
    "Invoice Reports has no references yet. The bar at the top adds a new one: pick a target, then a reference type.",
    panel,
  );

  // 1. supports → capability
  await field(panel, "Target").click();
  await page.getByRole("option", { name: "Invoicing", exact: true }).click();
  await field(panel, "Type").click();
  await expect(page.getByRole("option")).toHaveText(["supports"]);
  await guide.step(
    "Only legal types are offered",
    "The metamodel decides which links make sense. From an application to a capability the only option is \"supports\", so you cannot create a link that breaks the model.",
    page.getByRole("listbox"),
  );
  await page.getByRole("option", { name: "supports", exact: true }).click();
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(refList(page, "Outgoing")).toContainText("supports Invoicing");
  await guide.step(
    "Add the reference",
    "Click Add. The link is saved to the graph right away and appears under Outgoing.",
    refList(page, "Outgoing"),
  );

  // 2. uses → technology
  await field(panel, "Target").click();
  await page.getByRole("option", { name: "PostgreSQL", exact: true }).click();
  await field(panel, "Type").click();
  await expect(page.getByRole("option")).toHaveText(["uses", "runs on"]);
  await guide.step(
    "Different targets allow different types",
    "For a technology such as PostgreSQL you can choose \"uses\" or \"runs on\". Here the reports read from the database, so pick \"uses\".",
    page.getByRole("listbox"),
  );
  await page.getByRole("option", { name: "uses", exact: true }).click();
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(refList(page, "Outgoing")).toContainText("uses PostgreSQL");

  // 3. integrates with → application, via interface
  await field(panel, "Target").click();
  await page.getByRole("option", { name: "Stripe", exact: true }).click();
  await field(panel, "Type").click();
  await page.getByRole("option", { name: "integrates with", exact: true }).click();
  await field(panel, "Via interface").click();
  await page.getByRole("option", { name: "Stripe Payments API", exact: true }).click();
  await guide.step(
    "Integrations can name the interface",
    "When one application integrates with another, you can say which interface carries the integration. Here the reports pull payouts from Stripe through the Stripe Payments API.",
    panel.locator("div").filter({ has: page.getByRole("button", { name: "Add", exact: true }) }).first(),
  );
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(refList(page, "Outgoing")).toContainText("integrates with Stripe via Stripe Payments API");
  await guide.step(
    "Review the outgoing references",
    "Invoice Reports now supports a capability, uses a database and integrates with Stripe. Click any name to jump to that component. Remove deletes the link (not the component).",
    refList(page, "Outgoing"),
  );

  // Other side
  await refList(page, "Outgoing").getByRole("link", { name: "Invoicing" }).click();
  await page.getByRole("tab", { name: "References" }).click();
  await expect(refList(page, "Incoming")).toContainText("supports Invoice Reports");
  await guide.step(
    "Each reference has two sides",
    "On the Invoicing capability, the same link shows up under Incoming. You add a reference once, from its source, and both components show it.",
    refList(page, "Incoming"),
  );
});
