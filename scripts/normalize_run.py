#!/usr/bin/env python3

from __future__ import annotations

import argparse
import ast
import json
import os
from collections import defaultdict
from pathlib import Path
from typing import Any
from xml.etree import ElementTree


IGNORED_S3_MARKERS = {
    "auth_aws2",
    "auth_aws4",
    "auth_common",
    "fails_without_logging_rollover",
    "fails_on_aws",
    "fails_on_dbstore",
    "fails_on_dho",
    "fails_on_mod_proxy_fcgi",
    "fails_on_rgw",
    "fails_on_s3",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Normalize nightly Ozone compatibility outputs")
    parser.add_argument("--out", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--started-at", required=True)
    parser.add_argument("--finished-at", required=True)
    parser.add_argument("--workflow-run-url", default="")
    parser.add_argument("--build-exit", type=int, default=0)
    parser.add_argument("--cluster-exit", type=int, default=0)
    parser.add_argument("--ozone-repo", required=True)
    parser.add_argument("--ozone-ref", required=True)
    parser.add_argument("--ozone-commit", required=True)
    parser.add_argument("--s3-tests-repo", required=True)
    parser.add_argument("--s3-tests-ref", required=True)
    parser.add_argument("--s3-tests-commit", required=True)
    parser.add_argument("--s3-tests-source", required=True)
    parser.add_argument("--s3-tests-junit", required=True)
    parser.add_argument("--s3-tests-exit", type=int, default=0)
    parser.add_argument("--s3-tests-args", default="s3tests/functional")
    parser.add_argument("--mint-repo", required=True)
    parser.add_argument("--mint-ref", required=True)
    parser.add_argument("--mint-commit", required=True)
    parser.add_argument("--mint-log", required=True)
    parser.add_argument("--mint-exit", type=int, default=0)
    parser.add_argument("--mint-mode", default="core")
    parser.add_argument("--mint-targets", default="")
    parser.add_argument("--ozone-datanodes", default="1")
    return parser.parse_args()


def short_commit(value: str) -> str:
    return value[:12]


def truncate(value: str | None, limit: int = 600) -> str:
    if not value:
        return ""
    value = value.strip()
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def strip_param_suffix(name: str) -> str:
    return name.split("[", 1)[0]


def file_feature_name(module_name: str) -> str:
    stem = module_name.rsplit(".", 1)[-1]
    return stem[5:] if stem.startswith("test_") else stem


def marker_name_from_decorator(node: ast.AST) -> str | None:
    if isinstance(node, ast.Call):
        node = node.func
    if (
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Attribute)
        and isinstance(node.value.value, ast.Name)
        and node.value.value.id == "pytest"
        and node.value.attr == "mark"
    ):
        return node.attr
    return None


def module_name_for_file(source_root: Path, file_path: Path) -> str:
    rel_path = file_path.relative_to(source_root).with_suffix("")
    return ".".join(rel_path.parts)


def collect_s3_markers(source_root: Path) -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}

    def visit_functions(module_name: str, class_prefix: str, class_markers: list[str], body: list[ast.stmt]) -> None:
        for statement in body:
            if isinstance(statement, ast.ClassDef):
                next_prefix = f"{class_prefix}{statement.name}."
                next_markers = class_markers + [
                    marker
                    for marker in (marker_name_from_decorator(node) for node in statement.decorator_list)
                    if marker
                ]
                visit_functions(module_name, next_prefix, next_markers, statement.body)
            elif isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)) and statement.name.startswith("test"):
                markers = class_markers + [
                    marker
                    for marker in (marker_name_from_decorator(node) for node in statement.decorator_list)
                    if marker
                ]
                key = f"{module_name}::{class_prefix}{statement.name}"
                index[key] = sorted(set(markers))

    for file_path in sorted(source_root.rglob("test*.py")):
        try:
            tree = ast.parse(file_path.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        visit_functions(module_name_for_file(source_root, file_path), "", [], tree.body)

    return index


def parse_junit_cases(xml_path: Path) -> list[dict[str, Any]]:
    if not xml_path.exists():
        return []

    root = ElementTree.parse(xml_path).getroot()
    parsed: list[dict[str, Any]] = []
    for testcase in root.iter("testcase"):
        status = "pass"
        message = ""
        detail = ""

        failure = testcase.find("failure")
        error = testcase.find("error")
        skipped = testcase.find("skipped")

        if failure is not None:
            status = "fail"
            message = failure.attrib.get("message", "")
            detail = failure.text or ""
        elif error is not None:
            status = "error"
            message = error.attrib.get("message", "")
            detail = error.text or ""
        elif skipped is not None:
            status = "skipped"
            message = skipped.attrib.get("message", "")
            detail = skipped.text or ""

        parsed.append(
            {
                "name": testcase.attrib.get("name", ""),
                "name_base": strip_param_suffix(testcase.attrib.get("name", "")),
                "classname": testcase.attrib.get("classname", ""),
                "time_seconds": float(testcase.attrib.get("time", "0") or 0),
                "status": status,
                "message": truncate(message),
                "detail": truncate(detail),
            }
        )
    return parsed


def summarize_cases(cases: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {
        "total": len(cases),
        "passed": 0,
        "failed": 0,
        "errored": 0,
        "skipped": 0,
        "eligible": 0,
        "compatibility_rate": None,
    }

    for case in cases:
        if case["status"] == "pass":
            counts["passed"] += 1
        elif case["status"] == "fail":
            counts["failed"] += 1
        elif case["status"] == "error":
            counts["errored"] += 1
        else:
            counts["skipped"] += 1

    counts["eligible"] = counts["passed"] + counts["failed"] + counts["errored"]
    if counts["eligible"]:
        counts["compatibility_rate"] = round(counts["passed"] / counts["eligible"], 4)
    return counts


def build_feature_summaries(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for case in cases:
        for feature in case["features"]:
            buckets[feature].append(case)

    summaries: list[dict[str, Any]] = []
    for feature_name, feature_cases in sorted(buckets.items()):
        summary = summarize_cases(feature_cases)
        examples = [
            {
                "name": case["name"],
                "status": case["status"],
                "message": case["message"],
            }
            for case in feature_cases
            if case["status"] != "pass"
        ][:12]
        summaries.append(
            {
                "name": feature_name,
                "label": feature_name.replace("_", " "),
                "summary": summary,
                "examples": examples,
            }
        )

    summaries.sort(
        key=lambda item: (
            -(item["summary"]["eligible"]),
            item["summary"]["compatibility_rate"] if item["summary"]["compatibility_rate"] is not None else -1,
            item["name"],
        )
    )
    return summaries


def normalize_s3_suite(args: argparse.Namespace) -> dict[str, Any]:
    cases = parse_junit_cases(Path(args.s3_tests_junit))
    markers_index = collect_s3_markers(Path(args.s3_tests_source))

    for case in cases:
        exact_key = f'{case["classname"]}::{case["name_base"]}'
        raw_markers = markers_index.get(exact_key, [])
        feature_markers = [marker for marker in raw_markers if marker not in IGNORED_S3_MARKERS and not marker.startswith("fails_on_")]
        if not feature_markers:
            fallback = file_feature_name(case["classname"] or "s3_tests")
            feature_markers = [fallback]
        case["features"] = sorted(set(feature_markers))
        case["duration_ms"] = round(case.pop("time_seconds", 0) * 1000)

    suite_status = "completed" if cases else "not_run"
    if args.s3_tests_exit and not cases:
        suite_status = "error"

    non_passing_cases = [
        {
            "name": case["name"],
            "classname": case["classname"],
            "features": case["features"],
            "status": case["status"],
            "duration_ms": case["duration_ms"],
            "message": case["message"],
            "detail": case["detail"],
        }
        for case in cases
        if case["status"] != "pass"
    ]

    return {
        "key": "s3_tests",
        "label": "s3-tests",
        "status": suite_status,
        "exit_code": args.s3_tests_exit,
        "summary": summarize_cases(cases),
        "feature_summaries": build_feature_summaries(cases),
        "included_case_strategy": "non_passing_only",
        "non_passing_cases": non_passing_cases,
    }


def normalize_mint_status(raw_status: str) -> str:
    normalized = raw_status.strip().upper()
    if normalized == "PASS":
        return "pass"
    if normalized == "FAIL":
        return "fail"
    return "skipped"


def normalize_mint_suite(args: argparse.Namespace) -> dict[str, Any]:
    log_path = Path(args.mint_log)
    cases: list[dict[str, Any]] = []
    if log_path.exists():
        for line in log_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            cases.append(
                {
                    "name": entry.get("function", ""),
                    "classname": entry.get("name", ""),
                    "features": [entry.get("name", "misc")],
                    "status": normalize_mint_status(entry.get("status", "")),
                    "duration_ms": int(entry.get("duration", 0) or 0),
                    "message": truncate(entry.get("message", "") or entry.get("alert", "")),
                    "detail": truncate(entry.get("error", "")),
                }
            )

    suite_status = "completed" if cases else "not_run"
    if args.mint_exit and not cases:
        suite_status = "error"

    return {
        "key": "mint",
        "label": "mint",
        "status": suite_status,
        "exit_code": args.mint_exit,
        "summary": summarize_cases(cases),
        "feature_summaries": build_feature_summaries(cases),
        "included_case_strategy": "all",
        "cases": cases,
    }


def overall_status(build_exit: int, cluster_exit: int, suites: dict[str, Any]) -> str:
    if build_exit != 0:
        return "build_failed"
    if cluster_exit != 0:
        return "cluster_failed"
    if any(suite["status"] == "error" for suite in suites.values()):
        return "partial"
    return "completed"


def main() -> None:
    args = parse_args()
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    suites = {
        "s3_tests": normalize_s3_suite(args),
        "mint": normalize_mint_suite(args),
    }

    payload = {
        "schema_version": 1,
        "run_id": args.run_id,
        "started_at": args.started_at,
        "finished_at": args.finished_at,
        "status": overall_status(args.build_exit, args.cluster_exit, suites),
        "rate_formula": "compatibility_rate = passed / (passed + failed + errored); skipped and NA are excluded",
        "workflow_run_url": args.workflow_run_url,
        "orchestration": {
            "build_exit_code": args.build_exit,
            "cluster_exit_code": args.cluster_exit,
        },
        "execution": {
            "s3_tests_args": args.s3_tests_args,
            "mint_mode": args.mint_mode,
            "mint_targets": [target for target in args.mint_targets.split() if target],
            "ozone_datanodes": args.ozone_datanodes,
        },
        "sources": {
            "ozone": {
                "repo": args.ozone_repo,
                "ref": args.ozone_ref,
                "commit": args.ozone_commit,
                "short_commit": short_commit(args.ozone_commit),
            },
            "s3_tests": {
                "repo": args.s3_tests_repo,
                "ref": args.s3_tests_ref,
                "commit": args.s3_tests_commit,
                "short_commit": short_commit(args.s3_tests_commit),
            },
            "mint": {
                "repo": args.mint_repo,
                "ref": args.mint_ref,
                "commit": args.mint_commit,
                "short_commit": short_commit(args.mint_commit),
            },
        },
        "suites": suites,
    }

    out_path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
