/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REPORT_DATA_FORMAT?: string;
  readonly VITE_REPORT_DATA_BASE_URL?: string;
  readonly VITE_DUCKDB_CACHE_MODE?: string;
}
