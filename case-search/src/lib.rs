//! Test-case search for the Ozone S3 compatibility report.
//!
//! The report publishes one compact Parquet file of searchable cases. This
//! crate compiles DataFusion to WebAssembly and runs the search SQL against
//! that file over HTTP range requests, so the browser downloads only the
//! column chunks and pages each query needs instead of a full search index.

pub mod engine;
pub mod store;

#[cfg(target_arch = "wasm32")]
mod wasm;
