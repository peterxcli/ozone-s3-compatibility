//! A read-only [`ObjectStore`] that serves byte ranges over HTTP.
//!
//! DataFusion only ever asks this store for the byte ranges it needs: the
//! Parquet footer and page index first, then the column chunks and pages that
//! survive projection, row-group, and page pruning. Every fetched range stays
//! in memory for the lifetime of the store, so repeated searches in the same
//! page session are answered without touching the network again.
//!
//! The first request for an object is a suffix range (`bytes=-N`), which gives
//! the object size, its ETag, and the Parquet footer in a single round trip.
//! Every later response must carry the same ETag; if the file is republished
//! mid-session the store fails with [`STALE_OBJECT_MESSAGE`] instead of mixing
//! bytes from two versions of the file.
//!
//! Browsers hide `Content-Range` and `ETag` from cross-origin responses unless
//! the server lists them in `Access-Control-Expose-Headers`. Without them the
//! store asks for the size with a `HEAD` request, positions every range by the
//! offsets it requested, and detects republishing with `Last-Modified`.

use std::{
    collections::{BTreeMap, HashMap},
    fmt,
    ops::Range,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures::{StreamExt, stream::BoxStream};
use object_store::{
    CopyOptions, Error, GetOptions, GetResult, GetResultPayload, ListResult, MultipartUpload,
    ObjectMeta, ObjectStore, PutMultipartOptions, PutOptions, PutPayload, PutResult, Result,
    path::Path,
};

/// Bytes requested from the end of an object on first access. Large enough to
/// hold the footer and page index of the published search file.
pub const TAIL_PREFETCH_BYTES: u64 = 64 * 1024;

/// Missing ranges closer than this are fetched with one request.
const COALESCE_GAP_BYTES: u64 = 32 * 1024;

/// Error text used when an object changes while it is being read.
pub const STALE_OBJECT_MESSAGE: &str = "remote file changed while reading";

const STORE_NAME: &str = "HttpRangeStore";

/// An HTTP request for (part of) an object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ByteRequest {
    /// A `HEAD` request, for the object size.
    Head,
    /// The last `n` bytes of the object.
    Suffix(u64),
    /// A half-open range of bytes.
    Bounded(Range<u64>),
}

impl ByteRequest {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Head => "HEAD",
            Self::Suffix(_) | Self::Bounded(_) => "GET",
        }
    }

    /// The `Range` header value, if the request has one.
    pub fn range_header(&self) -> Option<String> {
        match self {
            Self::Head => None,
            Self::Suffix(length) => Some(format!("bytes=-{length}")),
            Self::Bounded(range) => Some(format!("bytes={}-{}", range.start, range.end - 1)),
        }
    }
}

/// The parts of an HTTP response the store needs. Headers a browser does not
/// expose to the page are `None`.
#[derive(Debug, Clone, Default)]
pub struct ByteResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_range: Option<String>,
    pub content_length: Option<u64>,
    pub body: Bytes,
}

impl ByteResponse {
    /// Identifies the object version: the ETag, or `Last-Modified` when the
    /// ETag is not exposed.
    fn version(&self) -> Option<&str> {
        self.etag.as_deref().or(self.last_modified.as_deref())
    }
}

/// Performs a single HTTP range request.
#[async_trait]
pub trait RangeFetcher: fmt::Debug + Send + Sync + 'static {
    async fn fetch(&self, url: &str, request: ByteRequest) -> Result<ByteResponse>;
}

/// Network counters, exposed so callers can see how much pushdown saved.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct FetchStats {
    pub requests: u64,
    pub bytes_fetched: u64,
    pub cache_hits: u64,
}

impl FetchStats {
    pub fn add(&mut self, other: FetchStats) {
        self.requests += other.requests;
        self.bytes_fetched += other.bytes_fetched;
        self.cache_hits += other.cache_hits;
    }
}

#[derive(Debug)]
struct CachedObject {
    meta: ObjectMeta,
    /// See [`ByteResponse::version`].
    version: Option<String>,
    /// Fetched bytes keyed by start offset. Segments never overlap or touch;
    /// adjacent ones are merged on insert.
    segments: BTreeMap<u64, Bytes>,
}

impl CachedObject {
    fn slice(&self, range: &Range<u64>) -> Option<Bytes> {
        let (start, bytes) = self.segments.range(..=range.start).next_back()?;
        let end = start + bytes.len() as u64;
        (range.end <= end)
            .then(|| bytes.slice((range.start - start) as usize..(range.end - start) as usize))
    }

