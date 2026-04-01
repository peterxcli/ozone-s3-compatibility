#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import shutil
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from normalize_run import normalize_mint_suite, normalize_s3_suite, overall_status


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build static Pages output")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--new-run", required=True)
    parser.add_argument("--existing-runs-dir", default="")
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def default_sources() -> dict[str, dict[str, str]]:
    return {
        "ozone": {
            "repo": "https://github.com/apache/ozone.git",
            "ref": "unknown",
            "commit": "unknown",
            "short_commit": "unknown",
        },
        "s3_tests": {
            "repo": "https://github.com/ceph/s3-tests.git",
            "ref": "unknown",
            "commit": "unknown",
            "short_commit": "unknown",
        },
        "mint": {
            "repo": "https://github.com/minio/mint.git",
            "ref": "unknown",
            "commit": "unknown",
            "short_commit": "unknown",
        },
    }


def format_timestamp(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_id_from_timestamp(timestamp: str) -> str:
    return timestamp.replace(":", "-")


def artifact_file_times(raw_root: Path) -> tuple[str, str]:
    file_paths = [path for path in raw_root.rglob("*") if path.is_file() and path.name != ".DS_Store"]
    if not file_paths:
        now = format_timestamp(datetime.now(UTC).timestamp())
        return now, now

    started_at = format_timestamp(min(path.stat().st_mtime for path in file_paths))
    finished_at = format_timestamp(max(path.stat().st_mtime for path in file_paths))
    return started_at, finished_at


def infer_build_exit(raw_root: Path) -> int:
    build_log = raw_root / "ozone" / "build.log"
    if not build_log.exists():
        return 1
    return 0 if "BUILD SUCCESS" in build_log.read_text(encoding="utf-8", errors="replace") else 1


def infer_cluster_exit(raw_root: Path) -> int:
    start_log = raw_root / "ozone" / "start.log"
    if not start_log.exists():
        return 1
    text = start_log.read_text(encoding="utf-8", errors="replace")
    if "SCM is out of safe mode." in text or "No OM HA service, no need to wait" in text:
        return 0
    return 1


def infer_mint_mode(console_log: Path) -> str:
    if not console_log.exists():
        return "unknown"
    match = re.search(r"^MINT_MODE:\s+(.+)$", console_log.read_text(encoding="utf-8", errors="replace"), re.MULTILINE)
    return match.group(1).strip() if match else "unknown"


def infer_mint_targets(console_log: Path) -> str:
    if not console_log.exists():
        return ""
    targets: list[str] = []
    for line in console_log.read_text(encoding="utf-8", errors="replace").splitlines():
        match = re.search(r"^\(\d+/\d+\) Running ([A-Za-z0-9._+-]+) tests \.\.\.", line)
        if match:
            targets.append(match.group(1))
    return " ".join(targets)


def recover_run_from_artifact(run_path: Path) -> dict[str, Any]:
    raw_root = run_path / "raw" if (run_path / "raw").is_dir() else run_path
    started_at, finished_at = artifact_file_times(raw_root)
    run_id = run_id_from_timestamp(finished_at)

    console_log = raw_root / "mint" / "console.log"
    mint_log = raw_root / "mint" / "log" / "log.json"
    junit_path = raw_root / "s3-tests" / "junit.xml"

    recovered_args = argparse.Namespace(
        out="",
        run_id=run_id,
        started_at=started_at,
        finished_at=finished_at,
        workflow_run_url="",
        build_exit=infer_build_exit(raw_root),
        cluster_exit=infer_cluster_exit(raw_root),
        ozone_repo="https://github.com/apache/ozone.git",
        ozone_ref="unknown",
        ozone_commit="unknown",
        s3_tests_repo="https://github.com/ceph/s3-tests.git",
        s3_tests_ref="unknown",
        s3_tests_commit="unknown",
        s3_tests_source=str(run_path / "_missing_s3_tests_source"),
        s3_tests_junit=str(junit_path),
        s3_tests_exit=0 if junit_path.exists() else 1,
        s3_tests_args="s3tests/functional",
        mint_repo="https://github.com/minio/mint.git",
        mint_ref="unknown",
        mint_commit="unknown",
        mint_log=str(mint_log),
        mint_exit=0 if mint_log.exists() else 1,
        mint_mode=infer_mint_mode(console_log),
        mint_targets=infer_mint_targets(console_log),
        ozone_datanodes="unknown",
    )

    suites = {
        "s3_tests": normalize_s3_suite(recovered_args),
        "mint": normalize_mint_suite(recovered_args),
    }

    mint_summary = suites["mint"]["summary"]
    if mint_summary["failed"] or mint_summary["errored"]:
        suites["mint"]["exit_code"] = 1
        recovered_args.mint_exit = 1

    return {
        "schema_version": 1,
        "run_id": recovered_args.run_id,
        "started_at": recovered_args.started_at,
        "finished_at": recovered_args.finished_at,
        "status": overall_status(recovered_args.build_exit, recovered_args.cluster_exit, suites),
        "rate_formula": "compatibility_rate = passed / (passed + failed + errored); skipped and NA are excluded",
        "workflow_run_url": "",
        "orchestration": {
            "build_exit_code": recovered_args.build_exit,
            "cluster_exit_code": recovered_args.cluster_exit,
        },
        "execution": {
            "s3_tests_args": recovered_args.s3_tests_args,
            "mint_mode": recovered_args.mint_mode,
            "mint_targets": [target for target in recovered_args.mint_targets.split() if target],
            "ozone_datanodes": recovered_args.ozone_datanodes,
            "recovered_from_raw_artifact": True,
        },
        "sources": default_sources(),
        "suites": suites,
    }


def load_or_recover_run(path: Path) -> dict[str, Any]:
    if path.is_file():
        return load_json(path)
    if path.is_dir():
        direct_run = path / "run.json"
        if direct_run.exists():
            return load_json(direct_run)
        return recover_run_from_artifact(path)
    raise FileNotFoundError(path)


def summarize_run(run: dict[str, Any], file_name: str) -> dict[str, Any]:
    suites: dict[str, Any] = {}
    for suite_key, suite in run["suites"].items():
        suites[suite_key] = {
            "label": suite["label"],
            "status": suite["status"],
            "summary": suite["summary"],
            "feature_summaries": suite["feature_summaries"],
        }
    return {
        "id": run["run_id"],
        "status": run["status"],
        "started_at": run["started_at"],
        "finished_at": run["finished_at"],
        "workflow_run_url": run.get("workflow_run_url", ""),
        "execution": run.get("execution"),
        "file": f"data/runs/{file_name}",
        "sources": run["sources"],
        "suites": suites,
    }


def build_index(runs: list[dict[str, Any]]) -> dict[str, Any]:
    summaries = [summarize_run(run, f"{run['run_id']}.json") for run in runs]
    summaries.sort(key=lambda item: item["started_at"], reverse=True)

    overall: dict[str, list[dict[str, Any]]] = defaultdict(list)
    features: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))

    for summary in sorted(summaries, key=lambda item: item["started_at"]):
        for suite_key, suite in summary["suites"].items():
            overall[suite_key].append(
                {
                    "run_id": summary["id"],
                    "started_at": summary["started_at"],
                    "rate": suite["summary"]["compatibility_rate"],
                    "eligible": suite["summary"]["eligible"],
                }
            )
            for feature in suite["feature_summaries"]:
                features[suite_key][feature["name"]].append(
                    {
                        "run_id": summary["id"],
                        "started_at": summary["started_at"],
                        "rate": feature["summary"]["compatibility_rate"],
                        "eligible": feature["summary"]["eligible"],
                        "passed": feature["summary"]["passed"],
                        "failed": feature["summary"]["failed"],
                        "errored": feature["summary"]["errored"],
                        "skipped": feature["summary"]["skipped"],
                    }
                )

    return {
        "generated_at": summaries[0]["finished_at"] if summaries else "",
        "rate_formula": "compatibility_rate = passed / (passed + failed + errored); skipped and NA are excluded",
        "suite_order": ["s3_tests", "mint"],
        "runs": summaries,
        "charts": {
            "overall": overall,
            "features": {suite: dict(feature_map) for suite, feature_map in features.items()},
        },
    }


