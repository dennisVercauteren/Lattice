import { FalkorDB } from "falkordb";
import { withParams, type Params, type Statement } from "./cypher";

export const DEFAULT_FALKORDB_URL = "falkor://127.0.0.1:6379";

const isEmptyKey = (error: unknown) => error instanceof Error && error.message.includes("empty key");

/** Thin wrapper over the FalkorDB client: parameterised reads, and atomic multi-statement writes. */
export class GraphStore {
  private db: FalkorDB;

  private constructor(db: FalkorDB) {
    this.db = db;
  }

  static async connect(url = process.env.FALKORDB_URL ?? DEFAULT_FALKORDB_URL) {
    const db = await FalkorDB.connect({ url });
    db.on("error", (error: unknown) => {
      console.error("[falkordb]", error instanceof Error ? error.message : error);
    });
    return new GraphStore(db);
  }

  async read<T>(graph: string, query: string, params?: Params): Promise<T[]> {
    try {
      const reply = await this.db.selectGraph(graph).roQuery<T>(withParams({ query, params }));
      return reply.data ?? [];
    } catch (error) {
      // A graph that was never written does not exist yet; read it as empty.
      if (isEmptyKey(error)) return [];
      throw error;
    }
  }

  /**
   * Runs all statements in one MULTI/EXEC so no other client sees a partial write.
   * Redis does not roll back, so callers validate everything before writing.
   */
  async write(graph: string, statements: Statement[]) {
    if (statements.length === 0) return;
    if (statements.length === 1) {
      await this.db.selectGraph(graph).query(withParams(statements[0]!));
      return;
    }
    const multi = (await this.db.connection).multi();
    for (const statement of statements) {
      multi.addCommand(["GRAPH.QUERY", graph, withParams(statement)]);
    }
    await multi.exec();
  }

  async deleteGraph(graph: string) {
    try {
      await this.db.selectGraph(graph).delete();
    } catch (error) {
      if (isEmptyKey(error)) return;
      throw error;
    }
  }

  listGraphs() {
    return this.db.list();
  }

  close() {
    return this.db.close();
  }
}
