#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import shutil
from collections import defaultdict
from datetime import UTC, datetime
from html import escape
from pathlib import Path
from typing import Any

from normalize_run import normalize_mint_suite, normalize_s3_suite, overall_status

DEFAULT_S3_TESTS_ARGS = "s3tests/functional"


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
        mint_console=str(console_log),
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


def format_preview_timestamp(value: str) -> str:
    moment = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    hour = moment.hour % 12 or 12
    meridiem = "AM" if moment.hour < 12 else "PM"
    return f"{moment.strftime('%b')} {moment.day}, {moment.year}, {hour}:{moment.strftime('%M')} {meridiem} UTC"


def format_percent(rate: float | None) -> str:
    if rate is None:
        return "—"
    return f"{rate * 100:.1f}%"


def execution_scope(execution: dict[str, Any] | None) -> tuple[str, str]:
    if not execution:
        return "unknown", "Run inputs unavailable"

    mint_targets = execution.get("mint_targets", [])
    if isinstance(mint_targets, str):
        mint_targets = [target for target in mint_targets.split() if target]

    s3_tests_args = execution.get("s3_tests_args") or DEFAULT_S3_TESTS_ARGS
    if s3_tests_args != DEFAULT_S3_TESTS_ARGS or mint_targets:
        return "subset", "Subset run"

    return "full", "Full nightly"


def pill_width(label: str, minimum: int = 112) -> int:
    return max(minimum, 36 + len(label) * 9)


def delta_text_and_fill(delta: float | None, rate: float | None) -> tuple[str, str]:
    if rate is None:
        return "No eligible cases", "#60758e"
    if delta is None:
        return "No previous data", "#60758e"
    if delta >= 0:
        return f"+{delta * 100:.1f} pts vs previous", "#0f9d71"
    return f"{delta * 100:.1f} pts vs previous", "#d2493a"


def suite_delta(runs: list[dict[str, Any]], suite_key: str) -> float | None:
    if len(runs) < 2:
        return None

    latest_suite = runs[0]["suites"].get(suite_key)
    if not latest_suite:
        return None

    latest_rate = latest_suite["summary"].get("compatibility_rate")
    if latest_rate is None:
        return None

    for previous in runs[1:]:
        previous_suite = previous["suites"].get(suite_key)
        if not previous_suite:
            continue
        previous_rate = previous_suite["summary"].get("compatibility_rate")
        if previous_rate is not None:
            return latest_rate - previous_rate

    return None


def status_colors(status: str) -> tuple[str, str, str]:
    if status == "completed":
        return "#0f9d71", "#0f9d71", "0.10"
    if status == "partial":
        return "#ff8a3d", "#ff8a3d", "0.12"
    if status in {"build_failed", "cluster_failed"}:
        return "#d2493a", "#d2493a", "0.12"
    return "#60758e", "#60758e", "0.10"


def scope_colors(kind: str) -> tuple[str, str, str]:
    if kind == "full":
        return "#0f9d71", "#0f9d71", "0.10"
    if kind == "subset":
        return "#ff8a3d", "#ff8a3d", "0.12"
    return "#60758e", "#60758e", "0.10"


def render_suite_card(run: dict[str, Any], runs: list[dict[str, Any]], suite_key: str, x: int, y: int) -> str:
    suite = run["suites"].get(suite_key, {})
    summary = suite.get("summary", {})
    delta = suite_delta(runs, suite_key)
    delta_text, delta_fill = delta_text_and_fill(delta, summary.get("compatibility_rate"))
    failed_or_errored = summary.get("failed", 0) + summary.get("errored", 0)
    label = escape((suite.get("label") or suite_key).upper())

    return f"""
    <g transform="translate({x} {y})">
      <rect width="470" height="228" rx="26" fill="url(#card)" stroke="#d7e2ee" />
      <text x="24" y="38" font-size="15" font-weight="800" letter-spacing="2.5" fill="#0b6286">{label}</text>
      <text x="24" y="86" font-size="22" font-weight="700">{summary.get("eligible", 0)} eligible cases</text>
      <text x="24" y="152" font-size="58" font-weight="500">{escape(format_percent(summary.get("compatibility_rate")))}</text>
      <text x="24" y="192" font-size="18" font-weight="500" fill="#60758e">{summary.get("passed", 0)} passed, {failed_or_errored} failed/error, {summary.get("skipped", 0)} skipped</text>
      <text x="24" y="216" font-size="18" font-weight="800" fill="{delta_fill}">{escape(delta_text)}</text>
    </g>"""


