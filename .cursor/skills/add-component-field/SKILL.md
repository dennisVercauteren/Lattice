---
name: add-component-field
description: Adds a type-specific field on a Lattice component (application lifecycle, criticality, vendor, URL, capability level, person email/role). Use when adding lifecycle, criticality, vendor, URL, level, email, or other per-type attributes.
---

# Add a component field

Type-specific data is stored as a plain property on the `(:Component:<Type>)` node in FalkorDB. `server/repository.ts` writes every field the Zod schema keeps, so there is no storage code to change.

## Steps

1. Add the field on the matching Zod object in `src/schema/component.ts` (e.g. `applicationSchema`). Values must be strings, numbers, booleans, or arrays of those. Store anything nested as a JSON string.
2. Default it in `src/lib/draft.ts`.
3. Edit UI in `src/pages/CatalogDetailPage.tsx` (and create dialog in `CatalogPage.tsx` only if the field is required at create time).
4. Update Northstar in `src/data/seed.ts` if the sample should show it.
5. Add a `safeParse` failure path test in `src/schema/schema.test.ts` (copy the `lifecycle: "nope"` pattern).
6. `pnpm schema:export && pnpm test`. The Northstar round-trip test in `server/repository.test.ts` confirms the field survives FalkorDB.

Making a field optional is safe for existing data. Making a new field required breaks loading of existing nodes that lack it, so add a default in the schema or migrate the data.
