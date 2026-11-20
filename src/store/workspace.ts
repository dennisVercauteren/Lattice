import { create } from "zustand";
import { api, patchBody } from "@/api/client";
import { createId, nowIso, slugify } from "@/lib/ids";
import type { Bundle } from "@/schema/bundle";
import type { Component, ComponentDraft } from "@/schema/component";
import type { Diagram } from "@/schema/diagram";
import { emptyDoc, type Page, type TiptapDoc } from "@/schema/page";
import type { Reference } from "@/schema/reference";
import type { FieldError, Result } from "@/schema/result";
import type { Workspace } from "@/schema/workspace";

const CURRENT_KEY = "lattice.currentWorkspaceId";

function persistId(id: string) {
  localStorage.setItem(CURRENT_KEY, id);
}

type Graph = {
  workspace: Workspace;
  components: Component[];
  references: Reference[];
  pages: Page[];
  diagrams: Diagram[];
};

type Snapshot = Pick<Store, "workspaces" | "currentId" | "graph">;

type Store = {
  ready: boolean;
  saving: boolean;
  error: string | null;
  workspaces: Workspace[];
  currentId: string | null;
  graph: Graph | null;
  boot: () => Promise<void>;
  refresh: () => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;
  createWorkspace: (name?: string) => Promise<Result<Workspace>>;
  updateWorkspace: (patch: Partial<Pick<Workspace, "name" | "description">>) => Promise<Result<Workspace>>;
  deleteWorkspace: (id: string) => Promise<Result<{ id: string }>>;
  resetToSample: () => Promise<Result<Workspace>>;
  createComponent: (input: ComponentDraft & { id?: string }) => Promise<Result<Component>>;
  updateComponent: (id: string, patch: Record<string, unknown>) => Promise<Result<Component>>;
  deleteComponent: (id: string) => Promise<Result<{ id: string }>>;
  createReference: (
    input: Omit<Reference, "id" | "workspaceId" | "createdAt" | "updatedAt"> & { id?: string },
  ) => Promise<Result<Reference>>;
  deleteReference: (id: string) => Promise<Result<{ id: string }>>;
  createPage: (input: { title: string; parentId?: string; doc?: TiptapDoc }) => Promise<Result<Page>>;
  updatePage: (id: string, patch: Partial<Page>) => Promise<Result<Page>>;
  deletePage: (id: string) => Promise<Result<{ id: string }>>;
  createDiagram: (input: Omit<Diagram, "id" | "workspaceId" | "createdAt" | "updatedAt">) => Promise<Result<Diagram>>;
  updateDiagram: (id: string, patch: Partial<Diagram>) => Promise<Result<Diagram>>;
  deleteDiagram: (id: string) => Promise<Result<{ id: string }>>;
  exportBundle: () => Promise<Result<Bundle>>;
  importBundle: (raw: unknown, mode: "new" | "replace") => Promise<Result<Bundle>>;
};

const noWorkspace: Result<never> = { ok: false, errors: [{ path: "workspaceId", message: "no workspace" }] };

async function fetchSnapshot(preferredId: string | null): Promise<Snapshot> {
  const list = await api<Workspace[]>("GET", "/workspaces");
  if (!list.ok) throw new Error(toastErrors(list.errors));
  const preferred = preferredId ?? localStorage.getItem(CURRENT_KEY);
  const current = list.data.find((w) => w.id === preferred) ?? list.data[0] ?? null;
  if (!current) return { workspaces: list.data, currentId: null, graph: null };
  persistId(current.id);
  const bundle = await api<Bundle>("GET", `/workspaces/${current.id}`);
  if (!bundle.ok) throw new Error(toastErrors(bundle.errors));
  const { workspace, components, references, pages, diagrams } = bundle.data;
  return {
    workspaces: list.data,
    currentId: current.id,
    graph: { workspace, components, references, pages, diagrams },
  };
}

/*
 * Writes go to the server one at a time, in call order. Updates are applied to the local graph
 * immediately so typing and dragging stay smooth; once the queue is empty the store reloads from
 * the server. A reload is dropped if another write started meanwhile, so a slow response can never
 * overwrite newer local edits.
 */
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
let writeSeq = 0;

