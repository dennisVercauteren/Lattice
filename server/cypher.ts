import { referenceTypeSchema, type ComponentType, type ReferenceType } from "@/schema/common";

export type Params = Record<string, unknown>;

export type Statement = {
  query: string;
  params?: Params;
};

// FalkorDB takes parameters as a `CYPHER k=v ...` prefix on the query text.
function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `"${value.replace(/["\\]/g, "\\$&")}"`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot store non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(",")}]`;
  if (typeof value === "object") {
    const body = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}:${literal(v)}`);
    return `{${body.join(",")}}`;
  }
  throw new TypeError(`Unsupported parameter type ${typeof value}`);
}

export function withParams({ query, params }: Statement) {
  if (!params || Object.keys(params).length === 0) return query;
  const prefix = Object.entries(params)
    .map(([key, value]) => `${key}=${literal(value)}`)
    .join(" ");
  return `CYPHER ${prefix} ${query}`;
}

// Labels and relationship types cannot be parameters, so they are built from these fixed enums only.
export function componentLabel(type: ComponentType) {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function relType(type: ReferenceType) {
  return type.toUpperCase();
}

export function referenceTypeOf(rel: string): ReferenceType {
  return referenceTypeSchema.parse(rel.toLowerCase());
}

export const componentRelTypes = referenceTypeSchema.options.map(relType).join("|");

/** Drops undefined values so they are not written as properties. */
export function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
