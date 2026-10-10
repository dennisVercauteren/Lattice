import type { z } from "zod";
import { buildEmptyWorkspace, buildSampleWorkspace } from "@/data/seed";
import { createId, nowIso, slugify } from "@/lib/ids";
import { integrityErrors, stripDanglingDiagramNodes } from "@/lib/integrity";
import { bundleSchema, type Bundle } from "@/schema/bundle";
import { SCHEMA_VERSION } from "@/schema/common";
import { componentSchema, type Component } from "@/schema/component";
import { diagramSchema, type Diagram } from "@/schema/diagram";
import { isReferenceAllowed } from "@/schema/metamodel";
import {
  assertHttpsImages,
  assertMentions,
  collectMentions,
  emptyDoc,
  pageSchema,
  type Page,
  type TiptapDoc,
} from "@/schema/page";
import { referenceSchema, type Reference } from "@/schema/reference";
import { fieldPathErrors, type FieldError, type Result } from "@/schema/result";
import { workspaceSchema, type Workspace } from "@/schema/workspace";
import { remapBundle } from "./bundle";
import {
  compact,
  componentLabel,
  componentRelTypes,
  referenceTypeOf,
  relType,
  type Statement,
} from "./cypher";
import type { GraphStore } from "./graph";

/*
 * Storage layout
 *   <prefix>:meta            (:Workspace {…workspace, graph})
 *   <prefix>:ws:<id>:<rand>  one graph per workspace, pointed to by Workspace.graph
 *     (:Component:<Type>)    type-specific fields are plain properties
 *     (:Component)-[:<REFERENCE_TYPE> {id, viaId?, description?}]->(:Component)
 *     (:Page)-[:CHILD_OF]->(:Page)   (:Page)-[:DESCRIBES|MENTIONS]->(:Component)
 *     (:Diagram)-[:SHOWS]->(:Component)
 * parentId / ownerId are derived from CONTAINS / OWNED_BY edges on read; they are never stored.
 * Page docs and diagram query/view are JSON strings.
 */

type Props = Record<string, unknown>;
type Loaded = { graph: string; bundle: Bundle };
type WorkspaceRecord = { graph: string; workspace: Workspace };

function fail(errors: FieldError[]): Result<never> {
  return { ok: false, errors };
}

function failMsg(path: string, message: string): Result<never> {
  return fail([{ path, message }]);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): Result<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return fail(fieldPathErrors(result.error));
}