def write_social_preview(index_payload: dict[str, Any], output_path: Path) -> None:
    runs = index_payload.get("runs", [])
    if not runs:
        return

    latest = runs[0]
    execution = latest.get("execution")
    scope_kind, scope_label = execution_scope(execution)
    scope_fill, scope_stroke, scope_bg_opacity = scope_colors(scope_kind)
    status_fill, status_stroke, status_bg_opacity = status_colors(latest.get("status", ""))
    scope_width = pill_width(scope_label, minimum=128)
    status_label = (latest.get("status") or "unknown").replace("_", " ")
    status_width = pill_width(status_label)
    latest_time = format_preview_timestamp(latest.get("finished_at") or latest["started_at"])
    ozone_commit = latest.get("sources", {}).get("ozone", {}).get("short_commit", "unknown")
    title = "Apache Ozone S3 Compatibility"
    description = (
        "Nightly GitHub Pages report for Apache Ozone S3 compatibility against s3-tests and mint, "
        f"latest run {latest_time}."
    )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc">
  <title id="title">{escape(title)}</title>
  <desc id="desc">{escape(description)}</desc>

  <defs>
    <linearGradient id="page" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f8fbff" />
      <stop offset="100%" stop-color="#f4f7fb" />
    </linearGradient>
    <radialGradient id="glowBlue" cx="18%" cy="18%" r="45%">
      <stop offset="0%" stop-color="#0d7fab" stop-opacity="0.16" />
      <stop offset="100%" stop-color="#0d7fab" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="glowWarm" cx="86%" cy="14%" r="38%">
      <stop offset="0%" stop-color="#ff8a3d" stop-opacity="0.18" />
      <stop offset="100%" stop-color="#ff8a3d" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="card" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.96" />
      <stop offset="100%" stop-color="#f7faff" stop-opacity="0.88" />
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="18" stdDeviation="28" flood-color="#102d4c" flood-opacity="0.10" />
    </filter>
  </defs>

  <rect width="1200" height="630" fill="url(#page)" />
  <rect width="1200" height="630" fill="url(#glowBlue)" />
  <rect width="1200" height="630" fill="url(#glowWarm)" />

  <g filter="url(#shadow)">
    <rect x="28" y="24" width="1144" height="582" rx="36" fill="#ffffff" fill-opacity="0.86" stroke="#ffffff" stroke-opacity="0.75" />
  </g>

  <g font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" fill="#12263f">
    <text x="60" y="78" font-size="15" font-weight="800" letter-spacing="3" fill="#0b6286">NIGHTLY GITHUB PAGES REPORT</text>

    <text x="60" y="152" font-size="72" font-weight="800">Apache Ozone</text>
    <text x="60" y="228" font-size="72" font-weight="800">S3</text>
    <text x="60" y="304" font-size="72" font-weight="800">Compatibility</text>

    <text x="60" y="368" font-size="20" font-weight="500" fill="#60758e">Tracks daily compatibility against ceph/s3-tests</text>
    <text x="60" y="400" font-size="20" font-weight="500" fill="#60758e">and minio/mint from a fresh Ozone build and packaged cluster.</text>
  </g>

  <g font-family="'SFMono-Regular', Consolas, 'Liberation Mono', monospace" font-size="14" font-weight="600">
    <g transform="translate(60 456)">
      <rect width="308" height="40" rx="20" fill="#ffffff" fill-opacity="0.94" stroke="#d7e2ee" />
      <text x="18" y="25" fill="#12263f">{escape(latest_time)}</text>
    </g>
    <g transform="translate(382 456)">
      <rect width="184" height="40" rx="20" fill="#ffffff" fill-opacity="0.94" stroke="#d7e2ee" />
      <text x="18" y="25" fill="#12263f">Ozone {escape(ozone_commit)}</text>
    </g>
  </g>

  <g font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="16" font-weight="700">
    <g transform="translate(580 456)">
      <rect width="{scope_width}" height="40" rx="20" fill="{scope_fill}" fill-opacity="{scope_bg_opacity}" stroke="{scope_stroke}" stroke-opacity="0.24" />
      <text x="20" y="26" fill="{scope_fill}">{escape(scope_label)}</text>
    </g>
    <g transform="translate(60 510)">
      <rect width="{status_width}" height="40" rx="20" fill="{status_fill}" fill-opacity="{status_bg_opacity}" stroke="{status_stroke}" stroke-opacity="0.24" />
      <text x="20" y="26" fill="{status_fill}">{escape(status_label)}</text>
    </g>
  </g>

  <g font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" fill="#12263f">
{render_suite_card(latest, runs, "s3_tests", 690, 62)}
{render_suite_card(latest, runs, "mint", 690, 342)}
  </g>
</svg>
"""

    output_path.write_text(svg + "\n", encoding="utf-8")


def copy_tree(source: Path, target: Path) -> None:
    for file_path in source.rglob("*"):
        if file_path.is_dir():
            continue
        rel = file_path.relative_to(source)
        destination = target / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file_path, destination)


def built_site_dir() -> Path:
    site_dist = Path(__file__).resolve().parent.parent / "site" / "dist"
    if site_dist.is_dir():
        return site_dist
    raise FileNotFoundError(
        f"Missing built frontend at {site_dist}. Run `npm --prefix site ci && npm --prefix site run build` first."
    )


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir)
    site_dir = built_site_dir()
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
    write_social_preview(index_payload, output_dir / "social-preview.svg")
    (output_dir / ".nojekyll").write_text("", encoding="utf-8")


if __name__ == "__main__":
    main()
