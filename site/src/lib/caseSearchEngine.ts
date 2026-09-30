import wasmUrl from "../generated/case-search/case_search_bg.wasm?url";
import initCaseSearch, { CaseSearchEngine } from "../generated/case-search/case_search.js";
import { caseSearchClientFromEngine } from "./search";
import type { CaseSearchClient } from "./search";

interface RangeResponse {
  status: number;
  etag?: string;
  contentRange?: string;
  body: Uint8Array;
}

let initPromise: Promise<unknown> | null = null;

/** The `fetchRange(url, rangeHeader)` callback the WebAssembly engine calls for I/O. */
function rangeFetcher(cache: RequestCache): (url: string, range: string) => Promise<RangeResponse> {
  return async (url, range) => {
    const response = await fetch(url, { headers: { Range: range }, cache });
    return {
      status: response.status,
      etag: response.headers.get("etag") || undefined,
      contentRange: response.headers.get("content-range") || undefined,
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
