#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

import pyarrow as pa
import pyarrow.parquet as pq


SCHEMA_VERSION = 1

CATALOG_RUNS_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("started_at", pa.timestamp("ms", tz="UTC")),
        ("finished_at", pa.timestamp("ms", tz="UTC")),
        ("status", pa.string()),
        ("workflow_run_url", pa.string()),
        ("ozone_repo", pa.string()),
        ("ozone_ref", pa.string()),
        ("ozone_commit", pa.string()),
        ("s3_tests_commit", pa.string()),
        ("mint_commit", pa.string()),
        ("s3_tests_rate", pa.float64()),
        ("mint_rate", pa.float64()),
        ("detail_base_url", pa.string()),
        ("execution_json", pa.string()),
        ("sources_json", pa.string()),
        ("schema_version", pa.int32()),
    ]
)

METADATA_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("started_at", pa.timestamp("ms", tz="UTC")),
        ("finished_at", pa.timestamp("ms", tz="UTC")),
        ("status", pa.string()),
        ("rate_formula", pa.string()),
        ("workflow_run_url", pa.string()),
        ("orchestration_json", pa.string()),
        ("execution_json", pa.string()),
        ("sources_json", pa.string()),
        ("schema_version", pa.int32()),
    ]
)

CATALOG_FILES_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("path", pa.string()),
        ("kind", pa.string()),
        ("suite_key", pa.string()),
        ("log_source", pa.string()),
        ("row_count", pa.int64()),
        ("byte_size", pa.int64()),
        ("content_hash", pa.string()),
        ("schema_version", pa.int32()),
    ]
)

SUITES_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("suite_key", pa.string()),
        ("label", pa.string()),
        ("status", pa.string()),
        ("exit_code", pa.int32()),
        ("total", pa.int64()),
        ("passed", pa.int64()),
        ("failed", pa.int64()),
        ("errored", pa.int64()),
        ("skipped", pa.int64()),
        ("eligible", pa.int64()),
        ("compatibility_rate", pa.float64()),
        ("included_case_strategy", pa.string()),
    ]
)

FEATURES_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("suite_key", pa.string()),
        ("name", pa.string()),
        ("label", pa.string()),
        ("total", pa.int64()),
        ("passed", pa.int64()),
        ("failed", pa.int64()),
        ("errored", pa.int64()),
        ("skipped", pa.int64()),
        ("eligible", pa.int64()),
        ("compatibility_rate", pa.float64()),
    ]
)

CASES_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("suite_key", pa.string()),
        ("case_id", pa.string()),
        ("name", pa.string()),
        ("name_base", pa.string()),
        ("classname", pa.string()),
        ("status", pa.string()),
        ("duration_ms", pa.int64()),
        ("features", pa.list_(pa.string())),
        ("message", pa.string()),
        ("detail", pa.string()),
        ("source_repo", pa.string()),
        ("source_ref", pa.string()),
        ("source_path", pa.string()),
        ("source_symbol", pa.string()),
        ("log_refs", pa.list_(pa.string())),
    ]
)

SEARCH_ROWS_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("suite_key", pa.string()),
        ("case_id", pa.string()),
        ("status", pa.string()),
        ("features", pa.list_(pa.string())),
        ("test_name", pa.string()),
        ("classname", pa.string()),
        ("message", pa.string()),
        ("detail_preview", pa.string()),
        ("source_path", pa.string()),
        ("source_symbol", pa.string()),
        ("search_text", pa.string()),
    ]
)

LOGS_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("log_source", pa.string()),
        ("log_file", pa.string()),
        ("line_number", pa.int64()),
        ("timestamp", pa.timestamp("ms", tz="UTC")),
        ("level", pa.string()),
        ("case_id", pa.string()),
        ("component", pa.string()),
        ("thread", pa.string()),
        ("logger", pa.string()),
        ("message", pa.string()),
        ("raw_line", pa.string()),
        ("event_id", pa.string()),
        ("exception_class", pa.string()),
        ("stacktrace_id", pa.string()),
    ]
)

