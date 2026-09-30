import wasmUrl from "../generated/case-search/case_search_bg.wasm?url";
import initCaseSearch, { CaseSearchEngine } from "../generated/case-search/case_search.js";
import { caseSearchClientFromEngine } from "./search";
import type { CaseSearchClient } from "./search";

interface RangeResponse {
  status: number;
  etag?: string;
  lastModified?: string;
  contentRange?: string;
  contentLength?: string;
  body: Uint8Array;
}

let initPromise: Promise<unknown> | null = null;

/**
 * The `fetchRange(url, method, range)` callback the WebAssembly engine calls
 * for I/O. Cross-origin responses hide `Content-Range` and `ETag` unless the
 * host exposes them; the engine then falls back to `HEAD` and `Last-Modified`.
 */
function rangeFetcher(cache: RequestCache): (url: string, method: string, range?: string) => Promise<RangeResponse> {
  return async (url, method, range) => {
    const response = await fetch(url, { method, headers: range ? { Range: range } : {}, cache });
    const header = (name: string) => response.headers.get(name) || undefined;
    return {
      status: response.status,
      etag: header("etag"),
      lastModified: header("last-modified"),
      contentRange: header("content-range"),
      contentLength: header("content-length"),
      body: new Uint8Array(await response.arrayBuffer()),
    };
  };
}

/** Loads DataFusion (WebAssembly) and returns a client for querying Parquet over HTTP. */
export async function createCaseSearchClient(cache: RequestCache = "default"): Promise<CaseSearchClient> {
  if (!initPromise) {
    initPromise = initCaseSearch({ module_or_path: wasmUrl }).catch((error: unknown) => {
      initPromise = null;
      throw error;
    });
  }
  await initPromise;
  return caseSearchClientFromEngine(new CaseSearchEngine(rangeFetcher(cache)));
}