    /// Whether no byte of `range` is cached.
    fn is_uncached(&self, range: &Range<u64>) -> bool {
        self.segments
            .range(..range.end)
            .next_back()
            .is_none_or(|(start, bytes)| start + bytes.len() as u64 <= range.start)
    }

    /// The parts of `range` that are not cached yet, in order.
    fn missing(&self, range: &Range<u64>) -> Vec<Range<u64>> {
        let mut missing = Vec::new();
        let mut cursor = range.start;
        let first = self
            .segments
            .range(..=range.start)
            .next_back()
            .map_or(range.start, |(start, _)| *start);
        for (start, bytes) in self.segments.range(first..range.end) {
            if *start > cursor {
                missing.push(cursor..*start);
            }
            cursor = cursor.max(start + bytes.len() as u64);
        }
        if cursor < range.end {
            missing.push(cursor..range.end);
        }
        missing
    }

    fn insert(&mut self, start: u64, bytes: Bytes) {
        let mut merged_start = start;
        let mut merged_end = start + bytes.len() as u64;
        let touching: Vec<u64> = self
            .segments
            .range(..=merged_end)
            .filter(|(segment_start, segment)| *segment_start + segment.len() as u64 >= start)
            .map(|(segment_start, _)| *segment_start)
            .collect();
        if touching.is_empty() {
            self.segments.insert(start, bytes);
            return;
        }

        let old: Vec<(u64, Bytes)> = touching
            .iter()
            .map(|key| (*key, self.segments.remove(key).unwrap()))
            .collect();
        for (segment_start, segment) in &old {
            merged_start = merged_start.min(*segment_start);
            merged_end = merged_end.max(segment_start + segment.len() as u64);
        }
        let mut buffer = vec![0; (merged_end - merged_start) as usize];
        for (segment_start, segment) in old.iter().chain(std::iter::once(&(start, bytes))) {
            let offset = (segment_start - merged_start) as usize;
            buffer[offset..offset + segment.len()].copy_from_slice(segment);
        }
        self.segments.insert(merged_start, Bytes::from(buffer));
    }
}

/// An HTTP-backed, read-only object store for one origin.
#[derive(Debug)]
pub struct HttpRangeStore {
    origin: String,
    fetcher: Arc<dyn RangeFetcher>,
    objects: Mutex<HashMap<Path, CachedObject>>,
    stats: Mutex<FetchStats>,
}

impl HttpRangeStore {
    /// `origin` is the scheme, host, and port, for example `https://example.com`.
    pub fn new(origin: impl Into<String>, fetcher: Arc<dyn RangeFetcher>) -> Self {
        Self {
            origin: origin.into().trim_end_matches('/').to_string(),
            fetcher,
            objects: Mutex::new(HashMap::new()),
            stats: Mutex::new(FetchStats::default()),
        }
    }

    pub fn stats(&self) -> FetchStats {
        *self.stats.lock().unwrap()
    }

    fn url(&self, location: &Path) -> String {
        format!("{}/{}", self.origin, location.as_ref())
    }

    fn cached_meta(&self, location: &Path) -> Option<(ObjectMeta, Option<String>)> {
        self.objects
            .lock()
            .unwrap()
            .get(location)
            .map(|object| (object.meta.clone(), object.version.clone()))
    }

    fn cached_slice(&self, location: &Path, range: &Range<u64>) -> Option<Bytes> {
        self.objects
            .lock()
            .unwrap()
            .get(location)
            .and_then(|object| object.slice(range))
    }

    /// Uncached byte ranges needed for `ranges`, merged across small uncached gaps.
    fn ranges_to_fetch(&self, location: &Path, ranges: &[Range<u64>]) -> Vec<Range<u64>> {
        let objects = self.objects.lock().unwrap();
        let Some(object) = objects.get(location) else {
            return coalesce(ranges, COALESCE_GAP_BYTES);
        };
        let mut missing: Vec<Range<u64>> = ranges
            .iter()
            .flat_map(|range| object.missing(range))
            .collect();
        missing.sort_by_key(|range| range.start);

        let mut merged: Vec<Range<u64>> = Vec::new();
        for range in missing {
            match merged.last_mut() {
                Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
                Some(last)
                    if range.start - last.end <= COALESCE_GAP_BYTES
                        && object.is_uncached(&(last.end..range.start)) =>
                {
                    last.end = last.end.max(range.end)
                }
                _ => merged.push(range),
            }
        }
        merged
    }

