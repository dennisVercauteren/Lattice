import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";

export { expect };

/** The input next to a visible label. Labels in the app are not bound with `htmlFor`, so match the sibling. */
export function field(scope: Page | Locator, label: string): Locator {
  return scope.getByText(label, { exact: true }).locator("xpath=..").locator("input, textarea, button[role=combobox]").first();
}

/** Pick an option in a Radix Select identified by its label. */
export async function selectOption(page: Page, scope: Page | Locator, label: string, option: string) {
  await field(scope, label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Create a component through the Catalog dialog; leaves the page on the new component. */
export async function createComponent(page: Page, type: string, name: string, description = "") {
  await page.goto("/catalog");
  await page.getByRole("button", { name: "New" }).click();
  const dialog = page.getByRole("dialog", { name: "New component" });
  await selectOption(page, dialog, "Type", type);
  await field(dialog, "Name").fill(name);
  if (description) await field(dialog, "Description").fill(description);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("main").getByRole("textbox").first()).toHaveValue(name);
}

/** The "Outgoing" or "Incoming" list on a component's References tab. */
export function refList(page: Page, title: "Outgoing" | "Incoming") {
  return page.getByRole("heading", { name: title, exact: true }).locator("xpath=..");
}

/** Add a reference from the open component's References tab. */
export async function addReference(page: Page, target: string, type: string, via?: string) {
  const panel = page.getByRole("tabpanel");
  await selectOption(page, panel, "Target", target);
  await selectOption(page, panel, "Type", type);
  if (via) await selectOption(page, panel, "Via interface", via);
  await panel.getByRole("button", { name: "Add", exact: true }).click();
}

export function nav(page: Page, label: "Home" | "Catalog" | "Pages" | "Diagrams" | "Metamodel") {
  return page.getByRole("complementary").getByRole("link", { name: label, exact: true });
}

type GuideStep = { title: string; body: string; image: string };

export type Guide = {
  /** Explain a step. With `target`, the element is outlined and the caption is placed next to it. */
  step(title: string, body: string, target?: Locator): Promise<void>;
};

const TRAINING_ROOT = path.resolve(import.meta.dirname, "../training-output");

export const test = base.extend<{ resetWorkspace: void; guide: Guide }>({
  // Every test starts from a fresh Northstar sample in the isolated `lattice-e2e` graphs.
  resetWorkspace: [
    async ({ request }, provide) => {
      const res = await request.post("/api/reset");
      expect(res.ok(), `POST /api/reset failed: ${res.status()}`).toBe(true);
      await provide();
    },
    { auto: true },
  ],

  guide: async ({ page }, provide, testInfo) => {
    const slug = testInfo.titlePath
      .slice(1)
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const dir = path.join(TRAINING_ROOT, slug);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const steps: GuideStep[] = [];

    await provide({
      async step(title, body, target) {
        await test.step(title, async () => {
          if (target) await target.scrollIntoViewIfNeeded();
          const box = target ? await target.boundingBox() : null;
          await page.evaluate(showCallout, { title, body, box });
          const image = `${String(steps.length + 1).padStart(2, "0")}.png`;
          await page.screenshot({ path: path.join(dir, image) });
          await page.evaluate(hideCallout);
          steps.push({ title, body, image });
        });
      },
    });

    // Close the page so the video is finalised, then keep it next to the screenshots.
    const video = page.video();
    await page.close();
    if (video) await video.saveAs(path.join(dir, "walkthrough.webm"));

    const title = testInfo.title;
    const md = [
      `# ${title}`,
      "",
      testInfo.annotations.find((a) => a.type === "summary")?.description ?? "",
      "",
      video ? "Video walkthrough: [walkthrough.webm](walkthrough.webm)\n" : "",
      ...steps.flatMap((s, i) => [`## ${i + 1}. ${s.title}`, "", s.body, "", `![${s.title}](${s.image})`, ""]),
    ].join("\n");
    await writeFile(path.join(dir, "README.md"), md);
  },
});

// Runs in the browser. Kept free of closures so Playwright can serialise it.
function showCallout({ title, body, box }: { title: string; body: string; box: { x: number; y: number; width: number; height: number } | null }) {
  const root = document.createElement("div");
  root.id = "__guide";
  root.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:14px/1.45 system-ui,sans-serif";
  if (box) {
    const ring = document.createElement("div");
    const pad = 6;
    ring.style.cssText = `position:absolute;left:${box.x - pad}px;top:${box.y - pad}px;width:${box.width + pad * 2}px;height:${box.height + pad * 2}px;border:3px solid #f97316;border-radius:10px;box-shadow:0 0 0 9999px rgba(15,23,42,.35)`;
    root.appendChild(ring);
  }
  const card = document.createElement("div");
  const left = box ? Math.min(Math.max(box.x, 16), window.innerWidth - 376) : window.innerWidth - 376;
  const below = box ? box.y + box.height + 18 : 16;
  const top = box && below + 140 > window.innerHeight ? Math.max(box.y - 158, 16) : below;
  card.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:360px;background:#0f172a;color:#f8fafc;border-radius:10px;padding:12px 14px;box-shadow:0 10px 30px rgba(0,0,0,.3)`;
  const h = document.createElement("div");
  h.textContent = title;
  h.style.cssText = "font-weight:600;margin-bottom:4px;color:#fdba74";
  const p = document.createElement("div");
  p.textContent = body;
  card.append(h, p);
  root.appendChild(card);
  document.body.appendChild(root);
}

function hideCallout() {
  document.getElementById("__guide")?.remove();
}
