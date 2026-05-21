#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


MIB = 1024 * 1024

REPORT_RE = re.compile(r"^Report:\s+(?P<operation>[^.]+)\.\s+Concurrency:\s+\d+\.\s+Ran:\s+(?P<duration>\S+)")
AVERAGE_RE = re.compile(
    r"^\s*\*\s+Average:\s+"
    r"(?:(?P<throughput>[0-9.]+)\s*(?P<throughput_unit>[KMGT]?i?B/s),\s*)?"
    r"(?P<objects>[0-9.]+)\s+obj/s"
)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def string_field(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def int_field(value: Any, default: int = 0) -> int:
    text = string_field(value)
    if not text:
        return default
    try:
        return int(float(text))
    except ValueError:
        return default


def float_field(value: Any, default: float = 0.0) -> float:
    text = string_field(value)
    if not text:
        return default
    try:
        return float(text)
    except ValueError:
        return default


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def duration_to_seconds(value: str) -> float:
    text = string_field(value)
    match = re.fullmatch(r"([0-9.]+)(ms|s|m|h)", text)
    if not match:
        return 0.0
    number = float(match.group(1))
    unit = match.group(2)
    if unit == "ms":
        return number / 1000
    if unit == "m":
        return number * 60
    if unit == "h":
        return number * 3600
    return number


def throughput_to_mib(value: str, unit: str) -> float:
    amount = float_field(value)
    normalized = unit.lower()
    if normalized in {"b/s", "byte/s", "bytes/s"}:
        return amount / MIB
    if normalized in {"kib/s", "kb/s"}:
        return amount / 1024
    if normalized in {"mib/s", "mb/s"}:
        return amount
    if normalized in {"gib/s", "gb/s"}:
        return amount * 1024
    if normalized in {"tib/s", "tb/s"}:
        return amount * 1024 * 1024
    return amount


def parse_analyze_summary(analyze_path: Path, profile: dict[str, Any]) -> dict[str, Any] | None:
    if not analyze_path.exists():
        return None

    summaries: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in analyze_path.read_text(encoding="utf-8", errors="replace").splitlines():
        report = REPORT_RE.match(line)
        if report:
            current = {
                "operation": report.group("operation").upper(),
                "duration_seconds": duration_to_seconds(report.group("duration")),
            }
            summaries.append(current)
            continue
        average = AVERAGE_RE.match(line)
        if average and current is not None:
            throughput = average.group("throughput")
            unit = average.group("throughput_unit")
            current["throughput_mib_per_sec"] = throughput_to_mib(throughput, unit) if throughput and unit else None
            current["objects_per_sec"] = float_field(average.group("objects"))
            current["ops_per_sec"] = float_field(average.group("objects"))

    summaries = [summary for summary in summaries if "objects_per_sec" in summary]
    if not summaries:
        return None

    workload = string_field(profile.get("workload"))
    profile_operation = string_field(profile.get("operation")).upper()
    if workload == "mixed":
        for summary in summaries:
            if summary["operation"] == "TOTAL":
                summary["operation"] = profile_operation or "MIXED"
                return summary
    for summary in summaries:
        if summary["operation"] == profile_operation:
            return summary
    return summaries[0]


def run_id_from_timestamp(value: str) -> str:
    return value.replace(":", "-")


def normalize_timeseries_rows(
    *,
    provider: str,
    profile: dict[str, Any],
    csv_path: Path,
) -> list[dict[str, Any]]:
    if not csv_path.exists():
        return []

    rows: list[dict[str, Any]] = []
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for raw in reader:
            rows.append(
                {
                    "provider": provider,
                    "profile_id": string_field(profile.get("profile_id")),
                    "workload": string_field(profile.get("workload")),
                    "operation": string_field(raw.get("op") or profile.get("operation")).upper(),
                    "segment_index": int_field(raw.get("index")),
                    "host": string_field(raw.get("host")),
                    "duration_seconds": float_field(raw.get("duration_s")),
                    "objects_per_op": float_field(raw.get("objects_per_op")),
                    "bytes": int_field(raw.get("bytes")),
                    "full_ops": int_field(raw.get("full_ops")),
                    "partial_ops": int_field(raw.get("partial_ops")),
                    "ops_started": int_field(raw.get("ops_started")),
                    "ops_ended": int_field(raw.get("ops_ended")),
                    "errors": int_field(raw.get("errors")),
                    "mb_per_sec": float_field(raw.get("mb_per_sec")),
                    "ops_per_sec": float_field(raw.get("ops_ended_per_sec")),
                    "objects_per_sec": float_field(raw.get("objs_per_sec")),
                    "start_time": string_field(raw.get("start_time")),
                    "end_time": string_field(raw.get("end_time")),
                }
            )
    return rows


def result_rows_for_profile(
    *,
    provider: str,
    profile: dict[str, Any],
    timeseries_rows: list[dict[str, Any]],
    analyze_summary: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    exit_code = int_field(profile.get("exit_code"), default=1)
    rows_by_operation: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in timeseries_rows:
        rows_by_operation[row["operation"]].append(row)

    if not rows_by_operation:
        if analyze_summary is not None:
            return [
                {
                    "provider": provider,
                    "profile_id": string_field(profile.get("profile_id")),
                    "workload": string_field(profile.get("workload")),
                    "operation": string_field(analyze_summary.get("operation") or profile.get("operation")).upper(),
                    "status": "completed" if exit_code == 0 else "failed",
                    "exit_code": exit_code,
                    "throughput_mib_per_sec": analyze_summary.get("throughput_mib_per_sec"),
                    "ops_per_sec": analyze_summary.get("ops_per_sec"),
                    "objects_per_sec": analyze_summary.get("objects_per_sec"),
                    "errors": 0,
                    "duration_seconds": analyze_summary.get("duration_seconds", 0.0),
                    "benchdata": string_field(profile.get("benchdata")),
                    "analyze_out": string_field(profile.get("analyze_out")),
                    "analyze_text": string_field(profile.get("analyze_text")),
                }
            ]
        return [
            {
                "provider": provider,
                "profile_id": string_field(profile.get("profile_id")),
                "workload": string_field(profile.get("workload")),
                "operation": string_field(profile.get("operation")).upper(),
                "status": "completed" if exit_code == 0 else "failed",
                "exit_code": exit_code,
                "throughput_mib_per_sec": None,
                "ops_per_sec": None,
                "objects_per_sec": None,
                "errors": 0,
                "duration_seconds": 0.0,
                "benchdata": string_field(profile.get("benchdata")),
                "analyze_out": string_field(profile.get("analyze_out")),
                "analyze_text": string_field(profile.get("analyze_text")),
            }
        ]

    results: list[dict[str, Any]] = []
    for operation, operation_rows in sorted(rows_by_operation.items()):
        duration = sum(float(row["duration_seconds"]) for row in operation_rows)
        total_bytes = sum(int(row["bytes"]) for row in operation_rows)
        ops_ended = sum(int(row["ops_ended"]) for row in operation_rows)
        objects = sum(float(row["objects_per_sec"]) * float(row["duration_seconds"]) for row in operation_rows)
        errors = sum(int(row["errors"]) for row in operation_rows)
        results.append(
            {
                "provider": provider,
                "profile_id": string_field(profile.get("profile_id")),
                "workload": string_field(profile.get("workload")),
                "operation": operation,
                "status": "completed" if exit_code == 0 else "failed",
                "exit_code": exit_code,
                "throughput_mib_per_sec": round(total_bytes / MIB / duration, 6) if duration else None,
                "ops_per_sec": round(ops_ended / duration, 6) if duration else None,
                "objects_per_sec": round(objects / duration, 6) if duration else None,
                "errors": errors,
                "duration_seconds": round(duration, 6),
                "benchdata": string_field(profile.get("benchdata")),
                "analyze_out": string_field(profile.get("analyze_out")),
                "analyze_text": string_field(profile.get("analyze_text")),
            }
        )
    return results


def profile_record(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "profile_id": string_field(profile.get("profile_id")),
        "workload": string_field(profile.get("workload")),
        "operation": string_field(profile.get("operation")).upper(),
        "object_size": string_field(profile.get("object_size")),
        "concurrency": int_field(profile.get("concurrency")),
        "prefix_mode": string_field(profile.get("prefix_mode")),
        "duration_seconds": int_field(profile.get("duration_seconds")),
    }


def provider_record(metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "provider": string_field(metadata.get("provider")),
        "label": string_field(metadata.get("label") or metadata.get("provider")),
        "image": string_field(metadata.get("image")),
        "image_tag": string_field(metadata.get("image_tag")),
        "image_digest": string_field(metadata.get("image_digest")),
        "endpoint": string_field(metadata.get("endpoint")),
        "adapter_status": string_field(metadata.get("adapter_status") or "unknown"),
        "startup_seconds": float_field(metadata.get("startup_seconds")),
        "log_file": string_field(metadata.get("log_file")),
    }


def artifact_rows(provider: str, profile: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for kind in ("benchdata", "analyze_out", "analyze_text"):
        path = string_field(profile.get(kind))
        if not path:
            continue
        rows.append(
            {
                "provider": provider,
                "profile_id": string_field(profile.get("profile_id")),
                "kind": kind,
                "path": path,
            }
        )
    return rows


def normalize_provider_dir(provider_dir: Path) -> dict[str, Any]:
    metadata = load_json(provider_dir / "metadata.json")
    provider = string_field(metadata.get("provider") or provider_dir.name)
    all_timeseries: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    commands: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []
    profiles = [profile_record(profile) for profile in metadata.get("profiles", [])]

    for profile in metadata.get("profiles", []):
        analyze_out = string_field(profile.get("analyze_out"))
        timeseries_rows = normalize_timeseries_rows(
            provider=provider,
            profile=profile,
            csv_path=provider_dir / analyze_out if analyze_out else provider_dir / "_missing.csv",
        )
        all_timeseries.extend(timeseries_rows)
        analyze_text = string_field(profile.get("analyze_text"))
        analyze_summary = None if timeseries_rows else parse_analyze_summary(provider_dir / analyze_text, profile)
        results.extend(
            result_rows_for_profile(
                provider=provider,
                profile=profile,
                timeseries_rows=timeseries_rows,
                analyze_summary=analyze_summary,
            )
        )
        commands.append(
            {
                "provider": provider,
                "profile_id": string_field(profile.get("profile_id")),
                "command": list(profile.get("command", [])),
                "exit_code": int_field(profile.get("exit_code"), default=1),
            }
        )
        artifacts.extend(artifact_rows(provider, profile))

    log_files = []
    log_file = string_field(metadata.get("log_file"))
    if log_file:
        log_files.append(
            {
                "provider": provider,
                "log_source": "provider",
                "log_file": Path(log_file).name,
                "path": log_file,
                "line_count": 0,
            }
        )

    return {
        "provider": provider_record(metadata),
        "profiles": profiles,
        "results": results,
        "timeseries": all_timeseries,
        "commands": commands,
        "artifacts": artifacts,
        "log_files": log_files,
        "logs": [],
    }


def dedupe_profiles(profiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for profile in profiles:
        profile_id = profile["profile_id"]
        by_id.setdefault(profile_id, profile)
    return [by_id[key] for key in sorted(by_id)]


def normalize_benchmark_run(
    *,
    provider_dirs: list[Path],
    run_id: str,
    started_at: str,
    finished_at: str,
    workflow_run_url: str,
    warp: dict[str, Any],
    runner: dict[str, Any],
) -> dict[str, Any]:
    provider_payloads = [normalize_provider_dir(path) for path in provider_dirs]
    providers = [payload["provider"] for payload in provider_payloads]
    profiles = dedupe_profiles([profile for payload in provider_payloads for profile in payload["profiles"]])
    results = [result for payload in provider_payloads for result in payload["results"]]
    timeseries = [row for payload in provider_payloads for row in payload["timeseries"]]
    commands = [row for payload in provider_payloads for row in payload["commands"]]
    artifacts = [row for payload in provider_payloads for row in payload["artifacts"]]
    log_files = [row for payload in provider_payloads for row in payload["log_files"]]
    logs = [row for payload in provider_payloads for row in payload["logs"]]
    status = "completed"
    if any(provider["adapter_status"] != "completed" for provider in providers):
        status = "partial"
    if any(command["exit_code"] != 0 for command in commands):
        status = "partial"

    return {
        "schema_version": 1,
        "run_id": run_id,
        "started_at": started_at,
        "finished_at": finished_at,
        "status": status,
        "workflow_run_url": workflow_run_url,
        "warp": warp,
        "runner": runner,
        "providers": providers,
        "profiles": profiles,
        "results": results,
        "timeseries": timeseries,
        "commands": commands,
        "log_files": log_files,
        "logs": logs,
        "artifacts": artifacts,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Normalize provider Warp artifacts into a benchmark run JSON")
    parser.add_argument("--provider-dir", action="append", default=[], required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--started-at", default="")
    parser.add_argument("--finished-at", default="")
    parser.add_argument("--workflow-run-url", default="")
    parser.add_argument("--warp-repo", default="https://github.com/minio/warp")
    parser.add_argument("--warp-commit", default="")
    parser.add_argument("--warp-version", default="")
    parser.add_argument("--runner-json", default="{}")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    finished_at = args.finished_at or utc_now()
    started_at = args.started_at or finished_at
    run = normalize_benchmark_run(
        provider_dirs=[Path(path) for path in args.provider_dir],
        run_id=args.run_id or run_id_from_timestamp(finished_at),
        started_at=started_at,
        finished_at=finished_at,
        workflow_run_url=args.workflow_run_url,
        warp={"repo": args.warp_repo, "commit": args.warp_commit, "version": args.warp_version},
        runner=json.loads(args.runner_json),
    )
    write_json(Path(args.out), run)


if __name__ == "__main__":
    main()