    async fn request(&self, location: &Path, request: ByteRequest) -> Result<ByteResponse> {
        let response = self.fetcher.fetch(&self.url(location), request).await?;
        let mut stats = self.stats.lock().unwrap();
        stats.requests += 1;
        stats.bytes_fetched += response.body.len() as u64;
        drop(stats);

        match response.status {
            200 | 206 => Ok(response),
            404 => Err(Error::NotFound {
                path: location.to_string(),
                source: format!("HTTP 404 for {}", self.url(location)).into(),
            }),
            status => Err(generic_error(format!(
                "HTTP {status} for {}",
                self.url(location)
            ))),
        }
    }

    /// Returns the object metadata and version, fetching the tail of the object
    /// on first use.
    async fn object_meta(&self, location: &Path) -> Result<(ObjectMeta, Option<String>)> {
        if let Some(cached) = self.cached_meta(location) {
            return Ok(cached);
        }

        let tail = self
            .request(location, ByteRequest::Suffix(TAIL_PREFETCH_BYTES))
            .await?;
        let (segment, size, version) = match segment_position(&tail)? {
            Some((start, size)) => (
                Some((start, tail.body.clone())),
                size,
                tail.version().map(str::to_string),
            ),
            // Where the tail starts is unknown without Content-Range, so drop it
            // and ask for the size; later ranges are placed by requested offset.
            None => {
                let head = self.request(location, ByteRequest::Head).await?;
                let size = head.content_length.ok_or_else(|| {
                    generic_error(format!("no Content-Length for {}", self.url(location)))
                })?;
                (None, size, head.version().map(str::to_string))
            }
        };
        let meta = ObjectMeta {
            location: location.clone(),
            last_modified: DateTime::<Utc>::UNIX_EPOCH,
            size,
            e_tag: tail.etag.clone(),
            version: None,
        };

        let mut objects = self.objects.lock().unwrap();
        let object = objects
            .entry(location.clone())
            .or_insert_with(|| CachedObject {
                meta,
                version,
                segments: BTreeMap::new(),
            });
        if let Some((start, bytes)) = segment {
            object.insert(start, bytes);
        }
        Ok((object.meta.clone(), object.version.clone()))
    }

    async fn fetch_segment(
        &self,
        location: &Path,
        meta: &ObjectMeta,
        version: Option<&str>,
        range: Range<u64>,
    ) -> Result<()> {
        let response = self
            .request(location, ByteRequest::Bounded(range.clone()))
            .await?;
        let (start, size) = segment_position(&response)?.unwrap_or((range.start, meta.size));
        let changed = matches!(
            (version, response.version()),
            (Some(expected), Some(actual)) if expected != actual
        );
        if changed || size != meta.size {
            return Err(Error::Precondition {
                path: location.to_string(),
                source: STALE_OBJECT_MESSAGE.into(),
            });
        }
        if start > range.start || start + (response.body.len() as u64) < range.end {
            return Err(generic_error(format!(
                "incomplete range response for {}",
                self.url(location)
            )));
        }

        if let Some(object) = self.objects.lock().unwrap().get_mut(location) {
            object.insert(start, response.body);
        }
        Ok(())
    }

    async fn read_ranges(&self, location: &Path, ranges: &[Range<u64>]) -> Result<Vec<Bytes>> {
        let (meta, version) = self.object_meta(location).await?;
        let requested: Vec<Range<u64>> = ranges
            .iter()
            .filter(|range| range.start < range.end)
            .cloned()
            .collect();
        let hits = requested
            .iter()
            .filter(|range| self.cached_slice(location, range).is_some())
            .count();
        self.stats.lock().unwrap().cache_hits += hits as u64;

        let segments = self.ranges_to_fetch(location, &requested);
        futures::future::try_join_all(
            segments
                .into_iter()
                .map(|range| self.fetch_segment(location, &meta, version.as_deref(), range)),
        )
        .await?;

        ranges
            .iter()
            .map(|range| {
                if range.start >= range.end {
                    return Ok(Bytes::new());
                }
                self.cached_slice(location, range).ok_or_else(|| {
                    generic_error(format!(
                        "range {range:?} is missing after fetching {}",
                        self.url(location)
                    ))
                })
            })
            .collect()
    }
}

