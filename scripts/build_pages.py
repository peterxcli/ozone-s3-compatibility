#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

try:
    from scripts.benchmark_parquet import read_benchmark_dataset, write_benchmark_dataset
except ModuleNotFoundError:
    from benchmark_parquet import read_benchmark_dataset, write_benchmark_dataset


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build static Warp benchmark Pages output")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--new-run", required=True)
    parser.add_argument("--existing-runs-dir", default="")
    parser.add_argument("--data-format", choices=["parquet", "both"], default="parquet")
    return parser.parse_args(argv)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_run(path: Path) -> dict[str, Any]:
    if path.is_file():
        return load_json(path)
    if path.is_dir():
        run_json = path / "run.json"
        if run_json.exists():
            return load_json(run_json)
        metadata = path / "metadata.parquet"
        if metadata.exists():
            return read_benchmark_dataset(path)
    raise FileNotFoundError(path)


def load_existing_runs(path_text: str) -> list[dict[str, Any]]:
    if not path_text:
        return []
    root = Path(path_text)
    if not root.exists():
        return []
    runs: list[dict[str, Any]] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        try:
            runs.append(load_run(child))
        except FileNotFoundError:
            continue
    return runs


def unique_runs(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for run in runs:
        run_id = str(run.get("run_id") or "")
        if not run_id:
            continue
        by_id[run_id] = run
    return sorted(by_id.values(), key=lambda item: str(item.get("started_at") or ""), reverse=True)


def copy_tree_contents(source: Path, destination: Path) -> None:
    if not source.exists():
        return
    for child in source.iterdir():
        target = destination / child.name
        if child.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(child, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(child, target)


def write_fallback_index(output_dir: Path) -> None:
    index_path = output_dir / "index.html"
    if index_path.exists():
        return
    index_path.write_text(
        """<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Warp S3 Benchmark Report</title>
  </head>
  <body>
    <div id="app">Warp S3 Benchmark Report</div>
  </body>
</html>
""",
        encoding="utf-8",
    )


def write_bootstrap(data_dir: Path, runs: list[dict[str, Any]]) -> None:
    latest = runs[0] if runs else {}
    payload = {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "run_count": len(runs),
        "latest_run_id": latest.get("run_id", ""),
        "data_format": "parquet",
    }
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "index.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def build_pages(*, output_dir: Path, new_run_path: Path, existing_runs_dir: str = "") -> None:
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)

    repo_root = Path(__file__).resolve().parents[1]
    copy_tree_contents(repo_root / "site" / "dist", output_dir)
    copy_tree_contents(repo_root / "site" / "public", output_dir)
    write_fallback_index(output_dir)

    runs = unique_runs([load_run(new_run_path), *load_existing_runs(existing_runs_dir)])
    data_dir = output_dir / "data"
    write_benchmark_dataset(runs, data_dir)
    write_bootstrap(data_dir, runs)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    build_pages(
        output_dir=Path(args.output_dir),
        new_run_path=Path(args.new_run),
        existing_runs_dir=args.existing_runs_dir,
    )


if __name__ == "__main__":
    main()
