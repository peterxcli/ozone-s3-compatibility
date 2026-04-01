#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
from collections import defaultdict
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build static Pages output")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--new-run", required=True)
    parser.add_argument("--existing-runs-dir", default="")
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


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

    new_run = load_json(new_run_path)
    current_run_file = output_dir / "data" / "runs" / f"{new_run['run_id']}.json"
    shutil.copy2(new_run_path, current_run_file)

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
