#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


DEFAULT_S3_TESTS_ARGS = "s3tests/functional"
SUITE_ORDER = ["s3_tests", "mint"]
NON_PASSING_STATUSES = {"fail", "error", "skipped"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare an Ozone PR compatibility run with the latest published run")
    parser.add_argument("--candidate", required=True, help="Candidate run.json from the PR compatibility run")
    parser.add_argument("--baseline-run", default="", help="Specific baseline run.json to compare against")
    parser.add_argument("--baseline-runs-dir", default="", help="Directory containing published baseline run JSON files")
    parser.add_argument("--output", required=True, help="Markdown file to write")
    parser.add_argument("--pr-url", default="")
    parser.add_argument("--trigger-comment-url", default="")
    parser.add_argument("--max-cases", type=int, default=25)
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_timestamp(value: str) -> datetime:
    if not value:
        return datetime.fromtimestamp(0, UTC)
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def is_mainstream_run(run: dict[str, Any]) -> bool:
    execution = run.get("execution") or {}
    ozone = run.get("sources", {}).get("ozone", {})
    ozone_ref = ozone.get("ref", "")
    mint_targets = execution.get("mint_targets", [])
    if isinstance(mint_targets, str):
        mint_targets = [target for target in mint_targets.split() if target]

    return (
        ozone_ref in {"master", "main", "refs/heads/master", "refs/heads/main"}
        and (execution.get("s3_tests_args") or DEFAULT_S3_TESTS_ARGS) == DEFAULT_S3_TESTS_ARGS
        and not mint_targets
    )


def latest_run_from_dir(runs_dir: Path) -> dict[str, Any] | None:
    if not runs_dir.is_dir():
        return None

    runs = [load_json(path) for path in sorted(runs_dir.glob("*.json"))]
    if not runs:
        return None

    runs.sort(key=lambda item: parse_timestamp(item.get("finished_at") or item.get("started_at", "")), reverse=True)
    for run in runs:
        if is_mainstream_run(run):
            return run
    return runs[0]


def suite_label(suite_key: str, suite: dict[str, Any] | None) -> str:
    if suite and suite.get("label"):
        return str(suite["label"])
    return suite_key.replace("_", "-")


def case_key(case: dict[str, Any]) -> str:
    classname = str(case.get("classname") or "")
    name = str(case.get("name") or "")
    return f"{classname}::{name}"


def case_status(case: dict[str, Any] | None) -> str:
    if not case:
        return "pass"
    return str(case.get("status") or "unknown")


def suite_case_map(suite: dict[str, Any] | None) -> tuple[dict[str, dict[str, Any]], bool]:
    if not suite:
        return {}, False

    if isinstance(suite.get("cases"), list):
        return {case_key(case): case for case in suite["cases"]}, True

    cases = suite.get("non_passing_cases", [])
    if not isinstance(cases, list):
        cases = []
    return {case_key(case): case for case in cases}, False


def non_passing(case: dict[str, Any] | None) -> bool:
    return case_status(case) in NON_PASSING_STATUSES


def summarize_suite_deltas(
    candidate_suite: dict[str, Any] | None,
    baseline_suite: dict[str, Any] | None,
) -> dict[str, list[tuple[dict[str, Any], dict[str, Any] | None]]]:
    candidate_cases, candidate_has_all_cases = suite_case_map(candidate_suite)
    baseline_cases, baseline_has_all_cases = suite_case_map(baseline_suite)
    deltas: dict[str, list[tuple[dict[str, Any], dict[str, Any] | None]]] = {
        "new_non_passing": [],
        "no_longer_non_passing": [],
        "changed_non_passing": [],
        "still_non_passing": [],
    }

    for key, candidate_case in sorted(candidate_cases.items()):
        if not non_passing(candidate_case):
            baseline_case = baseline_cases.get(key)
            if baseline_case and non_passing(baseline_case):
                deltas["no_longer_non_passing"].append((candidate_case, baseline_case))
            continue

        baseline_case = baseline_cases.get(key)
        if baseline_case and non_passing(baseline_case):
            if case_status(candidate_case) == case_status(baseline_case):
                deltas["still_non_passing"].append((candidate_case, baseline_case))
            else:
                deltas["changed_non_passing"].append((candidate_case, baseline_case))
        elif baseline_has_all_cases or not baseline_case:
            deltas["new_non_passing"].append((candidate_case, baseline_case))

    if candidate_has_all_cases:
        for key, baseline_case in sorted(baseline_cases.items()):
            if key not in candidate_cases and non_passing(baseline_case):
                deltas["changed_non_passing"].append(
                    (
                        {
                            "classname": baseline_case.get("classname", ""),
                            "name": baseline_case.get("name", ""),
                            "status": "not_run",
                            "message": "not present in candidate run output",
                        },
                        baseline_case,
                    )
                )

    return deltas


def format_percent(rate: float | None) -> str:
    if rate is None:
        return "n/a"
    return f"{rate * 100:.1f}%"


def format_delta(candidate_rate: float | None, baseline_rate: float | None) -> str:
    if candidate_rate is None or baseline_rate is None:
        return "n/a"
    delta = (candidate_rate - baseline_rate) * 100
    sign = "+" if delta >= 0 else ""
    return f"{sign}{delta:.1f} pts"


def summary_counts(summary: dict[str, Any] | None) -> str:
    if not summary:
        return "n/a"
    return (
        f"{summary.get('passed', 0)} passed / "
        f"{summary.get('failed', 0)} failed / "
        f"{summary.get('errored', 0)} errored / "
        f"{summary.get('skipped', 0)} skipped"
    )


def markdown_escape(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ").strip()


def run_ref(run: dict[str, Any]) -> str:
    ozone = run.get("sources", {}).get("ozone", {})
    short_commit = ozone.get("short_commit") or "unknown"
    ref = ozone.get("ref") or "unknown"
    return f"`{markdown_escape(str(short_commit))}` from `{markdown_escape(str(ref))}`"


def case_line(case: dict[str, Any], baseline_case: dict[str, Any] | None = None) -> str:
    status = case_status(case)
    name = case_key(case)
    message = markdown_escape(str(case.get("message") or ""))
    baseline_status = case_status(baseline_case) if baseline_case else "not recorded as non-passing"
    suffix = f" (baseline: {baseline_status})"
    if message:
        suffix += f" - {message}"
    return f"- `{status}` `{name}`{suffix}"


def render_case_section(
    title: str,
    rows: list[tuple[dict[str, Any], dict[str, Any] | None]],
    max_cases: int,
) -> list[str]:
    if not rows:
        return []

    lines = [f"**{title}**"]
    for case, baseline_case in rows[:max_cases]:
        lines.append(case_line(case, baseline_case))
    hidden = len(rows) - max_cases
    if hidden > 0:
        lines.append(f"- ... {hidden} more")
    return lines + [""]


def render_summary_table(candidate: dict[str, Any], baseline: dict[str, Any]) -> list[str]:
    suite_keys = [key for key in SUITE_ORDER if key in candidate.get("suites", {}) or key in baseline.get("suites", {})]
    extras = sorted((set(candidate.get("suites", {})) | set(baseline.get("suites", {}))) - set(suite_keys))
    suite_keys.extend(extras)

    lines = [
        "| Suite | PR run | PR rate | Latest main | Main rate | Delta |",
        "| --- | --- | ---: | --- | ---: | ---: |",
    ]
    for suite_key in suite_keys:
        candidate_suite = candidate.get("suites", {}).get(suite_key)
        baseline_suite = baseline.get("suites", {}).get(suite_key)
        candidate_summary = (candidate_suite or {}).get("summary")
        baseline_summary = (baseline_suite or {}).get("summary")
        lines.append(
            "| "
            f"{markdown_escape(suite_label(suite_key, candidate_suite or baseline_suite))} | "
            f"{markdown_escape(summary_counts(candidate_summary))} | "
            f"{format_percent((candidate_summary or {}).get('compatibility_rate'))} | "
            f"{markdown_escape(summary_counts(baseline_summary))} | "
            f"{format_percent((baseline_summary or {}).get('compatibility_rate'))} | "
            f"{format_delta((candidate_summary or {}).get('compatibility_rate'), (baseline_summary or {}).get('compatibility_rate'))} |"
        )
    return lines


def render_comparison_markdown(
    candidate: dict[str, Any],
    baseline: dict[str, Any] | None,
    pr_url: str = "",
    trigger_comment_url: str = "",
    max_cases: int = 25,
) -> str:
    lines = [
        "<!-- ozone-s3-compatibility-bot -->",
        "## Apache Ozone S3 compatibility result",
        "",
    ]

    if pr_url:
        lines.append(f"PR: {pr_url}")
    if trigger_comment_url:
        lines.append(f"Trigger comment: {trigger_comment_url}")
    if pr_url or trigger_comment_url:
        lines.append("")

    if not baseline:
        lines.extend(
            [
                f"Candidate run: {run_ref(candidate)}",
                "",
                "No published baseline run was found in `gh-pages/data/runs`, so this report cannot compare against the latest published main run.",
                "",
            ]
        )
        return "\n".join(lines).rstrip() + "\n"

    lines.extend(
        [
            f"Candidate run: {run_ref(candidate)}",
            f"Baseline: latest published main run `{baseline.get('run_id', 'unknown')}` ({run_ref(baseline)})",
            "",
        ]
    )

    workflow_run_url = candidate.get("workflow_run_url")
    if workflow_run_url:
        lines.extend([f"Actions run: {workflow_run_url}", ""])

    if candidate.get("status") != "completed":
        lines.extend(
            [
                f"Run status: `{candidate.get('status', 'unknown')}`.",
                "Suite output may be partial because the build, cluster, or test phase did not complete.",
                "",
            ]
        )

    lines.extend(render_summary_table(candidate, baseline))
    lines.append("")

    candidate_suites = candidate.get("suites", {})
    baseline_suites = baseline.get("suites", {})
    for suite_key in [key for key in SUITE_ORDER if key in candidate_suites or key in baseline_suites]:
        candidate_suite = candidate_suites.get(suite_key)
        baseline_suite = baseline_suites.get(suite_key)
        deltas = summarize_suite_deltas(candidate_suite, baseline_suite)
        if not any(deltas.values()):
            continue

        lines.extend([f"### {suite_label(suite_key, candidate_suite or baseline_suite)}", ""])
        lines.extend(render_case_section("New non-passing cases", deltas["new_non_passing"], max_cases))
        lines.extend(render_case_section("No longer non-passing", deltas["no_longer_non_passing"], max_cases))
        lines.extend(render_case_section("Changed non-passing status", deltas["changed_non_passing"], max_cases))
        lines.extend(render_case_section("Still non-passing", deltas["still_non_passing"], max_cases))

    lines.extend(
        [
            "Baseline note: the latest published main run stores all Mint cases and only non-passing `s3-tests` cases.",
            "A PR-only run keeps all `s3-tests` cases in the Actions artifact, but it is not written to `gh-pages/data/runs`.",
            "",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    args = parse_args()
    candidate = load_json(Path(args.candidate))

    baseline = None
    if args.baseline_run:
        baseline = load_json(Path(args.baseline_run))
    elif args.baseline_runs_dir:
        baseline = latest_run_from_dir(Path(args.baseline_runs_dir))

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        render_comparison_markdown(
            candidate,
            baseline,
            pr_url=args.pr_url,
            trigger_comment_url=args.trigger_comment_url,
            max_cases=args.max_cases,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