/** JSON cannot carry `undefined`, so a top-level `null` in a patch clears that field. */
function applyPatch(current: object, patch: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function omit<T extends object, K extends keyof T>(value: T, keys: K[]): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

function groupBy<T, K>(items: T[], key: (item: T) => K) {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

/** True when walking up from `start` reaches `target`. */
function reaches(parentOf: (id: string) => string | undefined, start: string | undefined, target: string) {
  const seen = new Set<string>();
  for (let cursor = start; cursor && !seen.has(cursor); cursor = parentOf(cursor)) {
    if (cursor === target) return true;
    seen.add(cursor);
  }
  return false;
}

function docErrors(doc: TiptapDoc): FieldError[] {
  return [...assertMentions(doc), ...assertHttpsImages(doc)].map((message) => ({ path: "doc", message }));
}

const componentProps = (component: Component) =>
  compact(omit(component, ["workspaceId", "parentId", "ownerId"]) as Props);

const referenceProps = (reference: Reference) =>
  compact({
    id: reference.id,
    viaId: reference.viaId,
    description: reference.description,
    createdAt: reference.createdAt,
    updatedAt: reference.updatedAt,
  });

const pageProps = (page: Page) =>
  compact({
    id: page.id,
    title: page.title,
    slug: page.slug,
    order: page.order,
    doc: JSON.stringify(page.doc),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  });

const diagramProps = (diagram: Diagram) =>
  compact({
    id: diagram.id,
    name: diagram.name,
    kind: diagram.kind,
    query: diagram.query ? JSON.stringify(diagram.query) : undefined,
    view: JSON.stringify(diagram.view),
    createdAt: diagram.createdAt,
    updatedAt: diagram.updatedAt,
  });

const INDEXES: Statement[] = ["Component", "Page", "Diagram"].map((label) => ({
  query: `CREATE INDEX FOR (n:${label}) ON (n.id)`,
}));

function link(rel: string, from: string, to: string, rows: Array<{ from: string; to: string }>): Statement[] {
  if (rows.length === 0) return [];
  return [
    {
      query: `UNWIND $rows AS row MATCH (a:${from} {id: row.from}), (b:${to} {id: row.to}) CREATE (a)-[:${rel}]->(b)`,
      params: { rows },
    },
  ];
}

function pageLinks(pages: Page[]): Statement[] {
  return [
    ...link("CHILD_OF", "Page", "Page", pages.flatMap((p) => (p.parentId ? [{ from: p.id, to: p.parentId }] : []))),
    ...link(
      "DESCRIBES",
      "Page",
      "Component",
      pages.flatMap((p) => (p.componentId ? [{ from: p.id, to: p.componentId }] : [])),
    ),
    ...link(
      "MENTIONS",
      "Page",
      "Component",
      pages.flatMap((p) => {
        const ids = new Set(collectMentions(p.doc).filter((m) => m.mentionType === "component").map((m) => m.id));
        return [...ids].map((to) => ({ from: p.id, to }));
      }),
    ),
  ];
}

function diagramLinks(diagrams: Diagram[]): Statement[] {
  return link(
    "SHOWS",
    "Diagram",
    "Component",
    diagrams.flatMap((d) => {
      const ids = new Set(d.view.nodes.flatMap((n) => (n.componentId ? [n.componentId] : [])));
      return [...ids].map((to) => ({ from: d.id, to }));
    }),
  );
}

function bundleStatements(bundle: Bundle): Statement[] {
  const out: Statement[] = [...INDEXES];
  for (const [type, rows] of groupBy(bundle.components, (c) => c.type)) {
    out.push({
      query: `UNWIND $rows AS row CREATE (c:Component:${componentLabel(type)}) SET c = row`,
      params: { rows: rows.map(componentProps) },
    });
  }
  for (const [type, rows] of groupBy(bundle.references, (r) => r.type)) {
    out.push({
      query: `UNWIND $rows AS row MATCH (s:Component {id: row.sourceId}), (t:Component {id: row.targetId}) CREATE (s)-[r:${relType(type)}]->(t) SET r = row.props`,
      params: { rows: rows.map((r) => ({ sourceId: r.sourceId, targetId: r.targetId, props: referenceProps(r) })) },
    });
  }
  if (bundle.pages.length) {
    out.push({ query: "UNWIND $rows AS row CREATE (p:Page) SET p = row", params: { rows: bundle.pages.map(pageProps) } });
  }
  if (bundle.diagrams.length) {
    out.push({
      query: "UNWIND $rows AS row CREATE (d:Diagram) SET d = row",
      params: { rows: bundle.diagrams.map(diagramProps) },
    });
  }
  return [...out, ...pageLinks(bundle.pages), ...diagramLinks(bundle.diagrams)];
}

function createReferenceStatement(reference: Reference): Statement {
  return {
    query: `MATCH (s:Component {id: $sourceId}), (t:Component {id: $targetId}) CREATE (s)-[r:${relType(reference.type)}]->(t) SET r = $props`,
    params: { sourceId: reference.sourceId, targetId: reference.targetId, props: referenceProps(reference) },
  };
}

function newReference(workspaceId: string, type: Reference["type"], sourceId: string, targetId: string): Reference {
  const now = nowIso();
  return { id: createId("reference"), workspaceId, type, sourceId, targetId, createdAt: now, updatedAt: now };
}

const unlinkParent = (id: string): Statement => ({
  query: "MATCH (:Component)-[r:CONTAINS]->(:Component {id: $id}) DELETE r",
  params: { id },
});

const unlinkOwner = (id: string): Statement => ({
  query: "MATCH (:Component {id: $id})-[r:OWNED_BY]->(:Component) DELETE r",
  params: { id },
});

export type GraphRepoOptions = {
  /** Prefix for every graph key. Tests use a unique prefix so they never touch real data. */
  prefix?: string;
};

export class GraphRepo {
  private store: GraphStore;
  private prefix: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: GraphStore, options: GraphRepoOptions = {}) {
    this.store = store;
    this.prefix = options.prefix ?? "lattice";
  }

  private get meta() {
    return `${this.prefix}:meta`;
  }

  private newGraphKey(workspaceId: string) {
    return `${this.prefix}:ws:${workspaceId}:${createId("g").slice(2)}`;
  }

  /** Writes run one at a time so validation always sees the state it is about to change. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------- reads ----------

  private async records(): Promise<WorkspaceRecord[]> {
    const rows = await this.store.read<{ w: Props }>(
      this.meta,
      "MATCH (w:Workspace) WITH w ORDER BY w.createdAt, w.name RETURN properties(w) AS w",
    );
    return rows.map(({ w }) => ({ graph: String(w.graph), workspace: workspaceSchema.parse(w) }));
  }

  private async record(id: string): Promise<WorkspaceRecord | null> {
    const rows = await this.store.read<{ w: Props }>(
      this.meta,
      "MATCH (w:Workspace {id: $id}) RETURN properties(w) AS w",
      { id },
    );
    const w = rows[0]?.w;
    return w ? { graph: String(w.graph), workspace: workspaceSchema.parse(w) } : null;
  }

  private async load(workspaceId: string): Promise<Loaded | null> {
    const record = await this.record(workspaceId);
    if (!record) return null;
    const { graph, workspace } = record;
    const [componentRows, referenceRows, pageRows, diagramRows] = await Promise.all([
      this.store.read<{ props: Props; parentId: string | null; ownerId: string | null }>(
        graph,
        `MATCH (c:Component)
         OPTIONAL MATCH (p:Component)-[:CONTAINS]->(c)
         OPTIONAL MATCH (c)-[:OWNED_BY]->(o:Component)
         WITH c, p, o ORDER BY c.createdAt, id(c)
         RETURN properties(c) AS props, p.id AS parentId, o.id AS ownerId`,
      ),
      this.store.read<{ props: Props; type: string; sourceId: string; targetId: string }>(
        graph,
        `MATCH (s:Component)-[r:${componentRelTypes}]->(t:Component)
         WITH s, r, t ORDER BY r.createdAt, id(r)
         RETURN properties(r) AS props, type(r) AS type, s.id AS sourceId, t.id AS targetId`,
      ),
      this.store.read<{ props: Props; parentId: string | null; componentId: string | null }>(
        graph,
        `MATCH (p:Page)
         OPTIONAL MATCH (p)-[:CHILD_OF]->(q:Page)
         OPTIONAL MATCH (p)-[:DESCRIBES]->(c:Component)
         WITH p, q, c ORDER BY p.createdAt, id(p)
         RETURN properties(p) AS props, q.id AS parentId, c.id AS componentId`,
      ),
      this.store.read<{ props: Props }>(
        graph,
        "MATCH (d:Diagram) WITH d ORDER BY d.createdAt, id(d) RETURN properties(d) AS props",
      ),
    ]);

    const wsId = workspace.id;
    const bundle: Bundle = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      workspace,
      components: componentRows.map(({ props, parentId, ownerId }) =>
        componentSchema.parse({
          ...props,
          workspaceId: wsId,
          parentId: parentId ?? undefined,
          ownerId: ownerId ?? undefined,
        }),
      ),
      references: referenceRows.map(({ props, type, sourceId, targetId }) =>
        referenceSchema.parse({ ...props, workspaceId: wsId, type: referenceTypeOf(type), sourceId, targetId }),
      ),
      pages: pageRows.map(({ props, parentId, componentId }) =>
        pageSchema.parse({
          ...props,
          workspaceId: wsId,
          doc: JSON.parse(String(props.doc)),
          parentId: parentId ?? undefined,
          componentId: componentId ?? undefined,
        }),
      ),
      diagrams: diagramRows.map(({ props }) =>
        diagramSchema.parse({
          ...props,
          workspaceId: wsId,
          query: props.query ? JSON.parse(String(props.query)) : undefined,
          view: JSON.parse(String(props.view)),
        }),
      ),
    };
    return { graph, bundle };
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return (await this.records()).map((r) => r.workspace);
  }

  async loadWorkspace(id: string): Promise<Result<Bundle>> {
    const loaded = await this.load(id);
    if (!loaded) return failMsg("workspaceId", "workspace not found");
    return { ok: true, data: loaded.bundle };
  }

  async exportBundle(workspaceId: string): Promise<Result<Bundle>> {
    const loaded = await this.load(workspaceId);
    if (!loaded) return failMsg("workspaceId", "workspace not found");
    const parsed = parse<Bundle>(bundleSchema, { ...loaded.bundle, exportedAt: nowIso() });
    if (!parsed.ok) return parsed;
    const integrity = integrityErrors(parsed.data);
    if (integrity.length) return fail(integrity);
    return { ok: true, data: parsed.data };
  }

  // ---------- workspaces ----------

  /** Writes a bundle into a fresh graph and returns its key. */
  private async writeGraph(bundle: Bundle) {
    const graph = this.newGraphKey(bundle.workspace.id);
    try {
      await this.store.write(graph, bundleStatements(bundle));
    } catch (error) {
      await this.store.deleteGraph(graph);
      throw error;
    }
    return graph;
  }

  private async insertWorkspace(bundle: Bundle) {
    const graph = await this.writeGraph(bundle);
    await this.store.write(this.meta, [
      { query: "CREATE (w:Workspace) SET w = $props", params: { props: { ...bundle.workspace, graph } } },
    ]);
  }

  /** Removes workspace graphs left behind by an interrupted write. */
  private async pruneOrphanGraphs() {
    const live = new Set((await this.records()).map((r) => r.graph));
    const prefix = `${this.prefix}:ws:`;
    for (const graph of await this.store.listGraphs()) {
      if (graph.startsWith(prefix) && !live.has(graph)) await this.store.deleteGraph(graph);
    }
  }

  seedIfEmpty(): Promise<Workspace> {
    return this.serial(async () => {
      await this.pruneOrphanGraphs();
      const existing = (await this.records())[0];
      if (existing) return existing.workspace;
      const bundle = buildSampleWorkspace();
      await this.insertWorkspace(bundle);
      return bundle.workspace;
    });
  }

  resetToSample(): Promise<Workspace> {
    return this.serial(async () => {
      const old = await this.records();
      const bundle = buildSampleWorkspace();
      const graph = await this.writeGraph(bundle);
      await this.store.write(this.meta, [
        { query: "MATCH (w:Workspace) DELETE w" },
        { query: "CREATE (w:Workspace) SET w = $props", params: { props: { ...bundle.workspace, graph } } },
      ]);
      for (const record of old) await this.store.deleteGraph(record.graph);
      return bundle.workspace;
    });
  }

  createEmptyWorkspace(name?: string): Promise<Result<Workspace>> {
    return this.serial(async () => {
      const parsed = parse<Bundle>(bundleSchema, buildEmptyWorkspace(name));
      if (!parsed.ok) return parsed;
      await this.insertWorkspace(parsed.data);
      return { ok: true, data: parsed.data.workspace };
    });
  }

  updateWorkspace(
    id: string,
    patch: Partial<Pick<Workspace, "name" | "description" | "slug">>,
  ): Promise<Result<Workspace>> {
    return this.serial(async () => {
      const record = await this.record(id);
      if (!record) return failMsg("id", "workspace not found");
      const current = record.workspace;
      const parsed = parse<Workspace>(workspaceSchema, {
        ...current,
        ...patch,
        id: current.id,
        slug: patch.slug ?? (patch.name ? slugify(patch.name) : current.slug),
        updatedAt: nowIso(),
      });
      if (!parsed.ok) return parsed;
      await this.store.write(this.meta, [
        {
          query: "MATCH (w:Workspace {id: $id}) SET w = $props",
          params: { id, props: { ...parsed.data, graph: record.graph } },
        },
      ]);
      return { ok: true, data: parsed.data };
    });
  }

  deleteWorkspace(id: string): Promise<Result<{ id: string }>> {
    return this.serial(async () => {
      const records = await this.records();
      const record = records.find((r) => r.workspace.id === id);
      if (!record) return failMsg("id", "workspace not found");
      if (records.length === 1) return failMsg("id", "cannot delete the last workspace");
      await this.store.write(this.meta, [{ query: "MATCH (w:Workspace {id: $id}) DELETE w", params: { id } }]);
      await this.store.deleteGraph(record.graph);
      return { ok: true, data: { id } };
    });
  }

  importBundle(
    raw: unknown,
    mode: { type: "new" } | { type: "replace"; workspaceId: string },
  ): Promise<Result<Bundle>> {
    return this.serial(async () => {
      const parsed = parse<Bundle>(bundleSchema, raw);
      if (!parsed.ok) return parsed;
      const stripped = stripDanglingDiagramNodes(parsed.data);
      const integrity = integrityErrors(stripped.bundle);
      if (integrity.length) return fail(integrity);

      if (mode.type === "new") {
        const again = parse<Bundle>(bundleSchema, remapBundle(stripped.bundle, createId("workspace")));
        if (!again.ok) return again;
        await this.insertWorkspace(again.data);
        return { ok: true, data: again.data, warnings: stripped.warnings };
      }

      const record = await this.record(mode.workspaceId);
      if (!record) return failMsg("workspaceId", "workspace not found");
      const again = parse<Bundle>(bundleSchema, remapBundle(stripped.bundle, mode.workspaceId));
      if (!again.ok) return again;
      // Build the replacement graph first, then swap the pointer, so a failure leaves the old data intact.
      const graph = await this.writeGraph(again.data);
      await this.store.write(this.meta, [
        {
          query: "MATCH (w:Workspace {id: $id}) SET w = $props",
          params: { id: mode.workspaceId, props: { ...again.data.workspace, graph } },
        },
      ]);
      await this.store.deleteGraph(record.graph);
      return { ok: true, data: again.data, warnings: stripped.warnings };
    });
  }

  // ---------- components ----------

  createComponent(input: Component): Promise<Result<Component>> {
    return this.serial(async () => {
      const parsed = parse<Component>(componentSchema, input);
      if (!parsed.ok) return parsed;
      const component = parsed.data;
      const loaded = await this.load(component.workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      const all = loaded.bundle.components;
      if (all.some((c) => c.id === component.id)) return failMsg("id", "id already exists");
      if (component.parentId) {
        const parent = all.find((c) => c.id === component.parentId);
        if (!parent) return failMsg("parentId", "parent does not exist");
        if (!isReferenceAllowed("contains", parent.type, component.type)) {
          return failMsg("parentId", "parent must be the same type");
        }
      }
      if (component.ownerId) {
        const owner = all.find((c) => c.id === component.ownerId);
        if (!owner) return failMsg("ownerId", "owner does not exist");
        if (!isReferenceAllowed("owned_by", component.type, owner.type)) {
          return failMsg("ownerId", "owner must be a person or organization");
        }
      }
      const page: Page = {
        id: createId("page"),
        workspaceId: component.workspaceId,
        title: component.name,
        slug: slugify(component.name),
        order: 1000,
        doc: emptyDoc(),
        componentId: component.id,
        createdAt: component.createdAt,
        updatedAt: component.updatedAt,
      };
      const statements: Statement[] = [
        {
          query: `CREATE (c:Component:${componentLabel(component.type)}) SET c = $props`,
          params: { props: componentProps(component) },
        },
        {
          query: "MATCH (c:Component {id: $id}) CREATE (p:Page)-[:DESCRIBES]->(c) SET p = $props",
          params: { id: component.id, props: pageProps(page) },
        },
      ];
      if (component.parentId) {
        statements.push(
          createReferenceStatement(newReference(component.workspaceId, "contains", component.parentId, component.id)),
        );
      }
      if (component.ownerId) {
        statements.push(
          createReferenceStatement(newReference(component.workspaceId, "owned_by", component.id, component.ownerId)),
        );
      }
      await this.store.write(loaded.graph, statements);
      return { ok: true, data: component };
    });
  }

  updateComponent(workspaceId: string, id: string, patch: Record<string, unknown>): Promise<Result<Component>> {
    return this.serial(async () => {
      const loaded = await this.load(workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      const all = loaded.bundle.components;
      const current = all.find((c) => c.id === id);
      if (!current) return failMsg("id", "component not found");
      if (patch.type && patch.type !== current.type) return failMsg("type", "component type is immutable");
      const parsed = parse<Component>(componentSchema, {
        ...applyPatch(current, patch),
        type: current.type,
        id: current.id,
        workspaceId: current.workspaceId,
        updatedAt: nowIso(),
      });
      if (!parsed.ok) return parsed;
      const component = parsed.data;
      const byId = new Map(all.map((c) => [c.id, c]));
      if (component.parentId === component.id) return failMsg("parentId", "self-references are not allowed");
      if (component.parentId && component.parentId !== current.parentId) {
        const parent = byId.get(component.parentId);
        if (!parent) return failMsg("parentId", "parent does not exist");
        if (!isReferenceAllowed("contains", parent.type, component.type)) {
          return failMsg("parentId", "parent must be the same type");
        }
        if (reaches((c) => byId.get(c)?.parentId, component.parentId, component.id)) {
          return failMsg("parentId", "parent cannot be one of its own children");
        }
      }
      if (component.ownerId && component.ownerId !== current.ownerId) {
        const owner = byId.get(component.ownerId);
        if (!owner) return failMsg("ownerId", "owner does not exist");
        if (!isReferenceAllowed("owned_by", component.type, owner.type)) {
          return failMsg("ownerId", "owner must be a person or organization");
        }
      }
      const statements: Statement[] = [
        { query: "MATCH (c:Component {id: $id}) SET c = $props", params: { id, props: componentProps(component) } },
      ];
      if (component.name !== current.name) {
        statements.push({
          query:
            "MATCH (p:Page)-[:DESCRIBES]->(:Component {id: $id}) SET p.title = $title, p.slug = $slug, p.updatedAt = $now",
          params: { id, title: component.name, slug: slugify(component.name), now: component.updatedAt },
        });
      }
      if (component.parentId !== current.parentId) {
        statements.push(unlinkParent(id));
        if (component.parentId) {
          statements.push(createReferenceStatement(newReference(workspaceId, "contains", component.parentId, id)));
        }
      }
      if (component.ownerId !== current.ownerId) {
        statements.push(unlinkOwner(id));
        if (component.ownerId) {
          statements.push(createReferenceStatement(newReference(workspaceId, "owned_by", id, component.ownerId)));
        }
      }
      await this.store.write(loaded.graph, statements);
      return { ok: true, data: component };
    });
  }

  deleteComponent(workspaceId: string, id: string): Promise<Result<{ id: string }>> {
    return this.serial(async () => {
      const loaded = await this.load(workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      if (!loaded.bundle.components.some((c) => c.id === id)) return failMsg("id", "component not found");
      const now = nowIso();
      const statements: Statement[] = [
        {
          query: "MATCH (:Component)-[r]->(:Component) WHERE r.viaId = $id SET r.viaId = NULL, r.updatedAt = $now",
          params: { id, now },
        },
        { query: "MATCH (p:Page)-[:DESCRIBES]->(:Component {id: $id}) DETACH DELETE p", params: { id } },
      ];
      for (const diagram of loaded.bundle.diagrams) {
        const nodes = diagram.view.nodes.filter((node) => node.componentId !== id);
        if (nodes.length === diagram.view.nodes.length) continue;
        statements.push({
          query: "MATCH (d:Diagram {id: $diagramId}) SET d.view = $view, d.updatedAt = $now",
          params: { diagramId: diagram.id, view: JSON.stringify({ ...diagram.view, nodes }), now },
        });
      }
      // DETACH also drops CONTAINS / OWNED_BY, which clears parentId / ownerId on its children.
      statements.push({ query: "MATCH (c:Component {id: $id}) DETACH DELETE c", params: { id } });
      await this.store.write(loaded.graph, statements);
      return { ok: true, data: { id } };
    });
  }

  // ---------- references ----------

  createReference(input: Reference): Promise<Result<Reference>> {
    return this.serial(async () => {
      const parsed = parse<Reference>(referenceSchema, input);
      if (!parsed.ok) return parsed;
      const reference = parsed.data;
      if (reference.sourceId === reference.targetId) return failMsg("targetId", "self-references are not allowed");
      const loaded = await this.load(reference.workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      const byId = new Map(loaded.bundle.components.map((c) => [c.id, c]));
      const source = byId.get(reference.sourceId);
      const target = byId.get(reference.targetId);
      if (!source) return failMsg("sourceId", "source does not exist");
      if (!target) return failMsg("targetId", "target does not exist");
      if (!isReferenceAllowed(reference.type, source.type, target.type)) {
        return failMsg("type", `${reference.type} is not allowed from ${source.type} to ${target.type}`);
      }
      if (reference.viaId) {
        const via = byId.get(reference.viaId);
        if (!via) return failMsg("viaId", "interface does not exist");
        if (via.type !== "interface") return failMsg("viaId", "viaId must be an interface");
      }
      const dup = loaded.bundle.references.find(
        (r) => r.sourceId === reference.sourceId && r.targetId === reference.targetId && r.type === reference.type,
      );
      if (dup) return { ok: true, data: dup };
      if (
        reference.type === "contains" &&
        reaches((c) => byId.get(c)?.parentId, reference.sourceId, reference.targetId)
      ) {
        return failMsg("targetId", "a component cannot contain one of its own parents");
      }
      const statements: Statement[] = [];
      if (reference.type === "contains") statements.push(unlinkParent(reference.targetId));
      if (reference.type === "owned_by") statements.push(unlinkOwner(reference.sourceId));
      statements.push(createReferenceStatement(reference));
      await this.store.write(loaded.graph, statements);
      return { ok: true, data: reference };
    });
  }

  deleteReference(workspaceId: string, id: string): Promise<Result<{ id: string }>> {
    return this.serial(async () => {
      const loaded = await this.load(workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      if (!loaded.bundle.references.some((r) => r.id === id)) return failMsg("id", "reference not found");
      await this.store.write(loaded.graph, [
        { query: "MATCH (:Component)-[r]->(:Component) WHERE r.id = $id DELETE r", params: { id } },
      ]);
      return { ok: true, data: { id } };
    });
  }

  // ---------- pages ----------

  private pageChecks(loaded: Loaded, page: Page, previous?: Page): Result<never> | null {
    const errors = docErrors(page.doc);
    if (errors.length) return fail(errors);
    const pages = new Map(loaded.bundle.pages.map((p) => [p.id, p]));
    if (page.parentId) {
      if (page.parentId === page.id) return failMsg("parentId", "self-references are not allowed");
      if (!pages.has(page.parentId)) return failMsg("parentId", "parent page does not exist");
      if (previous && reaches((p) => pages.get(p)?.parentId, page.parentId, page.id)) {
        return failMsg("parentId", "parent cannot be one of its own children");
      }
    }
    if (page.componentId && page.componentId !== previous?.componentId) {
      if (!loaded.bundle.components.some((c) => c.id === page.componentId)) {
        return failMsg("componentId", "linked component does not exist");
      }
      if (loaded.bundle.pages.some((p) => p.componentId === page.componentId && p.id !== page.id)) {
        return failMsg("componentId", "component already has a page");
      }
    }
    return null;
  }

  createPage(input: Page): Promise<Result<Page>> {
    return this.serial(async () => {
      const parsed = parse<Page>(pageSchema, input);
      if (!parsed.ok) return parsed;
      const page = parsed.data;
      const loaded = await this.load(page.workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      if (loaded.bundle.pages.some((p) => p.id === page.id)) return failMsg("id", "id already exists");
      const problem = this.pageChecks(loaded, page);
      if (problem) return problem;
      await this.store.write(loaded.graph, [
        { query: "CREATE (p:Page) SET p = $props", params: { props: pageProps(page) } },
        ...pageLinks([page]),
      ]);
      return { ok: true, data: page };
    });
  }

  updatePage(workspaceId: string, id: string, patch: Record<string, unknown>): Promise<Result<Page>> {
    return this.serial(async () => {
      const loaded = await this.load(workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      const current = loaded.bundle.pages.find((p) => p.id === id);
      if (!current) return failMsg("id", "page not found");
      const parsed = parse<Page>(pageSchema, {
        ...applyPatch(current, patch),
        id: current.id,
        workspaceId: current.workspaceId,
        updatedAt: nowIso(),
      });
      if (!parsed.ok) return parsed;
      const page = parsed.data;
      const problem = this.pageChecks(loaded, page, current);
      if (problem) return problem;
      await this.store.write(loaded.graph, [
        { query: "MATCH (p:Page {id: $id}) SET p = $props", params: { id, props: pageProps(page) } },
        { query: "MATCH (:Page {id: $id})-[e:CHILD_OF|DESCRIBES|MENTIONS]->() DELETE e", params: { id } },
        ...pageLinks([page]),
      ]);
      return { ok: true, data: page };
    });
  }

  deletePage(workspaceId: string, id: string): Promise<Result<{ id: string }>> {
    return this.serial(async () => {
      const loaded = await this.load(workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      if (!loaded.bundle.pages.some((p) => p.id === id)) return failMsg("id", "page not found");
      if (loaded.bundle.pages.some((p) => p.parentId === id)) return failMsg("id", "delete child pages first");
      await this.store.write(loaded.graph, [{ query: "MATCH (p:Page {id: $id}) DETACH DELETE p", params: { id } }]);
      return { ok: true, data: { id } };
    });
  }

  // ---------- diagrams ----------

  createDiagram(input: Diagram): Promise<Result<Diagram>> {
    return this.serial(async () => {
      const parsed = parse<Diagram>(diagramSchema, input);
      if (!parsed.ok) return parsed;
      const diagram = parsed.data;
      if (diagram.kind === "live" && !diagram.query) return failMsg("query", "live diagrams require a query");
      const loaded = await this.load(diagram.workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      if (loaded.bundle.diagrams.some((d) => d.id === diagram.id)) return failMsg("id", "id already exists");
      await this.store.write(loaded.graph, [
        { query: "CREATE (d:Diagram) SET d = $props", params: { props: diagramProps(diagram) } },
        ...diagramLinks([diagram]),
      ]);
      return { ok: true, data: diagram };
    });
  }

  updateDiagram(workspaceId: string, id: string, patch: Record<string, unknown>): Promise<Result<Diagram>> {
    return this.serial(async () => {
      const loaded = await this.load(workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      const current = loaded.bundle.diagrams.find((d) => d.id === id);
      if (!current) return failMsg("id", "diagram not found");
      const parsed = parse<Diagram>(diagramSchema, {
        ...applyPatch(current, patch),
        id: current.id,
        workspaceId: current.workspaceId,
        updatedAt: nowIso(),
      });
      if (!parsed.ok) return parsed;
      const diagram = parsed.data;
      if (diagram.kind === "live" && !diagram.query) return failMsg("query", "live diagrams require a query");
      await this.store.write(loaded.graph, [
        { query: "MATCH (d:Diagram {id: $id}) SET d = $props", params: { id, props: diagramProps(diagram) } },
        { query: "MATCH (:Diagram {id: $id})-[e:SHOWS]->() DELETE e", params: { id } },
        ...diagramLinks([diagram]),
      ]);
      return { ok: true, data: diagram };
    });
  }

  deleteDiagram(workspaceId: string, id: string): Promise<Result<{ id: string }>> {
    return this.serial(async () => {
      const loaded = await this.load(workspaceId);
      if (!loaded) return failMsg("workspaceId", "workspace not found");
      if (!loaded.bundle.diagrams.some((d) => d.id === id)) return failMsg("id", "diagram not found");
      await this.store.write(loaded.graph, [
        { query: "MATCH (d:Diagram {id: $id}) DETACH DELETE d", params: { id } },
      ]);
      return { ok: true, data: { id } };
    });
  }

  /** Test helper: deletes every graph under this repo's prefix. */
  async destroyAll() {
    for (const graph of await this.store.listGraphs()) {
      if (graph.startsWith(`${this.prefix}:`)) await this.store.deleteGraph(graph);
    }
  }
}