def copy_tree(source: Path, target: Path) -> None:
    for file_path in source.rglob("*"):
        if file_path.is_dir():
            continue
        rel = file_path.relative_to(source)
        destination = target / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file_path, destination)


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir)
    site_dir = Path(__file__).resolve().parent.parent / "site"
    new_run_path = Path(args.new_run)
    existing_runs_dir = Path(args.existing_runs_dir) if args.existing_runs_dir else None

    if output_dir.exists():
        shutil.rmtree(output_dir)
    (output_dir / "data" / "runs").mkdir(parents=True, exist_ok=True)

    if existing_runs_dir and existing_runs_dir.exists():
        for run_file in sorted(existing_runs_dir.glob("*.json")):
            shutil.copy2(run_file, output_dir / "data" / "runs" / run_file.name)

    new_run = load_or_recover_run(new_run_path)
    current_run_file = output_dir / "data" / "runs" / f"{new_run['run_id']}.json"
    current_run_file.write_text(json.dumps(new_run, indent=2, sort_keys=False) + "\n", encoding="utf-8")

    runs = [load_json(path) for path in sorted((output_dir / "data" / "runs").glob("*.json"))]
    index_payload = build_index(runs)
    (output_dir / "data" / "index.json").write_text(
        json.dumps(index_payload, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )

    copy_tree(site_dir, output_dir)
    (output_dir / ".nojekyll").write_text("", encoding="utf-8")


if __name__ == "__main__":
    main()
