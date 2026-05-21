#!/usr/bin/env python3

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq


SCHEMA_VERSION = 1

CATALOG_RUNS_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("started_at", pa.string()),
        ("finished_at", pa.string()),
        ("status", pa.string()),
        ("workflow_run_url", pa.string()),
        ("warp_commit", pa.string()),
        ("provider_count", pa.int64()),
        ("profile_count", pa.int64()),
        ("result_count", pa.int64()),
        ("detail_base_url", pa.string()),
        ("warp_json", pa.string()),
        ("runner_json", pa.string()),
        ("schema_version", pa.int32()),
    ]
)

CATALOG_FILES_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("path", pa.string()),
        ("kind", pa.string()),
        ("provider", pa.string()),
        ("profile_id", pa.string()),
        ("byte_size", pa.int64()),
        ("schema_version", pa.int32()),
    ]
)

METADATA_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("started_at", pa.string()),
        ("finished_at", pa.string()),
        ("status", pa.string()),
        ("workflow_run_url", pa.string()),
        ("warp_json", pa.string()),
        ("runner_json", pa.string()),
        ("schema_version", pa.int32()),
    ]
)

PROVIDERS_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("provider", pa.string()),
        ("label", pa.string()),
        ("image", pa.string()),
        ("image_tag", pa.string()),
        ("image_digest", pa.string()),
        ("endpoint", pa.string()),
        ("adapter_status", pa.string()),
        ("startup_seconds", pa.float64()),
        ("log_file", pa.string()),
    ]
)

PROFILES_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("profile_id", pa.string()),
        ("workload", pa.string()),
        ("operation", pa.string()),
        ("object_size", pa.string()),
        ("concurrency", pa.int64()),
        ("prefix_mode", pa.string()),
        ("duration_seconds", pa.int64()),
    ]
)

RESULTS_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("provider", pa.string()),
        ("profile_id", pa.string()),
        ("workload", pa.string()),
        ("operation", pa.string()),
        ("status", pa.string()),
        ("exit_code", pa.int32()),
        ("throughput_mib_per_sec", pa.float64()),
        ("ops_per_sec", pa.float64()),
        ("objects_per_sec", pa.float64()),
        ("errors", pa.int64()),
        ("duration_seconds", pa.float64()),
        ("benchdata", pa.string()),
        ("analyze_out", pa.string()),
        ("analyze_text", pa.string()),
    ]
)

TIMESERIES_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("provider", pa.string()),
        ("profile_id", pa.string()),
        ("workload", pa.string()),
        ("operation", pa.string()),
        ("segment_index", pa.int64()),
        ("host", pa.string()),
        ("duration_seconds", pa.float64()),
        ("objects_per_op", pa.float64()),
        ("bytes", pa.int64()),
        ("full_ops", pa.int64()),
        ("partial_ops", pa.int64()),
        ("ops_started", pa.int64()),
        ("ops_ended", pa.int64()),
        ("errors", pa.int64()),
        ("mb_per_sec", pa.float64()),
        ("ops_per_sec", pa.float64()),
        ("objects_per_sec", pa.float64()),
        ("start_time", pa.string()),
        ("end_time", pa.string()),
    ]
)

COMMANDS_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("provider", pa.string()),
        ("profile_id", pa.string()),
        ("command_json", pa.string()),
        ("exit_code", pa.int32()),
    ]
)

LOG_FILES_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("provider", pa.string()),
        ("log_source", pa.string()),
        ("log_file", pa.string()),
        ("path", pa.string()),
        ("line_count", pa.int64()),
    ]
)

LOGS_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("provider", pa.string()),
        ("log_source", pa.string()),
        ("log_file", pa.string()),
        ("line_number", pa.int64()),
        ("level", pa.string()),
        ("message", pa.string()),
        ("raw_line", pa.string()),
    ]
)

ARTIFACTS_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("provider", pa.string()),
        ("profile_id", pa.string()),
        ("kind", pa.string()),
        ("path", pa.string()),
    ]
)