impl fmt::Display for HttpRangeStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{STORE_NAME}({})", self.origin)
    }
}

#[async_trait]
impl ObjectStore for HttpRangeStore {
    async fn put_opts(&self, _: &Path, _: PutPayload, _: PutOptions) -> Result<PutResult> {
        Err(not_implemented("put_opts"))
    }

    async fn put_multipart_opts(
        &self,
        _: &Path,
        _: PutMultipartOptions,
    ) -> Result<Box<dyn MultipartUpload>> {
        Err(not_implemented("put_multipart_opts"))
    }

    async fn get_opts(&self, location: &Path, options: GetOptions) -> Result<GetResult> {
        let (meta, _) = self.object_meta(location).await?;
        options.check_preconditions(&meta)?;

        let range = if options.head {
            0..0
        } else {
            match &options.range {
                Some(range) => range
                    .as_range(meta.size)
                    .map_err(|source| generic_error(source.to_string()))?,
                None => 0..meta.size,
            }
        };
        let bytes = self
            .read_ranges(location, std::slice::from_ref(&range))
            .await?
            .remove(0);

        Ok(GetResult {
            payload: GetResultPayload::Stream(
                futures::stream::once(async move { Ok(bytes) }).boxed(),
            ),
            meta,
            range,
            attributes: Default::default(),
        })
    }

    async fn get_ranges(&self, location: &Path, ranges: &[Range<u64>]) -> Result<Vec<Bytes>> {
        self.read_ranges(location, ranges).await
    }

    fn delete_stream(
        &self,
        _: BoxStream<'static, Result<Path>>,
    ) -> BoxStream<'static, Result<Path>> {
        futures::stream::once(async { Err(not_implemented("delete_stream")) }).boxed()
    }

    fn list(&self, _: Option<&Path>) -> BoxStream<'static, Result<ObjectMeta>> {
        futures::stream::once(async { Err(not_implemented("list")) }).boxed()
    }

    async fn list_with_delimiter(&self, _: Option<&Path>) -> Result<ListResult> {
        Err(not_implemented("list_with_delimiter"))
    }

    async fn copy_opts(&self, _: &Path, _: &Path, _: CopyOptions) -> Result<()> {
        Err(not_implemented("copy_opts"))
    }
}

/// Returns `(start offset, total object size)` for a 200 or 206 response, or
/// `None` for a 206 response whose `Content-Range` the browser does not expose.
fn segment_position(response: &ByteResponse) -> Result<Option<(u64, u64)>> {
    if response.status == 200 {
        return Ok(Some((0, response.body.len() as u64)));
    }
    let Some(header) = response.content_range.as_deref() else {
        return Ok(None);
    };
    parse_content_range(header)
        .map(Some)
        .ok_or_else(|| generic_error(format!("unsupported Content-Range: {header}")))
}

/// Parses `bytes <start>-<end>/<size>`.
fn parse_content_range(header: &str) -> Option<(u64, u64)> {
    let rest = header.trim().strip_prefix("bytes ")?;
    let (range, size) = rest.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    Some((start.trim().parse().ok()?, size.trim().parse().ok()?))
}

/// Merges ranges whose gaps are at most `max_gap` bytes.
fn coalesce(ranges: &[Range<u64>], max_gap: u64) -> Vec<Range<u64>> {
    let mut sorted = ranges.to_vec();
    sorted.sort_by_key(|range| range.start);
    let mut merged: Vec<Range<u64>> = Vec::new();
    for range in &sorted {
        match merged.last_mut() {
            Some(last) if range.start <= last.end + max_gap => last.end = last.end.max(range.end),
            _ => merged.push(range.clone()),
        }
    }
    merged
}

fn generic_error(message: impl Into<String>) -> Error {
    Error::Generic {
        store: STORE_NAME,
        source: message.into().into(),
    }
}

fn not_implemented(operation: &str) -> Error {
    Error::NotImplemented {
        operation: operation.to_string(),
        implementer: STORE_NAME.to_string(),
    }
}

#[cfg(test)]
#[allow(clippy::single_range_in_vec_init)]
pub(crate) mod tests {
    use super::*;

