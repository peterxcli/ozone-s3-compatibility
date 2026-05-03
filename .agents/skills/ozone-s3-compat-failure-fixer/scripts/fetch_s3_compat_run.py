#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_COMPAT_REPO = "peterxcli/ozone-s3-compatibility"
DEFAULT_DOWNLOAD_DIR = Path("/tmp/ozone-s3-compat")
WORKFLOW_FILE = "ozone-pr-s3-compatibility.yml"
NON_PASSING = {"fail", "error", "skipped", "not_run"}


class CommandError(RuntimeError):
    """Raised when a recoverable command or artifact operation fails."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch and summarize an Ozone S3 compatibility PR run artifact")
    parser.add_argument("--compat-repo", default=os.environ.get("S3_COMPAT_REPO", DEFAULT_COMPAT_REPO))
    parser.add_argument("--pr-number", default="")
    parser.add_argument("--commit", default="", help="Ozone PR short or full commit SHA used to disambiguate run title")
    parser.add_argument("--run-id", default="", help="GitHub Actions run database id")
    parser.add_argument("--artifact-dir", default="", help="Already downloaded compatibility artifact directory")
    parser.add_argument("--download-dir", default=str(DEFAULT_DOWNLOAD_DIR), help="Where to download artifacts")
    parser.add_argument("--feature", default="", help="Filter failures by feature/name/class/message substring")
    parser.add_argument("--max-cases", type=int, default=30)
    return parser.parse_args()


def run_command(command: list[str]) -> str:
    try:
        completed = subprocess.run(command, check=True, text=True, capture_output=True)
    except FileNotFoundError as exc:
        raise CommandError(f"Missing required command: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip()
        stdout = exc.stdout.strip()
        detail = stderr or stdout or f"exit code {exc.returncode}"
        raise CommandError(f"Command failed: {' '.join(command)}\n{detail}") from exc
    return completed.stdout


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def find_file(root: Path, file_name: str) -> Path | None:
    direct = root / file_name
    if direct.is_file():
        return direct
    matches = sorted(root.rglob(file_name))
    return matches[0] if matches else None


def run_matches(run: dict[str, Any], pr_number: str, commit: str) -> bool:
    title = str(run.get("displayTitle") or "")
    if pr_number and not re.search(rf"\bPR\s*#{re.escape(pr_number)}\b", title):
        return False
    if commit and commit[:12] not in title:
        return False
    return True


def find_run_id(compat_repo: str, pr_number: str, commit: str) -> str:
    output = run_command(
        [
            "gh",
            "run",
            "list",
            "--repo",
            compat_repo,
            "--workflow",
            WORKFLOW_FILE,
            "--json",
            "databaseId,displayTitle,status,conclusion,createdAt,url",
            "--limit",
            "100",
        ]
    )
    runs = json.loads(output)
    for run in runs:
        if run_matches(run, pr_number, commit):
            print(f"Using compatibility run {run['databaseId']}: {run.get('displayTitle', '')}", file=sys.stderr)
            print(str(run.get("url") or ""), file=sys.stderr)
            return str(run["databaseId"])
    hint = f" for PR #{pr_number}" if pr_number else ""
    if commit:
        hint += f" at {commit[:12]}"
    raise CommandError(f"No {WORKFLOW_FILE} run found{hint} in {compat_repo}")


def prepare_download_dir(download_dir: Path) -> Path:
    requested = download_dir.expanduser()
    resolved = requested.resolve()
    protected_paths = {
        Path("/").resolve(),
        Path.cwd().resolve(),
        Path.home().resolve(),
    }
    if resolved in protected_paths:
        raise CommandError(f"Refusing to use dangerous download directory: {requested}")

    if requested.exists():
        if not requested.is_dir():
            raise CommandError(f"Download path exists and is not a directory: {requested}")
        if resolved == DEFAULT_DOWNLOAD_DIR.resolve():
            shutil.rmtree(requested)
        elif any(requested.iterdir()):
            raise CommandError(
                "Refusing to delete non-empty custom download directory: "
                f"{requested}. Use an empty directory or the default {DEFAULT_DOWNLOAD_DIR}."
            )

    requested.mkdir(parents=True, exist_ok=True)
    return requested


def download_artifact(compat_repo: str, run_id: str, pr_number: str, download_dir: Path) -> Path:
    download_dir = prepare_download_dir(download_dir)
    command = ["gh", "run", "download", run_id, "--repo", compat_repo, "--dir", str(download_dir)]
    if pr_number:
        command.extend(["--name", f"ozone-pr-s3-compatibility-{pr_number}"])
    try:
        run_command(command)
    except CommandError:
        if pr_number:
            run_command(["gh", "run", "download", run_id, "--repo", compat_repo, "--dir", str(download_dir)])
        else:
            raise
    return download_dir


def case_key(case: dict[str, Any]) -> str:
    return f"{case.get('classname', '')}::{case.get('name', '')}"


def suite_cases(suite: dict[str, Any]) -> list[dict[str, Any]]:
    cases = suite.get("cases")
    if isinstance(cases, list):
        return cases
    non_passing_cases = suite.get("non_passing_cases")
    if isinstance(non_passing_cases, list):
        return non_passing_cases
    return []


def matches_feature(case: dict[str, Any], feature: str) -> bool:
    if not feature:
        return True
    needle = feature.lower()
    haystack = [
        str(case.get("classname") or ""),
        str(case.get("name") or ""),
        str(case.get("message") or ""),
        str(case.get("detail") or ""),
        " ".join(str(item) for item in case.get("features", []) if item),
    ]
    return any(needle in value.lower() for value in haystack)


def non_passing_cases(run: dict[str, Any], feature: str) -> list[tuple[str, dict[str, Any]]]:
    rows: list[tuple[str, dict[str, Any]]] = []
    for suite_key, suite in sorted((run.get("suites") or {}).items()):
        for case in suite_cases(suite):
            if str(case.get("status") or "") not in NON_PASSING:
                continue
            if matches_feature(case, feature):
                rows.append((suite_key, case))
    return rows


def format_summary_counts(summary: dict[str, Any]) -> str:
    return (
        f"{summary.get('passed', 0)} passed, "
        f"{summary.get('failed', 0)} failed, "
        f"{summary.get('errored', 0)} errored, "
        f"{summary.get('skipped', 0)} skipped"
    )


def render_summary(artifact_dir: Path, feature: str, max_cases: int) -> str:
    run_path = find_file(artifact_dir, "run.json")
    if not run_path:
        raise CommandError(f"Could not find run.json under {artifact_dir}")

    run = load_json(run_path)
    comment_path = find_file(artifact_dir, "pr-comment.md")
    rows = non_passing_cases(run, feature)
    visible_rows = rows[:max_cases]
    hidden_count = max(0, len(rows) - len(visible_rows))
    lines = [
        "# S3 compatibility failure summary",
        "",
        f"Artifact: `{artifact_dir}`",
        f"Run: `{run.get('run_id', 'unknown')}`",
        f"Status: `{run.get('status', 'unknown')}`",
    ]

    workflow_url = run.get("workflow_run_url")
    if workflow_url:
        lines.append(f"Workflow: {workflow_url}")

    ozone = (run.get("sources") or {}).get("ozone") or {}
    lines.extend(
        [
            f"Ozone ref: `{ozone.get('ref', 'unknown')}`",
            f"Ozone commit: `{ozone.get('short_commit', ozone.get('commit', 'unknown'))}`",
            "",
            "## Suite totals",
            "",
        ]
    )

    for suite_key, suite in sorted((run.get("suites") or {}).items()):
        summary = suite.get("summary") or {}
        lines.append(f"- `{suite_key}`: {format_summary_counts(summary)}")

    if comment_path:
        lines.extend(["", f"Comparison comment: `{comment_path}`"])

    label = f" matching `{feature}`" if feature else ""
    lines.extend(["", f"## Non-passing cases{label}", ""])
    if not rows:
        lines.append("No matching non-passing cases found.")
    for suite_key, case in visible_rows:
        features = ", ".join(str(item) for item in case.get("features", []) if item)
        feature_text = f" [{features}]" if features else ""
        message = str(case.get("message") or "").strip()
        message_text = f" - {message}" if message else ""
        lines.append(f"- `{suite_key}` `{case.get('status', 'unknown')}` `{case_key(case)}`{feature_text}{message_text}")
    if hidden_count:
        lines.append(f"- ... {hidden_count} more")

    lines.extend(
        [
            "",
            "## Repair workflow",
            "",
            "1. Open `run.json` and the raw logs for each case above.",
            "2. Map the failing S3 behavior to the Ozone S3 gateway or manager code path.",
            "3. Add or update the smallest Ozone regression test that proves the expected behavior.",
            "4. Implement the Ozone fix and run the targeted test.",
            "5. Re-run `/s3-compat` after local verification.",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> None:
    args = parse_args()
    try:
        if args.artifact_dir:
            artifact_dir = Path(args.artifact_dir)
        else:
            run_id = args.run_id or find_run_id(args.compat_repo, args.pr_number, args.commit)
            artifact_dir = download_artifact(args.compat_repo, run_id, args.pr_number, Path(args.download_dir))

        print(render_summary(artifact_dir, args.feature, args.max_cases), end="")
    except CommandError as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
