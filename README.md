# Lattice

An architecture studio — graph, docs, and diagrams, stored in a FalkorDB graph database.

The typed graph is the source of truth. Pages are prose with `@mentions`. Diagrams are views: live maps layout from the graph, boards remember positions. Connecting two component nodes creates a typed reference.

First launch loads **Northstar**, a small invoicing-SaaS sample. It shows the client story (capabilities, workflows, pages) and the delivery story (applications, interfaces, technology) on the same graph.

## Features

- **Catalog** — organizations, capabilities, workflows, processes, applications, people, technology, and interfaces
- **Typed references** — `contains`, `supports`, `realizes`, `uses`, `depends on`, `owned by`, `integrates with`, `runs on`
- **Pages** — wiki-style documents that mention catalog objects
- **Diagrams** — live maps (capability, workflow, application landscape, neighborhood) and freeform boards
- **Graph storage** — components, references, pages, and diagrams live in [FalkorDB](https://www.falkordb.com/), served by a small local API
- **Portable JSON** — export and import a workspace bundle, validated on every write

Lattice runs on your machine for a single user. FalkorDB runs in Docker, and its data is kept in a Docker volume (`falkordb-data`).

## Requirements

- [Node.js](https://nodejs.org/) 20 or later
- [pnpm](https://pnpm.io/) 11 or later (or `corepack pnpm`)
- [Docker](https://www.docker.com/) for FalkorDB

## Getting started

```bash
pnpm install
pnpm db:up        # start FalkorDB
pnpm test
pnpm dev          # API + web app
```

Open [http://localhost:5173](http://localhost:5173). The first start seeds Northstar into FalkorDB. Browse the raw graph in the FalkorDB browser at [http://localhost:3000](http://localhost:3000).

### Day one

1. Read **Start here** on Pages
2. Catalog: capabilities, then workflows, then applications
3. Live maps: capability map, workflow map, application landscape
4. Board: connect two apps to create a reference
5. Export JSON; import as a second workspace
6. Header overflow **Reset to sample** reloads Northstar

### Scripts

| Command | Purpose |
| --- | --- |
| `pnpm db:up` / `pnpm db:down` | Start / stop FalkorDB (Docker) |
| `pnpm dev` | API server (port 8787) and Vite dev server (port 5173) |
| `pnpm build` | Typecheck and production build |
| `pnpm start` | Serve the production build and the API from one process |
| `pnpm test` | Vitest (repository tests need FalkorDB and skip without it) |
| `pnpm lint` | Oxlint |
| `pnpm schema:export` | Write JSON Schema from Zod |

## Schema contract

Zod in `src/schema` is the only type source. `pnpm schema:export` writes `schemas/*.schema.json` (JSON Schema Draft 2020-12). The server `safeParse`s every write and import.

A workspace export is one JSON document:

```json
{
  "schemaVersion": "1.0.0",
  "exportedAt": "2026-03-01T09:00:00.000Z",
  "workspace": {},
  "components": [],
  "references": [],
  "pages": [],
  "diagrams": []
}
```

Validate with `schemas/bundle.schema.json`. Diagram node labels are not source of truth — join `componentId` to `components[]`. See [schemas/README.md](schemas/README.md).

## Project layout

```
server/       Hono API and FalkorDB repository
src/
  schema/     Zod models and metamodel rules
  api/        API client
  store/      workspace actions
  pages/      Home, Catalog, Pages, Diagrams
  data/       Northstar sample
schemas/      generated JSON Schema (AI/assistant contract)
scripts/      schema export
```

## Stack

React 19, Vite, Tailwind, Zod 4, Zustand, TipTap, xyflow, elkjs. Server: Node, Hono, FalkorDB.

## License

[MIT](LICENSE) © Dennis Vercauteren