export const useWorkspace = create<Store>((set, get) => {
  async function reload() {
    const seq = writeSeq;
    try {
      const next = await fetchSnapshot(get().currentId);
      if (seq === writeSeq && pending === 0) set(next);
    } catch (error) {
      console.error("Reload failed", error);
    }
  }

  function enqueue<T>(write: () => Promise<Result<T>>): Promise<Result<T>> {
    pending += 1;
    writeSeq += 1;
    set({ saving: true });
    const run = queue.then(async () => {
      try {
        return await write();
      } finally {
        pending -= 1;
        if (pending === 0) {
          await reload();
          set({ saving: false });
        }
      }
    });
    queue = run.catch(() => undefined);
    return run;
  }

  /** Must run at call time, not inside the queued write, or the UI briefly shows older state. */
  function patchLocal(update: (graph: Graph) => Graph) {
    const graph = get().graph;
    if (graph) set({ graph: update(graph) });
  }

  function replaceById<T extends { id: string }>(items: T[], id: string, patch: object): T[] {
    return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
  }

  function inWorkspace<T>(write: (workspaceId: string) => Promise<Result<T>>): Promise<Result<T>> {
    const id = get().currentId;
    if (!id) return Promise.resolve(noWorkspace);
    return enqueue(() => write(id));
  }

  return {
    ready: false,
    saving: false,
    error: null,
    workspaces: [],
    currentId: null,
    graph: null,

    boot: async () => {
      if (get().ready && !get().error) return;
      set({ ready: false, error: null });
      try {
        set({ ...(await fetchSnapshot(get().currentId)), ready: true, error: null });
      } catch (error) {
        set({ ready: true, error: error instanceof Error ? error.message : "Failed to reach the Lattice server" });
      }
    },

    refresh: async () => {
      await queue;
      await reload();
    },

    switchWorkspace: async (id) => {
      persistId(id);
      set({ currentId: id });
      await queue;
      await reload();
    },

    createWorkspace: (name) =>
      enqueue(async () => {
        const result = await api<Workspace>("POST", "/workspaces", { name });
        if (result.ok) {
          persistId(result.data.id);
          set({ currentId: result.data.id });
        }
        return result;
      }),

    updateWorkspace: (patch) => {
      patchLocal((graph) => ({ ...graph, workspace: { ...graph.workspace, ...patch } }));
      return inWorkspace((ws) => api<Workspace>("PATCH", `/workspaces/${ws}`, patch));
    },

    deleteWorkspace: (id) => enqueue(() => api<{ id: string }>("DELETE", `/workspaces/${id}`)),

    resetToSample: () =>
      enqueue(async () => {
        const result = await api<Workspace>("POST", "/reset");
        if (result.ok) {
          persistId(result.data.id);
          set({ currentId: result.data.id });
        }
        return result;
      }),

    createComponent: (input) =>
      inWorkspace((ws) => {
        const now = nowIso();
        const component = { ...input, id: input.id ?? createId("component"), createdAt: now, updatedAt: now };
        return api<Component>("POST", `/workspaces/${ws}/components`, component);
      }),

    updateComponent: (id, patch) => {
      patchLocal((graph) => ({ ...graph, components: replaceById(graph.components, id, patch) }));
      return inWorkspace((ws) => api<Component>("PATCH", `/workspaces/${ws}/components/${id}`, patchBody(patch)));
    },

    deleteComponent: (id) =>
      inWorkspace((ws) => api<{ id: string }>("DELETE", `/workspaces/${ws}/components/${id}`)),

    createReference: (input) =>
      inWorkspace((ws) => {
        const now = nowIso();
        const reference = { ...input, id: input.id ?? createId("reference"), createdAt: now, updatedAt: now };
        return api<Reference>("POST", `/workspaces/${ws}/references`, reference);
      }),

    deleteReference: (id) =>
      inWorkspace((ws) => api<{ id: string }>("DELETE", `/workspaces/${ws}/references/${id}`)),

    createPage: (input) =>
      inWorkspace((ws) => {
        const now = nowIso();
        const siblings = get().graph?.pages.filter((p) => p.parentId === input.parentId && !p.componentId) ?? [];
        const page = {
          id: createId("page"),
          parentId: input.parentId,
          title: input.title,
          slug: slugify(input.title),
          order: siblings.length,
          doc: input.doc ?? emptyDoc(),
          createdAt: now,
          updatedAt: now,
        };
        return api<Page>("POST", `/workspaces/${ws}/pages`, page);
      }),

    updatePage: (id, patch) => {
      patchLocal((graph) => ({ ...graph, pages: replaceById(graph.pages, id, patch) }));
      return inWorkspace((ws) => api<Page>("PATCH", `/workspaces/${ws}/pages/${id}`, patchBody(patch)));
    },

    deletePage: (id) => inWorkspace((ws) => api<{ id: string }>("DELETE", `/workspaces/${ws}/pages/${id}`)),

    createDiagram: (input) =>
      inWorkspace((ws) => {
        const now = nowIso();
        const diagram = { ...input, id: createId("diagram"), createdAt: now, updatedAt: now };
        return api<Diagram>("POST", `/workspaces/${ws}/diagrams`, diagram);
      }),

    updateDiagram: (id, patch) => {
      patchLocal((graph) => ({ ...graph, diagrams: replaceById(graph.diagrams, id, patch) }));
      return inWorkspace((ws) => api<Diagram>("PATCH", `/workspaces/${ws}/diagrams/${id}`, patchBody(patch)));
    },

    deleteDiagram: (id) =>
      inWorkspace((ws) => api<{ id: string }>("DELETE", `/workspaces/${ws}/diagrams/${id}`)),

    exportBundle: async () => {
      const id = get().currentId;
      if (!id) return noWorkspace;
      await queue;
      return api<Bundle>("GET", `/workspaces/${id}/export`);
    },

    importBundle: (raw, mode) =>
      enqueue(async () => {
        const currentId = get().currentId;
        const result =
          mode === "replace" && currentId
            ? await api<Bundle>("POST", `/workspaces/${currentId}/import`, { bundle: raw })
            : await api<Bundle>("POST", "/import", { bundle: raw });
        if (result.ok) {
          persistId(result.data.workspace.id);
          set({ currentId: result.data.workspace.id });
        }
        return result;
      }),
  };
});

export function wikiPages(pages: Page[]) {
  return pages.filter((page) => !page.componentId);
}

export function autoPageFor(pages: Page[], componentId: string) {
  return pages.find((page) => page.componentId === componentId);
}

export function toastErrors(errors: FieldError[]) {
  return errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join("\n");
}
