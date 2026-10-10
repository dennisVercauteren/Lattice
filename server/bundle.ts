import { createId } from "@/lib/ids";
import type { Bundle } from "@/schema/bundle";
import { remapMentionIds } from "@/schema/page";

/** Gives every entity in an imported bundle a fresh id and rewrites all references to it. */
export function remapBundle(bundle: Bundle, workspaceId: string): Bundle {
  const map = new Map<string, string>();
  map.set(bundle.workspace.id, workspaceId);
  for (const component of bundle.components) map.set(component.id, createId("component"));
  for (const reference of bundle.references) map.set(reference.id, createId("reference"));
  for (const page of bundle.pages) map.set(page.id, createId("page"));
  for (const diagram of bundle.diagrams) map.set(diagram.id, createId("diagram"));
  const id = (old?: string) => (old ? map.get(old) ?? old : undefined);

  return {
    schemaVersion: bundle.schemaVersion,
    exportedAt: bundle.exportedAt,
    workspace: { ...bundle.workspace, id: workspaceId },
    components: bundle.components.map((component) => ({
      ...component,
      id: map.get(component.id) ?? component.id,
      workspaceId,
      parentId: id(component.parentId),
      ownerId: id(component.ownerId),
    })),
    references: bundle.references.map((reference) => ({
      ...reference,
      id: map.get(reference.id) ?? reference.id,
      workspaceId,
      sourceId: map.get(reference.sourceId) ?? reference.sourceId,
      targetId: map.get(reference.targetId) ?? reference.targetId,
      viaId: id(reference.viaId),
    })),
    pages: bundle.pages.map((page) => ({
      ...page,
      id: map.get(page.id) ?? page.id,
      workspaceId,
      parentId: id(page.parentId),
      componentId: id(page.componentId),
      doc: remapMentionIds(page.doc, map),
    })),
    diagrams: bundle.diagrams.map((diagram) => ({
      ...diagram,
      id: map.get(diagram.id) ?? diagram.id,
      workspaceId,
      query: diagram.query
        ? { ...diagram.query, rootId: id(diagram.query.rootId) }
        : undefined,
      view: {
        ...diagram.view,
        nodes: diagram.view.nodes.map((node) => ({
          ...node,
          id: createId("n"),
          componentId: id(node.componentId),
        })),
      },
    })),
  };
}
