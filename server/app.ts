import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Component } from "@/schema/component";
import type { Diagram } from "@/schema/diagram";
import type { Page } from "@/schema/page";
import type { Reference } from "@/schema/reference";
import type { Result } from "@/schema/result";
import type { GraphRepo } from "./repository";

type Json = Record<string, unknown>;

function send<T>(c: Context, result: Result<T>) {
  if (result.ok) return c.json(result);
  const notFound = result.errors.some((e) => e.message.endsWith("not found"));
  return c.json(result, (notFound ? 404 : 422) as ContentfulStatusCode);
}

async function body(c: Context): Promise<Json> {
  const value: unknown = await c.req.json().catch(() => ({}));
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

/**
 * REST API over GraphRepo. Every response body is a `Result<T>`; entity bodies get their
 * `workspaceId` from the URL so the client cannot write into another workspace.
 */
export function createApp(repo: GraphRepo) {
  const api = new Hono();

  api.get("/health", (c) => c.json({ ok: true, data: { status: "up" } }));

  api.get("/workspaces", async (c) => c.json({ ok: true, data: await repo.listWorkspaces() }));
  api.post("/workspaces", async (c) => {
    const { name } = await body(c);
    return send(c, await repo.createEmptyWorkspace(typeof name === "string" ? name : undefined));
  });
  api.post("/reset", async (c) => c.json({ ok: true, data: await repo.resetToSample() }));
  api.post("/import", async (c) => send(c, await repo.importBundle((await body(c)).bundle, { type: "new" })));

  api.get("/workspaces/:ws", async (c) => send(c, await repo.loadWorkspace(c.req.param("ws"))));
  api.patch("/workspaces/:ws", async (c) => send(c, await repo.updateWorkspace(c.req.param("ws"), await body(c))));
  api.delete("/workspaces/:ws", async (c) => send(c, await repo.deleteWorkspace(c.req.param("ws"))));
  api.get("/workspaces/:ws/export", async (c) => send(c, await repo.exportBundle(c.req.param("ws"))));
  api.post("/workspaces/:ws/import", async (c) =>
    send(c, await repo.importBundle((await body(c)).bundle, { type: "replace", workspaceId: c.req.param("ws") })),
  );

  const withWs = async (c: Context) => ({ ...(await body(c)), workspaceId: c.req.param("ws") });
  // Bodies are validated by Zod inside the repository; the casts only satisfy the signatures.
  api.post("/workspaces/:ws/components", async (c) =>
    send(c, await repo.createComponent((await withWs(c)) as Component)),
  );
  api.patch("/workspaces/:ws/components/:id", async (c) =>
    send(c, await repo.updateComponent(c.req.param("ws"), c.req.param("id"), await body(c))),
  );
  api.delete("/workspaces/:ws/components/:id", async (c) =>
    send(c, await repo.deleteComponent(c.req.param("ws"), c.req.param("id"))),
  );

  api.post("/workspaces/:ws/references", async (c) =>
    send(c, await repo.createReference((await withWs(c)) as Reference)),
  );
  api.delete("/workspaces/:ws/references/:id", async (c) =>
    send(c, await repo.deleteReference(c.req.param("ws"), c.req.param("id"))),
  );

  api.post("/workspaces/:ws/pages", async (c) => send(c, await repo.createPage((await withWs(c)) as Page)));
  api.patch("/workspaces/:ws/pages/:id", async (c) =>
    send(c, await repo.updatePage(c.req.param("ws"), c.req.param("id"), await body(c))),
  );
  api.delete("/workspaces/:ws/pages/:id", async (c) =>
    send(c, await repo.deletePage(c.req.param("ws"), c.req.param("id"))),
  );

  api.post("/workspaces/:ws/diagrams", async (c) =>
    send(c, await repo.createDiagram((await withWs(c)) as Diagram)),
  );
  api.patch("/workspaces/:ws/diagrams/:id", async (c) =>
    send(c, await repo.updateDiagram(c.req.param("ws"), c.req.param("id"), await body(c))),
  );
  api.delete("/workspaces/:ws/diagrams/:id", async (c) =>
    send(c, await repo.deleteDiagram(c.req.param("ws"), c.req.param("id"))),
  );

  api.onError((error, c) => {
    console.error(error);
    const message = error instanceof Error ? error.message : "Internal error";
    return c.json({ ok: false, errors: [{ path: "", message }] }, 500);
  });

  const app = new Hono();
  app.route("/api", api);
  return app;
}
