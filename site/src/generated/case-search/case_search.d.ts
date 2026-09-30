/* tslint:disable */
/* eslint-disable */

/**
 * DataFusion over Parquet files published next to the report.
 */
export class CaseSearchEngine {
    free(): void;
    [Symbol.dispose](): void;
    constructor(fetch_range: Function);
    /**
     * Resolves to the result rows serialized as a JSON array of objects.
     */
    query(sql: string): Promise<any>;
    /**
     * Registers the Parquet file at an absolute `url` as `table`.
     */
    registerParquet(table: string, url: string): Promise<any>;
    /**
     * Network counters: `{ requests, bytesFetched, cacheHits }`.
     */
    stats(): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_casesearchengine_free: (a: number, b: number) => void;
    readonly casesearchengine_new: (a: number) => number;
    readonly casesearchengine_query: (a: number, b: number, c: number) => number;
    readonly casesearchengine_registerParquet: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly casesearchengine_stats: (a: number) => number;
    readonly rust_zstd_wasm_shim_calloc: (a: number, b: number) => number;
    readonly rust_zstd_wasm_shim_free: (a: number) => void;
    readonly rust_zstd_wasm_shim_malloc: (a: number) => number;
    readonly rust_zstd_wasm_shim_memcmp: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memcpy: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memmove: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memset: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_qsort: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_98310: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_98321: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
