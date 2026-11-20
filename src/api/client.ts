import type { Result } from "@/schema/result";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

function failure(message: string): Result<never> {
  return { ok: false, errors: [{ path: "", message }] };
}

/** Calls the Lattice server. Never throws: network and server failures come back as `Result` errors. */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return failure("Cannot reach the Lattice server. Is it running?");
  }
  try {
    return (await response.json()) as Result<T>;
  } catch {
    return failure(`The Lattice server did not answer (HTTP ${response.status}). Is it running?`);
  }
}

/** JSON drops `undefined`, so clearing a field is sent as `null`. Only top-level keys are patches. */
export function patchBody(patch: object) {
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value]));
}
