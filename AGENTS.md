# Lattice

Architecture studio. Typed graph is source of truth; pages are prose with `@mentions`; diagrams are views (live maps layout from the graph, boards remember positions). Data lives in **FalkorDB**; single user on localhost.

## Stack

React 19, Vite, Tailwind 4, Zod 4, Zustand, TipTap, xyflow, elkjs. Server: Node + Hono, `falkordb` client, FalkorDB in Docker. Package manager: **pnpm**.

## Layout

| Path | Role |
| --- | --- |
| `src/schema/` | Only type source. Zod models; `safeParse` on every write/import |
| `schemas/` | Generated JSON Schema Draft 2020-12. Never hand-edit |
| `server/` | API (`app.ts`), FalkorDB access (`graph.ts`), `GraphRepo` (`repository.ts`) |
| `src/api/client.ts` | `fetch` wrapper; returns `Result<T>`, never throws |
| `src/store/workspace.ts` | Zustand. UI calls store; store calls the API |
| `src/lib/integrity.ts` | Bundle integrity checks, shared by server and tests |
| `src/data/seed.ts` | Northstar sample + empty workspace |
| `src/lib/graph.ts` | Live-map queries |
| `src/lib/layout.ts` | ELK / map layout |
| `src/components/ui/` | Existing primitives (Radix + CVA). Reuse before adding |

Alias: `@/` → `src/` (also in `server/`).

## Commands

```bash
pnpm install
pnpm db:up            # FalkorDB in Docker (127.0.0.1:6379, browser UI on :3000)
pnpm dev              # API on 127.0.0.1:8787 + Vite on http://localhost:5173 (proxies /api)
pnpm schema:export    # after any src/schema change
pnpm test             # repository tests need FalkorDB; they skip when it is down
pnpm lint
pnpm build
pnpm start            # serve dist/ and the API from one process
```

## Storage model

- `lattice:meta` holds `(:Workspace {…, graph})`. Each workspace has its own graph, named in `Workspace.graph`.
- `(:Component:<Type>)` nodes keep type-specific fields as plain properties. Any field on the Zod schema round-trips automatically.
- References are relationships typed by reference type (`CONTAINS`, `SUPPORTS`, …) with `{id, viaId?, description?}`.
- `(:Page)-[:CHILD_OF]->(:Page)`, `(:Page)-[:DESCRIBES]->(:Component)` for auto pages, `(:Page)-[:MENTIONS]->(:Component)` rebuilt on save. Page `doc` is a JSON string.
- `(:Diagram)` with `query`/`view` as JSON strings, plus `(:Diagram)-[:SHOWS]->(:Component)`.
- `parentId` / `ownerId` are **derived** from `CONTAINS` / `OWNED_BY` on read and never stored.
- Writes validate first, then run as one `MULTI/EXEC`. `GraphRepo` serializes writes. Redis has no rollback, so never write before validation passes.

## Invariants

- Writes return `Result<T>` (`src/schema/result.ts`). Surface `errors[].path` (e.g. `components[3].lifecycle`). Never swallow Zod failures.
- `parentId` must match a `contains` edge; `ownerId` must match `owned_by`. Same-type contains only. One parent, one owner, no cycles.
- PATCH bodies use top-level `null` to clear a field (`patchBody` in `src/api/client.ts`).
- Diagram node labels are not source of truth — join `componentId` to `components[]`.
- IDs: `ws_`, `cmp_`, `ref_`, `pg_`, `dia_` + 12-char nanoid (`src/lib/ids.ts`).
- Mentions need `id`, `label`, `mentionType`. Images must be http(s), never `data:` / `blob:`.
- Labels and relationship types in Cypher come only from the Zod enums (`server/cypher.ts`). Everything else goes through parameters.

## Metamodel (`starter-v1`)

Types: organization, capability, workflow, process, application, person, technology, interface.

Legal edges: see `src/schema/metamodel.ts`. Use the **lattice** MCP (`lattice_metamodel`, `lattice_legal_references`, `lattice_validate_bundle`) instead of guessing.

## Agent tools

- **lattice MCP**: live metamodel + bundle validation against Zod and integrity.
- **Context7 MCP**: current docs for Zod 4, React 19, TipTap, xyflow, Hono, FalkorDB, Tailwind 4.
- **Browser MCP**: UI checks at `http://localhost:5173` after `pnpm db:up && pnpm dev`. First launch seeds Northstar.

Prefer `pnpm test` over re-deriving seed/integrity by hand.
