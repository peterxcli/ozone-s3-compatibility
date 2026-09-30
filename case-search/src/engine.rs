//! DataFusion session that queries Parquet files over HTTP range requests.

use std::{
    collections::{HashMap, hash_map::Entry},
    sync::{Arc, Mutex},
};

use datafusion::{
    arrow::record_batch::RecordBatch,
    error::{DataFusionError, Result},
    execution::context::SQLOptions,
    prelude::{ParquetReadOptions, SessionConfig, SessionContext},
};
use url::Url;

use crate::store::{FetchStats, HttpRangeStore, RangeFetcher, TAIL_PREFETCH_BYTES};

pub struct Engine {
    ctx: SessionContext,
    fetcher: Arc<dyn RangeFetcher>,
    stores: Mutex<HashMap<String, Arc<HttpRangeStore>>>,
}

impl Engine {
    pub fn new(fetcher: Arc<dyn RangeFetcher>) -> Self {
        // One partition keeps execution on the calling task; WebAssembly has no
        // thread pool to spawn onto.
        let mut config = SessionConfig::new().with_target_partitions(1);
        let parquet = &mut config.options_mut().execution.parquet;
        // Evaluate filters while decoding and only fetch the pages of the other
        // projected columns that still contain matching rows.
        parquet.pushdown_filters = true;
        parquet.reorder_filters = true;
        parquet.enable_page_index = true;
        // The store already holds this much of the file tail after the first
        // request, so the footer read never needs a second round trip.
        parquet.metadata_size_hint = Some(TAIL_PREFETCH_BYTES as usize);

        Self {
            ctx: SessionContext::new_with_config(config),
            fetcher,
            stores: Mutex::new(HashMap::new()),
        }
    }

    /// Registers (or replaces) `table` as the Parquet file at `url`.
    pub async fn register_parquet(&self, table: &str, url: &str) -> Result<()> {
        let parsed = Url::parse(url).map_err(|error| DataFusionError::External(Box::new(error)))?;
        self.ensure_store(&parsed)?;
        if self.ctx.table_exist(table)? {
            self.ctx.deregister_table(table)?;
        }
        self.ctx
            .register_parquet(table, parsed.as_str(), ParquetReadOptions::default())
            .await
    }

    /// Runs a read-only SQL query and returns the rows as a JSON array of objects.
    pub async fn query_json(&self, sql: &str) -> Result<String> {
        let options = SQLOptions::new()
            .with_allow_ddl(false)
            .with_allow_dml(false)
            .with_allow_statements(false);
        let batches = self
            .ctx
            .sql_with_options(sql, options)
            .await?
            .collect()
            .await?;
        batches_to_json(&batches)
    }

    pub fn stats(&self) -> FetchStats {
        let mut total = FetchStats::default();
        for store in self.stores.lock().unwrap().values() {
            total.add(store.stats());
        }
        total
    }

    fn ensure_store(&self, url: &Url) -> Result<()> {
        let origin = url.origin().ascii_serialization();
        if let Entry::Vacant(entry) = self.stores.lock().unwrap().entry(origin) {
            let store_url = Url::parse(entry.key())
                .map_err(|error| DataFusionError::External(Box::new(error)))?;
            let store = Arc::new(HttpRangeStore::new(entry.key(), self.fetcher.clone()));
            self.ctx.register_object_store(&store_url, store.clone());
            entry.insert(store);
        }
        Ok(())
    }
}

