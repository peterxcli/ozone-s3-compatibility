//! JavaScript bindings for the search engine.

use std::{rc::Rc, sync::Arc};

use async_trait::async_trait;
use bytes::Bytes;
use js_sys::{Function, Object, Promise, Reflect, Uint8Array};
use object_store::{Error, Result};
use send_wrapper::SendWrapper;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{JsFuture, future_to_promise};

use crate::{
    engine::Engine,
    store::{ByteRequest, ByteResponse, RangeFetcher},
};

/// Calls `fetchRange(url, rangeHeader)` supplied by JavaScript. The function
/// resolves to `{ status, etag?, contentRange?, body: Uint8Array }`.
#[derive(Debug)]
struct JsRangeFetcher {
    fetch_range: SendWrapper<Function>,
}

#[async_trait]
impl RangeFetcher for JsRangeFetcher {
    async fn fetch(&self, url: &str, request: ByteRequest) -> Result<ByteResponse> {
        let fetch_range = (*self.fetch_range).clone();
        let url = url.to_string();
        // JavaScript values are not `Send`; WebAssembly runs on one thread.
        SendWrapper::new(async move {
            let promise = fetch_range
                .call2(
                    &JsValue::NULL,
                    &JsValue::from(&url),
                    &JsValue::from(request.header_value()),
                )
                .map_err(|error| fetch_error(&url, error))?;
            let response = JsFuture::from(Promise::from(promise))
                .await
                .map_err(|error| fetch_error(&url, error))?;
            let field = |name: &str| {
                Reflect::get(&response, &JsValue::from(name)).unwrap_or(JsValue::UNDEFINED)
            };
            Ok(ByteResponse {
                status: field("status").as_f64().unwrap_or(0.0) as u16,
                etag: field("etag").as_string(),
                content_range: field("contentRange").as_string(),
                body: Bytes::from(Uint8Array::new(&field("body")).to_vec()),
            })
        })
        .await
    }
}

fn fetch_error(url: &str, error: JsValue) -> Error {
    let message = error
        .as_string()
        .or_else(|| js_sys::Error::from(error).message().as_string())
        .unwrap_or_else(|| "unknown error".to_string());
    Error::Generic {
        store: "HttpRangeStore",
        source: format!("fetch {url} failed: {message}").into(),
    }
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}

/// DataFusion over Parquet files published next to the report.
#[wasm_bindgen]
pub struct CaseSearchEngine {
    engine: Rc<Engine>,
}

#[wasm_bindgen]
impl CaseSearchEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(fetch_range: Function) -> CaseSearchEngine {
        console_error_panic_hook::set_once();
        let fetcher = JsRangeFetcher {
            fetch_range: SendWrapper::new(fetch_range),
        };
        CaseSearchEngine {
            engine: Rc::new(Engine::new(Arc::new(fetcher))),
        }
    }

    /// Registers the Parquet file at an absolute `url` as `table`.
    #[wasm_bindgen(js_name = registerParquet)]
    pub fn register_parquet(&self, table: String, url: String) -> Promise {
        let engine = self.engine.clone();
        future_to_promise(async move {
            engine
                .register_parquet(&table, &url)
                .await
                .map_err(js_error)?;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Resolves to the result rows serialized as a JSON array of objects.
    pub fn query(&self, sql: String) -> Promise {
        let engine = self.engine.clone();
        future_to_promise(async move {
            let json = engine.query_json(&sql).await.map_err(js_error)?;
            Ok(JsValue::from(json))
        })
    }

    /// Network counters: `{ requests, bytesFetched, cacheHits }`.
    pub fn stats(&self) -> JsValue {
        let stats = self.engine.stats();
        let object = Object::new();
        for (name, value) in [
            ("requests", stats.requests),
            ("bytesFetched", stats.bytes_fetched),
            ("cacheHits", stats.cache_hits),
        ] {
            let _ = Reflect::set(&object, &JsValue::from(name), &JsValue::from(value as f64));
        }
        object.into()
    }
}