def string_field(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def int_field(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    return int(value)


def float_field(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def json_field(value: Any) -> str:
    return json.dumps(value or {}, sort_keys=True, separators=(",", ":"))


def parsed_json_field(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    text = string_field(value)
    if not text:
        return {}
    parsed = json.loads(text)
    return parsed if isinstance(parsed, dict) else {}


def write_table(path: Path, rows: list[dict[str, Any]], schema: pa.Schema) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), path)


def read_table(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return pq.read_table(path).to_pylist()


def catalog_run_row(run: dict[str, Any]) -> dict[str, Any]:
    run_id = string_field(run.get("run_id"))
    return {
        "run_id": run_id,
        "started_at": string_field(run.get("started_at")),
        "finished_at": string_field(run.get("finished_at")),
        "status": string_field(run.get("status")),
        "workflow_run_url": string_field(run.get("workflow_run_url")),
        "warp_commit": string_field((run.get("warp") or {}).get("commit")),
        "provider_count": len(run.get("providers", [])),
        "profile_count": len(run.get("profiles", [])),
        "result_count": len(run.get("results", [])),
        "detail_base_url": f"runs/{run_id}/",
        "warp_json": json_field(run.get("warp")),
        "runner_json": json_field(run.get("runner")),
        "schema_version": int_field(run.get("schema_version"), SCHEMA_VERSION),
    }


def metadata_rows(run: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "run_id": string_field(run.get("run_id")),
            "started_at": string_field(run.get("started_at")),
            "finished_at": string_field(run.get("finished_at")),
            "status": string_field(run.get("status")),
            "workflow_run_url": string_field(run.get("workflow_run_url")),
            "warp_json": json_field(run.get("warp")),
            "runner_json": json_field(run.get("runner")),
            "schema_version": int_field(run.get("schema_version"), SCHEMA_VERSION),
        }
    ]


def with_run_id(run: dict[str, Any], rows: list[dict[str, Any]], defaults: dict[str, Any]) -> list[dict[str, Any]]:
    run_id = string_field(run.get("run_id"))
    normalized: list[dict[str, Any]] = []
    for row in rows:
        payload = dict(defaults)
        payload.update(row)
        payload["run_id"] = run_id
        normalized.append(payload)
    return normalized


def command_rows(run: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in run.get("commands", []):
        rows.append(
            {
                "run_id": string_field(run.get("run_id")),
                "provider": string_field(row.get("provider")),
                "profile_id": string_field(row.get("profile_id")),
                "command_json": json_field(row.get("command", [])),
                "exit_code": int_field(row.get("exit_code")),
            }
        )
    return rows


def write_run_dataset(run: dict[str, Any], run_dir: Path) -> list[dict[str, Any]]:
    run_id = string_field(run.get("run_id"))
    tables = [
        ("metadata.parquet", metadata_rows(run), METADATA_SCHEMA, "metadata"),
        (
            "providers.parquet",
            with_run_id(run, run.get("providers", []), {"startup_seconds": 0.0, "log_file": ""}),
            PROVIDERS_SCHEMA,
            "providers",
        ),
        (
            "profiles.parquet",
            with_run_id(run, run.get("profiles", []), {"operation": ""}),
            PROFILES_SCHEMA,
            "profiles",
        ),
        (
            "results.parquet",
            with_run_id(
                run,
                run.get("results", []),
                {"benchdata": "", "analyze_out": "", "analyze_text": "", "throughput_mib_per_sec": None, "ops_per_sec": None, "objects_per_sec": None},
            ),
            RESULTS_SCHEMA,
            "results",
        ),
        (
            "timeseries.parquet",
            with_run_id(run, run.get("timeseries", []), {"host": "", "objects_per_op": 0.0, "full_ops": 0, "partial_ops": 0, "ops_started": 0}),
            TIMESERIES_SCHEMA,
            "timeseries",
        ),
        ("commands.parquet", command_rows(run), COMMANDS_SCHEMA, "commands"),
        (
            "log_files.parquet",
            with_run_id(run, run.get("log_files", []), {"line_count": 0}),
            LOG_FILES_SCHEMA,
            "log_files",
        ),
        (
            "logs.parquet",
            with_run_id(run, run.get("logs", []), {"level": "", "message": "", "raw_line": ""}),
            LOGS_SCHEMA,
            "logs",
        ),
        (
            "artifacts.parquet",
            with_run_id(run, run.get("artifacts", []), {}),
            ARTIFACTS_SCHEMA,
            "artifacts",
        ),
    ]

    file_rows: list[dict[str, Any]] = []
    for file_name, rows, schema, kind in tables:
        path = run_dir / file_name
        write_table(path, rows, schema)
        file_rows.append(
            {
                "run_id": run_id,
                "path": f"runs/{run_id}/{file_name}",
                "kind": kind,
                "provider": "",
                "profile_id": "",
                "byte_size": path.stat().st_size,
                "schema_version": SCHEMA_VERSION,
            }
        )

    for artifact in run.get("artifacts", []):
        file_rows.append(
            {
                "run_id": run_id,
                "path": string_field(artifact.get("path")),
                "kind": string_field(artifact.get("kind")),
                "provider": string_field(artifact.get("provider")),
                "profile_id": string_field(artifact.get("profile_id")),
                "byte_size": 0,
                "schema_version": SCHEMA_VERSION,
            }
        )
    return file_rows


def write_benchmark_dataset(runs: list[dict[str, Any]], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    sorted_runs = sorted(runs, key=lambda run: string_field(run.get("started_at")), reverse=True)
    all_files: list[dict[str, Any]] = []
    for run in sorted_runs:
        all_files.extend(write_run_dataset(run, output_dir / "runs" / string_field(run.get("run_id"))))

    write_table(output_dir / "catalog" / "runs.parquet", [catalog_run_row(run) for run in sorted_runs], CATALOG_RUNS_SCHEMA)
    write_table(output_dir / "catalog" / "files.parquet", all_files, CATALOG_FILES_SCHEMA)


def read_benchmark_dataset(run_dir: Path) -> dict[str, Any]:
    metadata = read_table(run_dir / "metadata.parquet")
    if not metadata:
        raise FileNotFoundError(run_dir / "metadata.parquet")
    meta = metadata[0]
    commands = []
    for row in read_table(run_dir / "commands.parquet"):
        commands.append(
            {
                "provider": row["provider"],
                "profile_id": row["profile_id"],
                "command": json.loads(row["command_json"] or "[]"),
                "exit_code": row["exit_code"],
            }
        )

    return {
        "schema_version": meta["schema_version"],
        "run_id": meta["run_id"],
        "started_at": meta["started_at"],
        "finished_at": meta["finished_at"],
        "status": meta["status"],
        "workflow_run_url": meta["workflow_run_url"],
        "warp": parsed_json_field(meta["warp_json"]),
        "runner": parsed_json_field(meta["runner_json"]),
        "providers": read_table(run_dir / "providers.parquet"),
        "profiles": read_table(run_dir / "profiles.parquet"),
        "results": read_table(run_dir / "results.parquet"),
        "timeseries": read_table(run_dir / "timeseries.parquet"),
        "commands": commands,
        "log_files": read_table(run_dir / "log_files.parquet"),
        "logs": read_table(run_dir / "logs.parquet"),
        "artifacts": read_table(run_dir / "artifacts.parquet"),
    }