    /// Serves one in-memory object with HTTP range semantics.
    #[derive(Debug)]
    pub(crate) struct MemoryFetcher {
        pub body: Mutex<Bytes>,
        pub etag: Mutex<String>,
        pub last_modified: Mutex<String>,
        pub ignore_ranges: bool,
        /// Answer like a cross-origin server that exposes no extra headers.
        pub hide_range_headers: bool,
        pub requests: Mutex<Vec<ByteRequest>>,
    }

    impl MemoryFetcher {
        pub(crate) fn new(body: impl Into<Bytes>) -> Self {
            Self {
                body: Mutex::new(body.into()),
                etag: Mutex::new("\"v1\"".to_string()),
                last_modified: Mutex::new("Tue, 29 Sep 2026 09:18:45 GMT".to_string()),
                ignore_ranges: false,
                hide_range_headers: false,
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl RangeFetcher for MemoryFetcher {
        async fn fetch(&self, _: &str, request: ByteRequest) -> Result<ByteResponse> {
            self.requests.lock().unwrap().push(request.clone());
            let body = self.body.lock().unwrap().clone();
            let size = body.len() as u64;
            let headers = ByteResponse {
                etag: (!self.hide_range_headers).then(|| self.etag.lock().unwrap().clone()),
                last_modified: Some(self.last_modified.lock().unwrap().clone()),
                content_length: Some(size),
                ..Default::default()
            };
            let range = match request {
                ByteRequest::Head => {
                    return Ok(ByteResponse {
                        status: 200,
                        ..headers
                    });
                }
                _ if self.ignore_ranges => {
                    return Ok(ByteResponse {
                        status: 200,
                        body,
                        ..headers
                    });
                }
                ByteRequest::Suffix(length) => size.saturating_sub(length)..size,
                ByteRequest::Bounded(range) => range.start..range.end.min(size),
            };
            let content_range = format!("bytes {}-{}/{size}", range.start, range.end - 1);
            Ok(ByteResponse {
                status: 206,
                content_range: (!self.hide_range_headers).then_some(content_range),
                content_length: Some(range.end - range.start),
                body: body.slice(range.start as usize..range.end as usize),
                ..headers
            })
        }
    }

    fn store(fetcher: MemoryFetcher) -> (HttpRangeStore, Path) {
        (
            HttpRangeStore::new("https://example.test", Arc::new(fetcher)),
            Path::from("data/search/cases.parquet"),
        )
    }

    fn body(len: usize) -> Vec<u8> {
        (0..len).map(|index| (index % 251) as u8).collect()
    }

    #[tokio::test]
    async fn first_access_fetches_the_tail_once() {
        let (store, path) = store(MemoryFetcher::new(body(200_000)));

        let tail = store.get_ranges(&path, &[199_000..200_000]).await.unwrap();
        let meta = store
            .get_opts(&path, GetOptions::new().with_head(true))
            .await
            .unwrap()
            .meta;

        assert_eq!(meta.size, 200_000);
        assert_eq!(tail[0].as_ref(), &body(200_000)[199_000..]);
        assert_eq!(store.stats().requests, 1);
        assert_eq!(store.stats().bytes_fetched, TAIL_PREFETCH_BYTES);
    }

    #[tokio::test]
    async fn coalesces_nearby_ranges_and_reuses_cached_bytes() {
        let (store, path) = store(MemoryFetcher::new(body(400_000)));
        let expected = body(400_000);

        let ranges = [1_000..2_000, 10_000..11_000, 300_000..301_000];
        let first = store.get_ranges(&path, &ranges).await.unwrap();
        let requests_after_first = store.stats().requests;
        let second = store.get_ranges(&path, &[1_500..1_600]).await.unwrap();

        assert_eq!(first[1].as_ref(), &expected[10_000..11_000]);
        assert_eq!(second[0].as_ref(), &expected[1_500..1_600]);
        // Tail, one coalesced request for the first two ranges, one for the third.
        assert_eq!(requests_after_first, 3);
        assert_eq!(store.stats().requests, 3);
    }

    #[tokio::test]
    async fn rejects_bytes_from_a_republished_file() {
        let fetcher = Arc::new(MemoryFetcher::new(body(200_000)));
        let store = HttpRangeStore::new("https://example.test", fetcher.clone());
        let path = Path::from("data/search/cases.parquet");

        store.get_ranges(&path, &[199_000..200_000]).await.unwrap();
        *fetcher.etag.lock().unwrap() = "\"v2\"".to_string();
        let error = store.get_ranges(&path, &[0..10]).await.unwrap_err();

        assert!(error.to_string().contains(STALE_OBJECT_MESSAGE), "{error}");
    }

    #[tokio::test]
    async fn accepts_servers_that_ignore_range_headers() {
        let mut fetcher = MemoryFetcher::new(body(5_000));
        fetcher.ignore_ranges = true;
        let (store, path) = store(fetcher);

        let bytes = store
            .get_ranges(&path, &[10..20, 4_000..4_010])
            .await
            .unwrap();

        assert_eq!(bytes[0].as_ref(), &body(5_000)[10..20]);
        assert_eq!(store.stats().requests, 1);
    }

    #[tokio::test]
    async fn only_fetches_bytes_that_are_not_cached() {
        let (store, path) = store(MemoryFetcher::new(body(400_000)));
        let expected = body(400_000);

        // Overlaps the cached tail, which starts at 400_000 - TAIL_PREFETCH_BYTES.
        let bytes = store.get_ranges(&path, &[300_000..360_000]).await.unwrap();

        assert_eq!(bytes[0].as_ref(), &expected[300_000..360_000]);
        assert_eq!(
            store.stats().bytes_fetched,
            TAIL_PREFETCH_BYTES + (400_000 - TAIL_PREFETCH_BYTES - 300_000)
        );
    }

    #[test]
    fn merges_touching_segments_and_reports_gaps() {
        let mut object = CachedObject {
            meta: ObjectMeta {
                location: Path::from("file"),
                last_modified: DateTime::<Utc>::UNIX_EPOCH,
                size: 100,
                e_tag: None,
                version: None,
            },
            version: None,
            segments: BTreeMap::new(),
        };
        object.insert(10, Bytes::from(vec![1; 10]));
        object.insert(40, Bytes::from(vec![2; 10]));
        assert_eq!(object.missing(&(0..60)), vec![0..10, 20..40, 50..60]);
        assert!(object.is_uncached(&(20..40)));
        assert!(!object.is_uncached(&(19..40)));

        object.insert(15, Bytes::from(vec![3; 30]));

        assert_eq!(object.segments.len(), 1);
        assert_eq!(object.missing(&(0..60)), vec![0..10, 50..60]);
        assert_eq!(object.slice(&(18..22)).unwrap().as_ref(), &[3, 3, 3, 3]);
    }

    #[tokio::test]
    async fn reads_by_offset_when_range_headers_are_hidden() {
        let mut fetcher = MemoryFetcher::new(body(200_000));
        fetcher.hide_range_headers = true;
        let fetcher = Arc::new(fetcher);
        let store = HttpRangeStore::new("https://example.test", fetcher.clone());
        let path = Path::from("data/search/cases.parquet");

        let bytes = store
            .get_ranges(&path, &[1_000..1_100, 199_000..200_000])
            .await
            .unwrap();
        let meta = store
            .get_opts(&path, GetOptions::new().with_head(true))
            .await
            .unwrap()
            .meta;

        assert_eq!(meta.size, 200_000);
        assert_eq!(bytes[0].as_ref(), &body(200_000)[1_000..1_100]);
        assert_eq!(bytes[1].as_ref(), &body(200_000)[199_000..]);
        assert_eq!(
            fetcher.requests.lock().unwrap()[..2],
            [ByteRequest::Suffix(TAIL_PREFETCH_BYTES), ByteRequest::Head]
        );
    }

    #[tokio::test]
    async fn detects_republishing_by_last_modified_when_etag_is_hidden() {
        let mut fetcher = MemoryFetcher::new(body(200_000));
        fetcher.hide_range_headers = true;
        let fetcher = Arc::new(fetcher);
        let store = HttpRangeStore::new("https://example.test", fetcher.clone());
        let path = Path::from("data/search/cases.parquet");

        store.get_ranges(&path, &[0..10]).await.unwrap();
        *fetcher.last_modified.lock().unwrap() = "Wed, 30 Sep 2026 09:24:22 GMT".to_string();
        let error = store
            .get_ranges(&path, &[100_000..100_010])
            .await
            .unwrap_err();

        assert!(error.to_string().contains(STALE_OBJECT_MESSAGE), "{error}");
    }

    #[test]
    fn parses_content_range_headers() {
        assert_eq!(
            parse_content_range("bytes 100-199/23378"),
            Some((100, 23378))
        );
        assert_eq!(parse_content_range("bytes */23378"), None);
    }
}