LOG_FILES_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("log_source", pa.string()),
        ("log_file", pa.string()),
        ("path", pa.string()),
        ("line_count", pa.int64()),
    ]
)


def iso_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text:
        return None
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def iso_string(value: Any) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        text = value.isoformat()
    else:
        text = str(value)
    return text.replace("+00:00", "Z")


def source_ref(source: dict[str, Any]) -> str:
    commit = str(source.get("commit") or "")
    if commit and commit != "unknown":
        return commit
    return str(source.get("ref") or "")


def suite_file_stem(suite_key: str) -> str:
    return suite_key.replace("_", "-")


def string_field(value: Any) -> str:
    return str(value or "").strip()


def json_field(value: Any) -> str:
    return json.dumps(value or {}, sort_keys=True)


def parsed_json_field(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    text = string_field(value)
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def strip_test_params(name: str) -> str:
    return name.strip().split("[", 1)[0]


def stable_case_id(suite_key: str, case: dict[str, Any]) -> str:
    return f"{suite_key}:{strip_test_params(string_field(case.get('name')))}"


def s3_source_path(classname: str) -> str:
    if not classname:
        return ""
    return f"{classname.replace('.', '/')}.py"


def case_source_info(run: dict[str, Any], suite_key: str, case: dict[str, Any]) -> dict[str, str]:
    sources = run.get("sources", {})
    source = sources.get(suite_key, {}) if isinstance(sources, dict) else {}
    test_name = string_field(case.get("name"))
    classname = string_field(case.get("classname"))
    if suite_key == "s3_tests":
        return {
            "source_repo": str(source.get("repo") or ""),
            "source_ref": source_ref(source),
            "source_path": s3_source_path(classname),
            "source_symbol": strip_test_params(test_name),
        }
    return {
        "source_repo": str(source.get("repo") or ""),
        "source_ref": source_ref(source),
        "source_path": "",
        "source_symbol": strip_test_params(test_name),
    }


def search_text(*values: Any) -> str:
    parts: list[str] = []
    for value in values:
        if value is None:
            continue
        if isinstance(value, list):
            parts.extend(str(item) for item in value if item)
        else:
            text = str(value)
            if text:
                parts.append(text)
    return " ".join(parts)


def search_variants(value: Any) -> str:
    text = search_text(value)
    if not text:
        return ""
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    spaced = re.sub(r"[_/.-]+", " ", spaced)
    return search_text(text, spaced)


def summary_value(summary: dict[str, Any], key: str, default: int = 0) -> Any:
    value = summary.get(key)
    if value is None and key != "compatibility_rate":
        return default
    return value


def cases_for_suite(suite: dict[str, Any]) -> list[dict[str, Any]]:
    cases = suite.get("cases")
    if isinstance(cases, list):
        return cases
    non_passing = suite.get("non_passing_cases")
    if isinstance(non_passing, list):
        return non_passing
    return []


def build_catalog_runs(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for run in sorted(runs, key=lambda item: string_field(item.get("started_at")), reverse=True):
        sources = run.get("sources", {})
        ozone = sources.get("ozone", {}) if isinstance(sources, dict) else {}
        s3_tests = sources.get("s3_tests", {}) if isinstance(sources, dict) else {}
        mint = sources.get("mint", {}) if isinstance(sources, dict) else {}
        suites = run.get("suites", {})
        s3_summary = suites.get("s3_tests", {}).get("summary", {}) if isinstance(suites, dict) else {}
        mint_summary = suites.get("mint", {}).get("summary", {}) if isinstance(suites, dict) else {}
        run_id = string_field(run.get("run_id") or run.get("id"))
        rows.append(
            {
                "run_id": run_id,
                "started_at": iso_timestamp(run.get("started_at")),
                "finished_at": iso_timestamp(run.get("finished_at") or run.get("started_at")),
                "status": string_field(run.get("status")),
                "workflow_run_url": string_field(run.get("workflow_run_url")),
                "ozone_repo": string_field(ozone.get("repo")),
                "ozone_ref": string_field(ozone.get("ref")),
                "ozone_commit": string_field(ozone.get("commit")),
                "s3_tests_commit": string_field(s3_tests.get("commit")),
                "mint_commit": string_field(mint.get("commit")),
                "s3_tests_rate": s3_summary.get("compatibility_rate"),
                "mint_rate": mint_summary.get("compatibility_rate"),
                "detail_base_url": f"runs/{run_id}/",
                "execution_json": json_field(run.get("execution")),
                "sources_json": json_field(run.get("sources")),
                "schema_version": SCHEMA_VERSION,
            }
        )
    return rows


def build_metadata_rows(run: dict[str, Any]) -> list[dict[str, Any]]:
    run_id = string_field(run.get("run_id") or run.get("id"))
    return [
        {
            "run_id": run_id,
            "started_at": iso_timestamp(run.get("started_at")),
            "finished_at": iso_timestamp(run.get("finished_at") or run.get("started_at")),
            "status": string_field(run.get("status")),
            "rate_formula": string_field(run.get("rate_formula")),
            "workflow_run_url": string_field(run.get("workflow_run_url")),
            "orchestration_json": json_field(run.get("orchestration")),
            "execution_json": json_field(run.get("execution")),
            "sources_json": json_field(run.get("sources")),
            "schema_version": SCHEMA_VERSION,
        }
    ]


def build_suite_rows(run: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    run_id = string_field(run.get("run_id") or run.get("id"))
    for suite_key, suite in sorted(run.get("suites", {}).items()):
        summary = suite.get("summary", {})
        rows.append(
            {
                "run_id": run_id,
                "suite_key": suite_key,
                "label": string_field(suite.get("label") or suite_key),
                "status": string_field(suite.get("status")),
                "exit_code": int(suite.get("exit_code", 0) or 0),
                "total": summary_value(summary, "total"),
                "passed": summary_value(summary, "passed"),
                "failed": summary_value(summary, "failed"),
                "errored": summary_value(summary, "errored"),
                "skipped": summary_value(summary, "skipped"),
                "eligible": summary_value(summary, "eligible"),
                "compatibility_rate": summary.get("compatibility_rate"),
                "included_case_strategy": string_field(suite.get("included_case_strategy")),
            }
        )
    return rows


def build_feature_rows(run: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    run_id = string_field(run.get("run_id") or run.get("id"))
    for suite_key, suite in sorted(run.get("suites", {}).items()):
        for feature in suite.get("feature_summaries", []):
            summary = feature.get("summary", {})
            rows.append(
                {
                    "run_id": run_id,
                    "suite_key": suite_key,
                    "name": string_field(feature.get("name")),
                    "label": string_field(feature.get("label") or feature.get("name")),
                    "total": summary_value(summary, "total"),
                    "passed": summary_value(summary, "passed"),
                    "failed": summary_value(summary, "failed"),
                    "errored": summary_value(summary, "errored"),
                    "skipped": summary_value(summary, "skipped"),
                    "eligible": summary_value(summary, "eligible"),
                    "compatibility_rate": summary.get("compatibility_rate"),
                }
            )
    return rows


def build_case_rows(run: dict[str, Any], suite_key: str, suite: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    run_id = string_field(run.get("run_id") or run.get("id"))
    for case in cases_for_suite(suite):
        features = [string_field(feature) for feature in case.get("features", []) if string_field(feature)]
        source_info = case_source_info(run, suite_key, case)
        test_name = string_field(case.get("name"))
        rows.append(
            {
                "run_id": run_id,
                "suite_key": suite_key,
                "case_id": stable_case_id(suite_key, case),
                "name": test_name,
                "name_base": strip_test_params(test_name),
                "classname": string_field(case.get("classname")),
                "status": string_field(case.get("status") or "unknown"),
                "duration_ms": int(case.get("duration_ms", 0) or 0),
                "features": features,
                "message": string_field(case.get("message")),
                "detail": string_field(case.get("detail")),
                **source_info,
                "log_refs": [],
            }
        )
    return rows


def build_search_rows(case_rows_by_suite: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for suite_key in sorted(case_rows_by_suite):
        for case in case_rows_by_suite[suite_key]:
            row = {
                "run_id": case["run_id"],
                "suite_key": suite_key,
                "case_id": case["case_id"],
                "status": case["status"],
                "features": case["features"],
                "test_name": case["name"],
                "classname": case["classname"],
                "message": case["message"],
                "detail_preview": case["detail"][:600],
                "source_path": case["source_path"],
                "source_symbol": case["source_symbol"],
                "search_text": "",
            }
            row["search_text"] = search_text(
                search_variants(row["suite_key"]),
                search_variants(row["test_name"]),
                search_variants(row["classname"]),
                search_variants(row["status"]),
                search_variants(row["features"]),
                search_variants(row["message"]),
                search_variants(row["detail_preview"]),
                search_variants(row["source_path"]),
                search_variants(row["source_symbol"]),
            )
            rows.append(row)
    return rows


def level_for_line(line: str) -> str | None:
    match = re.search(r"\b(ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\b", line)
    if not match:
        return None
    level = match.group(1)
    return "WARN" if level == "WARNING" else level


def slugify_log_source(value: str) -> str:
    stem = Path(value).stem
    stem = re.sub(r"^docker-", "", stem)
    stem = re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-").lower()
    return stem or "log"


def known_log_paths(raw_root: Path) -> list[tuple[str, Path]]:
    candidates = [
        ("pytest", raw_root / "s3-tests" / "pytest.log"),
        ("mint-console", raw_root / "mint" / "console.log"),
        ("mint-json", raw_root / "mint" / "log" / "log.json"),
        ("ozone-build", raw_root / "ozone" / "build.log"),
        ("ozone-start", raw_root / "ozone" / "start.log"),
    ]
    compose_dir = raw_root / "ozone" / "compose"
    if compose_dir.is_dir():
        candidates.extend((slugify_log_source(path.name), path) for path in sorted(compose_dir.glob("*.log")))
    return [(source, path) for source, path in candidates if path.is_file()]


def build_log_rows(run_id: str, log_source: str, log_path: Path, raw_root: Path) -> list[dict[str, Any]]:
    rel_log = str(log_path.relative_to(raw_root))
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(log_path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        rows.append(
            {
                "run_id": run_id,
                "log_source": log_source,
                "log_file": rel_log,
                "line_number": index,
                "timestamp": None,
                "level": level_for_line(line),
                "case_id": None,
                "component": None,
                "thread": None,
                "logger": None,
                "message": line,
                "raw_line": line,
                "event_id": None,
                "exception_class": None,
                "stacktrace_id": None,
            }
        )
    return rows


def write_parquet(path: Path, rows: list[dict[str, Any]], schema: pa.Schema) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pylist(rows, schema=schema)
    pq.write_table(table, path, compression="zstd", use_dictionary=True)


def read_parquet_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return pq.read_table(path).to_pylist()


def read_run_dataset(run_dir: Path) -> dict[str, Any]:
    metadata = (read_parquet_rows(run_dir / "metadata.parquet") or [{}])[0]
    run_id = string_field(metadata.get("run_id") or run_dir.name)
    suite_rows = read_parquet_rows(run_dir / "suites.parquet")
    feature_rows = read_parquet_rows(run_dir / "features.parquet")
    feature_rows_by_suite: dict[str, list[dict[str, Any]]] = {}
    for row in feature_rows:
        feature_rows_by_suite.setdefault(string_field(row.get("suite_key")), []).append(row)

    suites: dict[str, Any] = {}
    for suite_row in suite_rows:
        suite_key = string_field(suite_row.get("suite_key"))
        if not suite_key:
            continue
        summary = {
            "total": summary_value(suite_row, "total"),
            "passed": summary_value(suite_row, "passed"),
            "failed": summary_value(suite_row, "failed"),
            "errored": summary_value(suite_row, "errored"),
            "skipped": summary_value(suite_row, "skipped"),
            "eligible": summary_value(suite_row, "eligible"),
            "compatibility_rate": suite_row.get("compatibility_rate"),
        }
        suite = {
            "label": string_field(suite_row.get("label") or suite_key),
            "status": string_field(suite_row.get("status") or "unknown"),
            "summary": summary,
            "feature_summaries": [
                {
                    "name": string_field(feature.get("name")),
                    "label": string_field(feature.get("label") or feature.get("name")),
                    "summary": {
                        "total": summary_value(feature, "total"),
                        "passed": summary_value(feature, "passed"),
                        "failed": summary_value(feature, "failed"),
                        "errored": summary_value(feature, "errored"),
                        "skipped": summary_value(feature, "skipped"),
                        "eligible": summary_value(feature, "eligible"),
                        "compatibility_rate": feature.get("compatibility_rate"),
                    },
                }
                for feature in feature_rows_by_suite.get(suite_key, [])
            ],
            "included_case_strategy": string_field(suite_row.get("included_case_strategy")),
            "exit_code": int(suite_row.get("exit_code") or 0),
        }
        case_rows = read_parquet_rows(run_dir / f"cases-{suite_file_stem(suite_key)}.parquet")
        cases = [
            {
                "name": string_field(case.get("name")),
                "status": string_field(case.get("status") or "unknown"),
                "classname": string_field(case.get("classname")),
                "duration_ms": case.get("duration_ms"),
                "features": [string_field(feature) for feature in case.get("features", []) if string_field(feature)],
                "message": string_field(case.get("message")),
                "detail": string_field(case.get("detail")),
            }
            for case in case_rows
        ]
        if suite["included_case_strategy"] == "non_passing_only":
            suite["non_passing_cases"] = cases
        else:
            suite["cases"] = cases
        suites[suite_key] = suite

    return {
        "schema_version": int(metadata.get("schema_version") or SCHEMA_VERSION),
        "run_id": run_id,
        "id": run_id,
        "started_at": iso_string(metadata.get("started_at")),
        "finished_at": iso_string(metadata.get("finished_at") or metadata.get("started_at")),
        "status": string_field(metadata.get("status") or "unknown"),
        "rate_formula": string_field(metadata.get("rate_formula")),
        "workflow_run_url": string_field(metadata.get("workflow_run_url")),
        "orchestration": parsed_json_field(metadata.get("orchestration_json")),
        "execution": parsed_json_field(metadata.get("execution_json")),
        "sources": parsed_json_field(metadata.get("sources_json")) or default_sources_for_readback(),
        "suites": suites,
    }


def default_sources_for_readback() -> dict[str, dict[str, str]]:
    return {
        "ozone": {"repo": "", "ref": "unknown", "commit": "unknown", "short_commit": "unknown"},
        "s3_tests": {"repo": "", "ref": "unknown", "commit": "unknown", "short_commit": "unknown"},
        "mint": {"repo": "", "ref": "unknown", "commit": "unknown", "short_commit": "unknown"},
    }


def content_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(
    data_dir: Path,
    run_id: str,
    path: Path,
    kind: str,
    row_count: int,
    suite_key: str = "",
    log_source: str = "",
) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "path": path.relative_to(data_dir).as_posix(),
        "kind": kind,
        "suite_key": suite_key,
        "log_source": log_source,
        "row_count": row_count,
        "byte_size": path.stat().st_size,
        "content_hash": content_hash(path),
        "schema_version": SCHEMA_VERSION,
    }


def write_run_dataset(
    run: dict[str, Any],
    data_dir: Path,
    raw_root: Path | None = None,
) -> list[dict[str, Any]]:
    run_id = string_field(run.get("run_id") or run.get("id"))
    run_dir = data_dir / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []

    metadata_path = run_dir / "metadata.parquet"
    metadata_rows = build_metadata_rows(run)
    write_parquet(metadata_path, metadata_rows, METADATA_SCHEMA)
    records.append(file_record(data_dir, run_id, metadata_path, "metadata", len(metadata_rows)))

    suites_path = run_dir / "suites.parquet"
    suite_rows = build_suite_rows(run)
    write_parquet(suites_path, suite_rows, SUITES_SCHEMA)
    records.append(file_record(data_dir, run_id, suites_path, "suites", len(suite_rows)))

    features_path = run_dir / "features.parquet"
    feature_rows = build_feature_rows(run)
    write_parquet(features_path, feature_rows, FEATURES_SCHEMA)
    records.append(file_record(data_dir, run_id, features_path, "features", len(feature_rows)))

    case_rows_by_suite: dict[str, list[dict[str, Any]]] = {}
    for suite_key, suite in sorted(run.get("suites", {}).items()):
        rows = build_case_rows(run, suite_key, suite)
        case_rows_by_suite[suite_key] = rows
        cases_path = run_dir / f"cases-{suite_file_stem(suite_key)}.parquet"
        write_parquet(cases_path, rows, CASES_SCHEMA)
        records.append(file_record(data_dir, run_id, cases_path, "cases", len(rows), suite_key=suite_key))

    search_path = run_dir / "search-rows.parquet"
    search_rows = build_search_rows(case_rows_by_suite)
    write_parquet(search_path, search_rows, SEARCH_ROWS_SCHEMA)
    records.append(file_record(data_dir, run_id, search_path, "search_rows", len(search_rows)))

    log_files_path = run_dir / "log-files.parquet"
    log_file_rows: list[dict[str, Any]] = []
    if raw_root and raw_root.exists():
        for log_source, log_path in known_log_paths(raw_root):
            log_rows = build_log_rows(run_id, log_source, log_path, raw_root)
            logs_path = run_dir / f"logs-{log_source}.parquet"
            write_parquet(logs_path, log_rows, LOGS_SCHEMA)
            log_file_rows.append(
                {
                    "run_id": run_id,
                    "log_source": log_source,
                    "log_file": str(log_path.relative_to(raw_root)),
                    "path": logs_path.relative_to(data_dir).as_posix(),
                    "line_count": len(log_rows),
                }
            )
        write_parquet(log_files_path, log_file_rows, LOG_FILES_SCHEMA)
    elif log_files_path.exists():
        log_file_rows = read_parquet_rows(log_files_path)
    else:
        write_parquet(log_files_path, log_file_rows, LOG_FILES_SCHEMA)

    records.append(file_record(data_dir, run_id, log_files_path, "log_files", len(log_file_rows)))
    for row in log_file_rows:
        logs_path = data_dir / string_field(row.get("path"))
        if logs_path.exists():
            records.append(
                file_record(
                    data_dir,
                    run_id,
                    logs_path,
                    "logs",
                    int(row.get("line_count") or 0),
                    log_source=string_field(row.get("log_source")),
                )
            )

    return records


def write_pages_parquet_dataset(
    runs: list[dict[str, Any]],
    data_dir: Path,
    raw_roots_by_run_id: Mapping[str, Path] | None = None,
) -> None:
    raw_roots_by_run_id = raw_roots_by_run_id or {}
    data_dir.mkdir(parents=True, exist_ok=True)
    catalog_dir = data_dir / "catalog"
    catalog_dir.mkdir(parents=True, exist_ok=True)

    file_records: list[dict[str, Any]] = []
    runs_oldest_first = sorted(runs, key=lambda item: string_field(item.get("started_at")))
    runs_newest_first = list(reversed(runs_oldest_first))

    for run in runs_oldest_first:
        run_id = string_field(run.get("run_id") or run.get("id"))
        file_records.extend(write_run_dataset(run, data_dir, raw_roots_by_run_id.get(run_id)))

    write_parquet(catalog_dir / "runs.parquet", build_catalog_runs(runs), CATALOG_RUNS_SCHEMA)
    write_parquet(
        catalog_dir / "suites.parquet",
        [row for run in runs_newest_first for row in build_suite_rows(run)],
        SUITES_SCHEMA,
    )
    write_parquet(
        catalog_dir / "features.parquet",
        [row for run in runs_newest_first for row in build_feature_rows(run)],
        FEATURES_SCHEMA,
    )
    write_parquet(catalog_dir / "files.parquet", file_records, CATALOG_FILES_SCHEMA)