fn batches_to_json(batches: &[RecordBatch]) -> Result<String> {
    let mut writer = arrow_json::ArrayWriter::new(Vec::new());
    for batch in batches {
        writer.write(batch)?;
    }
    writer.finish()?;
    let json = writer.into_inner();
    if json.is_empty() {
        return Ok("[]".to_string());
    }
    String::from_utf8(json).map_err(|error| DataFusionError::External(Box::new(error)))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use datafusion::arrow::{
        array::{Int32Array, StringArray},
        datatypes::{DataType, Field, Schema},
        record_batch::RecordBatch,
    };
    use parquet::{
        arrow::ArrowWriter,
        basic::{BrotliLevel, Compression},
        file::properties::{EnabledStatistics, WriterProperties},
    };
    use serde_json::Value;

    use super::*;
    use crate::store::tests::MemoryFetcher;

    const URL: &str = "https://example.test/data/search/cases.parquet";

    /// Two row groups (one per suite) with many small pages, like the published file.
    fn fixture() -> Vec<u8> {
        let schema = Arc::new(Schema::new(vec![
            Field::new("content_id", DataType::Int32, false),
            Field::new("suite_key", DataType::Utf8, false),
            Field::new("test_name", DataType::Utf8, false),
            Field::new("search_text", DataType::Utf8, false),
            Field::new("detail_preview", DataType::Utf8, false),
        ]));
        let properties = WriterProperties::builder()
            .set_compression(Compression::BROTLI(BrotliLevel::try_new(9).unwrap()))
            .set_dictionary_enabled(false)
            .set_statistics_enabled(EnabledStatistics::Page)
            .set_data_page_row_count_limit(64)
            .set_write_batch_size(64)
            .build();
        let mut buffer = Vec::new();
        let mut writer =
            ArrowWriter::try_new(&mut buffer, schema.clone(), Some(properties)).unwrap();
        for (suite, offset) in [("mint", 0), ("s3_tests", 2_000)] {
            let ids: Vec<i32> = (offset..offset + 2_000).collect();
            let names: Vec<String> = ids.iter().map(|id| format!("test_case_{id}")).collect();
            let text: Vec<String> = ids
                .iter()
                .map(|id| {
                    let marker = if *id == 3_333 { " needle" } else { "" };
                    format!(" {suite} test case {id}{marker} ")
                })
                .collect();
            // Incompressible filler so skipped pages are visible in the byte counts.
            let detail: Vec<String> = ids
                .iter()
                .map(|id| {
                    let mut state = (*id as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
                    (0..16)
                        .map(|_| {
                            state ^= state << 13;
                            state ^= state >> 7;
                            state ^= state << 17;
                            format!("{state:016x}")
                        })
                        .collect()
                })
                .collect();
            let batch = RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(Int32Array::from(ids)),
                    Arc::new(StringArray::from(vec![suite; 2_000])),
                    Arc::new(StringArray::from(names)),
                    Arc::new(StringArray::from(text)),
                    Arc::new(StringArray::from(detail)),
                ],
            )
            .unwrap();
            writer.write(&batch).unwrap();
            writer.flush().unwrap();
        }
        writer.close().unwrap();
        buffer
    }

    async fn engine(bytes: Vec<u8>) -> Engine {
        let engine = Engine::new(Arc::new(MemoryFetcher::new(bytes)));
        engine.register_parquet("cases", URL).await.unwrap();
        engine
    }

    fn rows(json: &str) -> Vec<Value> {
        serde_json::from_str::<Value>(json)
            .unwrap()
            .as_array()
            .unwrap()
            .clone()
    }

    #[tokio::test]
    async fn queries_parquet_over_range_requests() {
        let engine = engine(fixture()).await;

        let json = engine
            .query_json(
                "SELECT content_id, test_name FROM cases \
                 WHERE search_text LIKE '% needle%' ORDER BY content_id LIMIT 5",
            )
            .await
            .unwrap();

        assert_eq!(
            rows(&json),
            vec![serde_json::json!({"content_id": 3333, "test_name": "test_case_3333"})]
        );
    }

    #[tokio::test]
    async fn fetches_only_the_pages_that_contain_matches() {
        let bytes = fixture();
        let file_size = bytes.len() as u64;
        let engine = engine(bytes).await;
        let registration = engine.stats();

        engine
            .query_json(
                "SELECT detail_preview FROM cases \
                 WHERE suite_key = 's3_tests' AND search_text LIKE '% needle%'",
            )
            .await
            .unwrap();
        let fetched = engine.stats().bytes_fetched;

        assert!(
            fetched < file_size / 2,
            "fetched {fetched} of {file_size} bytes (registration: {registration:?})"
        );
    }

    #[tokio::test]
    async fn returns_an_empty_array_when_nothing_matches() {
        let engine = engine(fixture()).await;

        let json = engine
            .query_json("SELECT test_name FROM cases WHERE search_text LIKE '% missing%'")
            .await
            .unwrap();

        assert_eq!(json, "[]");
    }

    #[tokio::test]
    async fn rejects_statements_that_modify_the_session() {
        let engine = engine(fixture()).await;

        let error = engine.query_json("DROP TABLE cases").await.unwrap_err();

        assert!(error.to_string().contains("not supported"), "{error}");
    }
}
