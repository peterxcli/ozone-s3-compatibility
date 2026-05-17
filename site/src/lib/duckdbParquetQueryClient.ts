import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbMvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdbMvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

import { PARQUET_FILE_REF } from "./parquetReport";
import type { ParquetQueryClient } from "./parquetReport";

export type ParquetCacheMode = "auto" | "on_disk" | "in_mem" | "direct";

interface DuckDbParquetQueryClientOptions {
  cacheMode?: ParquetCacheMode;
}

const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdbMvpWasm,
    mainWorker: duckdbMvpWorker,
  },
};

function absoluteUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return path;
  }
  return new URL(path, globalThis.location?.href || "http://localhost/").toString();
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rowToPlainObject(row: unknown): Record<string, unknown> {
  if (row && typeof row === "object" && "toJSON" in row && typeof row.toJSON === "function") {
    return row.toJSON() as Record<string, unknown>;
  }
  return { ...(row as Record<string, unknown>) };
}

export class DuckDbParquetQueryClient implements ParquetQueryClient {
  private readonly cacheMode: ParquetCacheMode;
  private dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;
  private connectionPromise: Promise<AsyncDuckDBConnection> | null = null;
  private fileAliases = new Map<string, string>();
  private nextFileAlias = 0;

  constructor(options: DuckDbParquetQueryClientOptions = {}) {
    this.cacheMode = options.cacheMode || "direct";
  }

  async queryRows<T extends Record<string, unknown>>(filePath: string, sql: string): Promise<T[]> {
    const connection = await this.connection();
    const alias = await this.registerFile(filePath);
    const query = sql.replaceAll(PARQUET_FILE_REF, sqlString(alias));
    const table = await connection.query(query);
    return table.toArray().map((row) => rowToPlainObject(row) as T);
  }

  async close(): Promise<void> {
    if (this.connectionPromise) {
      await (await this.connectionPromise).close();
    }
    if (this.dbPromise) {
      await (await this.dbPromise).terminate();
    }
    this.connectionPromise = null;
    this.dbPromise = null;
    this.fileAliases.clear();
  }

  private async database(): Promise<duckdb.AsyncDuckDB> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);
        const workerUrl = URL.createObjectURL(
          new Blob([`importScripts(${JSON.stringify(absoluteUrl(bundle.mainWorker!))});`], {
            type: "text/javascript",
          }),
        );
        const worker = new Worker(workerUrl);
        const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
        await db.instantiate(absoluteUrl(bundle.mainModule), bundle.pthreadWorker ? absoluteUrl(bundle.pthreadWorker) : null);
        await db.open({
          query: {
            castBigIntToDouble: true,
            castTimestampToDate: true,
          },
        });
        URL.revokeObjectURL(workerUrl);
        return db;
      })();
    }
    return this.dbPromise;
  }

  private async connection(): Promise<AsyncDuckDBConnection> {
    if (!this.connectionPromise) {
      this.connectionPromise = (async () => {
        const db = await this.database();
        const connection = await db.connect();
        await this.configureCache(connection);
        return connection;
      })();
    }
    return this.connectionPromise;
  }

  private async registerFile(filePath: string): Promise<string> {
    const db = await this.database();
    const url = absoluteUrl(filePath);
    const existing = this.fileAliases.get(url);
    if (existing) {
      return existing;
    }

    const alias = `remote_${this.nextFileAlias++}.parquet`;
    await db.registerFileURL(alias, url, duckdb.DuckDBDataProtocol.HTTP, false);
    this.fileAliases.set(url, alias);
    return alias;
  }

  private async configureCache(connection: AsyncDuckDBConnection): Promise<void> {
    if (this.cacheMode === "direct") {
      return;
    }

    try {
      await connection.query("INSTALL cache_httpfs FROM community");
      await connection.query("LOAD cache_httpfs");
      if (this.cacheMode === "on_disk" || this.cacheMode === "in_mem") {
        await connection.query(`SET cache_httpfs_type=${sqlString(this.cacheMode)}`);
      }
    } catch (error) {
      console.warn("DuckDB cache_httpfs is unavailable; falling back to direct HTTP Parquet reads.", error);
    }
  }
}

let sharedClient: DuckDbParquetQueryClient | null = null;

export function createDuckDbParquetQueryClient(options: DuckDbParquetQueryClientOptions = {}): DuckDbParquetQueryClient {
  if (options.cacheMode && options.cacheMode !== "direct") {
    return new DuckDbParquetQueryClient(options);
  }
  if (!sharedClient) {
    sharedClient = new DuckDbParquetQueryClient(options);
  }
  return sharedClient;
}
