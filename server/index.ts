import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { GraphStore } from "./graph";
import { GraphRepo } from "./repository";

const HOST = "127.0.0.1";
const PORT = Number(process.env.LATTICE_PORT ?? 8787);
const DIST = path.resolve(import.meta.dirname, "../dist");

const store = await GraphStore.connect();
const repo = new GraphRepo(store);
await repo.seedIfEmpty();

const app = createApp(repo);

// After `pnpm build`, the same process serves the UI; in dev, Vite proxies /api here instead.
if (existsSync(path.join(DIST, "index.html"))) {
  const root = path.relative(process.cwd(), DIST);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`Lattice API on http://${HOST}:${info.port}`);
});

const shutdown = () => {
  server.close();
  void store.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
