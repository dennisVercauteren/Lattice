import { afterAll, describe, expect, it } from "vitest";
import { buildSampleWorkspace } from "@/data/seed";
import { draftForType } from "@/lib/draft";
import { createId, nowIso } from "@/lib/ids";
import type { Component } from "@/schema/component";
import type { Page } from "@/schema/page";
import { GraphStore } from "./graph";
import { GraphRepo } from "./repository";

// Needs FalkorDB (`pnpm db:up`). Skipped when it is not reachable.
const store = await GraphStore.connect().catch(() => null);
const prefix = `lattice-test-${createId("run").slice(4)}`;

afterAll(async () => {
  if (!store) return;
  await new GraphRepo(store, { prefix }).destroyAll();
  await store.close();
});

let counter = 0;
function repo() {
  return new GraphRepo(store!, { prefix: `${prefix}:${counter++}` });
}

function component(workspaceId: string, type: Component["type"], name: string): Component {
  const now = nowIso();
  return {
    ...draftForType(type, name),
    id: createId("component"),
    workspaceId,
    createdAt: now,
    updatedAt: now,
  } as Component;
}

function page(workspaceId: string, title: string, extra: Partial<Page> = {}): Page {
  const now = nowIso();
  return {
    id: createId("page"),
    workspaceId,
    title,
    slug: title.toLowerCase(),
    order: 0,
    doc: { type: "doc", content: [{ type: "paragraph" }] },
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

async function workspace(r: GraphRepo, name = "Test") {
  const ws = await r.createEmptyWorkspace(name);
  if (!ws.ok) throw new Error("could not create workspace");
  return ws.data.id;
}

async function load(r: GraphRepo, id: string) {
  const loaded = await r.loadWorkspace(id);
  if (!loaded.ok) throw new Error("could not load workspace");
  return loaded.data;
}

describe.skipIf(!store)("GraphRepo", () => {
  it("creates a workspace, component, auto-page, and typed reference", async () => {
    const r = repo();
    const ws = await workspace(r, "Lattice");
    const cap = await r.createComponent(component(ws, "capability", "Sell"));
    const app = await r.createComponent(component(ws, "application", "Shop"));
    expect(cap.ok && app.ok).toBe(true);
    if (!cap.ok || !app.ok) return;
    const now = nowIso();
    const ref = await r.createReference({
      id: createId("reference"),
      workspaceId: ws,
      type: "supports",
      sourceId: app.data.id,
      targetId: cap.data.id,
      createdAt: now,
      updatedAt: now,
    });
    expect(ref.ok).toBe(true);
    const loaded = await load(r, ws);
    expect(loaded.pages.some((p) => p.componentId === app.data.id)).toBe(true);
    expect(loaded.references).toHaveLength(1);
    expect(loaded.components.find((c) => c.id === app.data.id)).toMatchObject({
      type: "application",
      lifecycle: app.data.type === "application" ? app.data.lifecycle : undefined,
    });
  });

  it("rejects a reference the metamodel does not allow", async () => {
    const r = repo();
    const ws = await workspace(r);
    const person = await r.createComponent(component(ws, "person", "Ada"));
    const tech = await r.createComponent(component(ws, "technology", "Postgres"));
    if (!person.ok || !tech.ok) throw new Error("setup failed");
    const now = nowIso();
    const ref = await r.createReference({
      id: createId("reference"),
      workspaceId: ws,
      type: "runs_on",
      sourceId: person.data.id,
      targetId: tech.data.id,
      createdAt: now,
      updatedAt: now,
    });
    expect(ref.ok).toBe(false);
    if (!ref.ok) expect(ref.errors[0]?.path).toBe("type");
  });

  it("derives parentId from the contains edge and clears it with a null patch", async () => {
    const r = repo();
    const ws = await workspace(r);
    const parent = await r.createComponent(component(ws, "capability", "Parent"));
    if (!parent.ok) throw new Error("setup failed");
    const child = await r.createComponent({ ...component(ws, "capability", "Child"), parentId: parent.data.id });
    if (!child.ok) throw new Error("setup failed");

    let loaded = await load(r, ws);
    expect(loaded.components.find((c) => c.id === child.data.id)?.parentId).toBe(parent.data.id);
    expect(loaded.references.filter((ref) => ref.type === "contains")).toHaveLength(1);

    const cycle = await r.updateComponent(ws, parent.data.id, { parentId: child.data.id });
    expect(cycle.ok).toBe(false);

    const cleared = await r.updateComponent(ws, child.data.id, { parentId: null });
    expect(cleared.ok).toBe(true);
    loaded = await load(r, ws);
    expect(loaded.components.find((c) => c.id === child.data.id)?.parentId).toBeUndefined();
    expect(loaded.references.filter((ref) => ref.type === "contains")).toHaveLength(0);
  });

  it("renames the auto-page with its component", async () => {
    const r = repo();
    const ws = await workspace(r);
    const created = await r.createComponent(component(ws, "process", "Order to Cash"));
    if (!created.ok) throw new Error("setup failed");
    await r.updateComponent(ws, created.data.id, { name: "Quote to Cash" });
    const loaded = await load(r, ws);
    expect(loaded.pages.find((p) => p.componentId === created.data.id)?.title).toBe("Quote to Cash");
  });

  it("blocks deleting a page that still has children, and page parent cycles", async () => {
    const r = repo();
    const ws = await workspace(r, "Docs");
    const parent = await r.createPage(page(ws, "Parent"));
    if (!parent.ok) throw new Error("setup failed");
    const child = await r.createPage(page(ws, "Child", { parentId: parent.data.id }));
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect((await r.deletePage(ws, parent.data.id)).ok).toBe(false);
    expect((await r.updatePage(ws, parent.data.id, { parentId: child.data.id })).ok).toBe(false);
  });

  it("rejects unknown schemaVersion and accepts a valid import", async () => {
    const r = repo();
    const rejected = await r.importBundle({ ...buildSampleWorkspace(), schemaVersion: "9.9.9" }, { type: "new" });
    expect(rejected.ok).toBe(false);
    const accepted = await r.importBundle(buildSampleWorkspace(), { type: "new" });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.data.workspace.id).not.toBe("ws_northstar");
    expect(accepted.data.components.length).toBeGreaterThan(0);
  });

  it("round-trips the Northstar sample through the graph unchanged", async () => {
    const r = repo();
    const sample = buildSampleWorkspace();
    await r.seedIfEmpty();
    const exported = await r.exportBundle(sample.workspace.id);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
    expect(exported.data.workspace).toEqual(sample.workspace);
    expect(byId(exported.data.components)).toEqual(byId(sample.components));
    expect(byId(exported.data.references)).toEqual(byId(sample.references));
    expect(byId(exported.data.pages)).toEqual(byId(sample.pages));
    expect(byId(exported.data.diagrams)).toEqual(byId(sample.diagrams));
  });

  it("clears viaId and diagram nodes when a component is deleted", async () => {
    const r = repo();
    const imported = await r.importBundle(buildSampleWorkspace(), { type: "new" });
    if (!imported.ok) throw new Error("setup failed");
    const ws = imported.data.workspace.id;
    const iface = imported.data.components.find((c) => c.type === "interface");
    expect(iface).toBeTruthy();
    if (!iface) return;
    const shown = imported.data.diagrams
      .flatMap((d) => d.view.nodes)
      .find((n) => n.componentId)?.componentId;

    expect((await r.deleteComponent(ws, iface.id)).ok).toBe(true);
    let loaded = await load(r, ws);
    expect(loaded.references.some((ref) => ref.viaId === iface.id)).toBe(false);
    expect(loaded.references.some((ref) => ref.type === "integrates_with")).toBe(true);
    expect(loaded.pages.some((p) => p.componentId === iface.id)).toBe(false);

    if (shown) {
      expect((await r.deleteComponent(ws, shown)).ok).toBe(true);
      loaded = await load(r, ws);
      expect(loaded.diagrams.flatMap((d) => d.view.nodes).some((n) => n.componentId === shown)).toBe(false);
    }
    expect((await r.exportBundle(ws)).ok).toBe(true);
  });

  it("replaces a workspace in place and keeps its id", async () => {
    const r = repo();
    const ws = await workspace(r, "Target");
    const replaced = await r.importBundle(buildSampleWorkspace(), { type: "replace", workspaceId: ws });
    expect(replaced.ok).toBe(true);
    const loaded = await load(r, ws);
    expect(loaded.workspace.id).toBe(ws);
    expect(loaded.components.length).toBeGreaterThan(0);
    expect((await r.listWorkspaces()).filter((w) => w.id === ws)).toHaveLength(1);
  });

  it("makes component type immutable", async () => {
    const r = repo();
    const ws = await workspace(r, "Types");
    const created = await r.createComponent(component(ws, "process", "Order to Cash"));
    if (!created.ok) throw new Error("setup failed");
    const updated = await r.updateComponent(ws, created.data.id, { type: "application" });
    expect(updated.ok).toBe(false);
  });

  it("refuses to delete the last workspace", async () => {
    const r = repo();
    const ws = await workspace(r);
    expect((await r.deleteWorkspace(ws)).ok).toBe(false);
    const second = await workspace(r, "Second");
    expect((await r.deleteWorkspace(second)).ok).toBe(true);
    expect(await r.listWorkspaces()).toHaveLength(1);
  });
});
