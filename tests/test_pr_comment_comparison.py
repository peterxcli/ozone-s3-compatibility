from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import normalize_run  # noqa: E402
import compare_runs  # noqa: E402

HELPER_PATH = (
    ROOT
    / ".agents"
    / "skills"
    / "ozone-s3-compat-failure-fixer"
    / "scripts"
    / "fetch_s3_compat_run.py"
)


def load_failure_fixer_helper():
    spec = importlib.util.spec_from_file_location("fetch_s3_compat_run", HELPER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {HELPER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def suite_summary(passed: int, failed: int, errored: int = 0, skipped: int = 0) -> dict[str, int | float]:
    eligible = passed + failed + errored
    return {
        "total": eligible + skipped,
        "passed": passed,
        "failed": failed,
        "errored": errored,
        "skipped": skipped,
        "eligible": eligible,
        "compatibility_rate": round(passed / eligible, 4) if eligible else None,
    }


class S3CaseRetentionTests(unittest.TestCase):
    def test_s3_suite_can_keep_all_cases_for_pr_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source_root = root / "src"
            test_file = source_root / "s3tests" / "functional" / "test_example.py"
            test_file.parent.mkdir(parents=True)
            test_file.write_text(
                textwrap.dedent(
                    """
                    import pytest

                    @pytest.mark.bucket
                    def test_passes():
                        pass

                    @pytest.mark.bucket
                    def test_fails():
                        pass
                    """
                ),
                encoding="utf-8",
            )
            junit_path = root / "junit.xml"
            junit_path.write_text(
                textwrap.dedent(
                    """\
                    <testsuite tests="2" failures="1">
                      <testcase classname="s3tests.functional.test_example" name="test_passes" time="0.1" />
                      <testcase classname="s3tests.functional.test_example" name="test_fails" time="0.2">
                        <failure message="boom">traceback</failure>
                      </testcase>
                    </testsuite>
                    """
                ),
                encoding="utf-8",
            )

            args = argparse.Namespace(
                s3_tests_junit=str(junit_path),
                s3_tests_source=str(source_root),
                s3_tests_exit=1,
                s3_tests_include_all_cases=True,
            )

            suite = normalize_run.normalize_s3_suite(args)

        self.assertEqual("all", suite["included_case_strategy"])
        self.assertEqual(["fail", "pass"], sorted(case["status"] for case in suite["cases"]))
        self.assertEqual(["test_fails"], [case["name"] for case in suite["non_passing_cases"]])

    def test_s3_suite_keeps_non_passing_only_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source_root = root / "src"
            test_file = source_root / "s3tests" / "functional" / "test_example.py"
            test_file.parent.mkdir(parents=True)
            test_file.write_text("def test_passes():\n    pass\n", encoding="utf-8")
            junit_path = root / "junit.xml"
            junit_path.write_text(
                '<testsuite tests="1"><testcase classname="s3tests.functional.test_example" name="test_passes" /></testsuite>',
                encoding="utf-8",
            )

            args = argparse.Namespace(
                s3_tests_junit=str(junit_path),
                s3_tests_source=str(source_root),
                s3_tests_exit=0,
                s3_tests_include_all_cases=False,
            )

            suite = normalize_run.normalize_s3_suite(args)

        self.assertEqual("non_passing_only", suite["included_case_strategy"])
        self.assertNotIn("cases", suite)


class ComparisonMarkdownTests(unittest.TestCase):
    def test_markdown_compares_candidate_against_latest_main_non_passing_cases(self) -> None:
        baseline = {
            "run_id": "main-2026-05-01",
            "started_at": "2026-05-01T02:15:00Z",
            "finished_at": "2026-05-01T03:15:00Z",
            "status": "completed",
            "sources": {"ozone": {"short_commit": "mainabc123456", "ref": "master"}},
            "suites": {
                "s3_tests": {
                    "label": "s3-tests",
                    "summary": suite_summary(passed=2, failed=2),
                    "included_case_strategy": "non_passing_only",
                    "non_passing_cases": [
                        {
                            "classname": "s3tests.functional.test_bucket",
                            "name": "test_old_failure",
                            "status": "fail",
                            "message": "old failure",
                        },
                        {
                            "classname": "s3tests.functional.test_bucket",
                            "name": "test_still_failure",
                            "status": "fail",
                            "message": "still failing",
                        },
                    ],
                }
            },
        }
        candidate = {
            "run_id": "pr-123",
            "started_at": "2026-05-02T04:00:00Z",
            "finished_at": "2026-05-02T05:00:00Z",
            "status": "completed",
            "workflow_run_url": "https://github.com/example/actions/runs/99",
            "sources": {"ozone": {"short_commit": "prabc1234567", "ref": "feature-branch"}},
            "suites": {
                "s3_tests": {
                    "label": "s3-tests",
                    "summary": suite_summary(passed=2, failed=2),
                    "included_case_strategy": "all",
                    "cases": [
                        {
                            "classname": "s3tests.functional.test_bucket",
                            "name": "test_old_failure",
                            "status": "pass",
                            "message": "",
                        },
                        {
                            "classname": "s3tests.functional.test_bucket",
                            "name": "test_new_failure",
                            "status": "fail",
                            "message": "new failure",
                        },
                        {
                            "classname": "s3tests.functional.test_bucket",
                            "name": "test_still_failure",
                            "status": "fail",
                            "message": "still failing",
                        },
                        {
                            "classname": "s3tests.functional.test_bucket",
                            "name": "test_ok",
                            "status": "pass",
                            "message": "",
                        },
                    ],
                    "non_passing_cases": [
                        {
                            "classname": "s3tests.functional.test_bucket",
                            "name": "test_new_failure",
                            "status": "fail",
                            "message": "new failure",
                        },
                        {
                            "classname": "s3tests.functional.test_bucket",
                            "name": "test_still_failure",
                            "status": "fail",
                            "message": "still failing",
                        },
                    ],
                }
            },
        }

        markdown = compare_runs.render_comparison_markdown(
            candidate,
            baseline,
            pr_url="https://github.com/apache/ozone/pull/123",
            trigger_comment_url="https://github.com/apache/ozone/pull/123#issuecomment-1",
            max_cases=10,
        )

        self.assertIn("Apache Ozone S3 compatibility result", markdown)
        self.assertIn("test_new_failure", markdown)
        self.assertIn("New non-passing cases", markdown)
        self.assertIn("test_old_failure", markdown)
        self.assertIn("No longer non-passing", markdown)
        self.assertIn("test_still_failure", markdown)
        self.assertIn("Still non-passing", markdown)
        self.assertIn("latest published main run", markdown)


class WorkflowDisplayTests(unittest.TestCase):
    def test_pr_workflow_run_name_uses_pr_and_upstream_commits(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ozone-pr-s3-compatibility.yml").read_text(encoding="utf-8")

        self.assertIn("run-name: PR Run Comparison for", workflow)
        self.assertIn("github.event.client_payload.ozone_owner || inputs.ozone_owner || 'apache'", workflow)
        self.assertIn("github.event.client_payload.ozone_repo_name || inputs.ozone_repo_name || 'ozone'", workflow)
        self.assertIn("github.event.client_payload.pr_number", workflow)
        self.assertIn("github.event.client_payload.head_sha_short", workflow)
        self.assertIn("inputs.ozone_head_sha_short", workflow)
        self.assertIn("against apache/ozone master at", workflow)
        self.assertIn("github.event.client_payload.upstream_sha_short", workflow)
        self.assertIn("inputs.ozone_upstream_sha_short", workflow)

    def test_pr_comment_forwarder_sends_eight_character_title_shas(self) -> None:
        docs = (ROOT / "docs" / "ozone-pr-comment-bot.md").read_text(encoding="utf-8")

        self.assertIn('"upstream_sha_short": "1234abcd"', docs)
        self.assertIn("github.rest.repos.getBranch", docs)
        self.assertIn("branch: 'master'", docs)
        self.assertIn("head_sha_short: pull.head.sha.slice(0, 8)", docs)
        self.assertIn("upstream_sha_short: upstream.commit.sha.slice(0, 8)", docs)

    def test_pr_workflow_writes_comparison_to_action_summary(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ozone-pr-s3-compatibility.yml").read_text(encoding="utf-8")

        self.assertIn("Publish comparison summary", workflow)
        self.assertIn("GITHUB_STEP_SUMMARY", workflow)
        self.assertIn("cat out/pr-run/pr-comment.md", workflow)

    def test_pr_workflow_post_comment_uses_configured_github_token(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ozone-pr-s3-compatibility.yml").read_text(encoding="utf-8")
        script = (ROOT / "scripts" / "post_pr_comment.sh").read_text(encoding="utf-8")

        self.assertIn("OZONE_PR_COMMENT_TOKEN: ${{ secrets.OZONE_PR_COMMENT_TOKEN }}", workflow)
        self.assertIn("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN || github.token }}", workflow)
        self.assertIn("issues: write", workflow)
        self.assertIn("bash scripts/post_pr_comment.sh", workflow)
        self.assertIn('target_repo="${OZONE_OWNER}/${OZONE_REPO_NAME}"', script)
        self.assertIn('[ "${target_repo}" = "${current_repo}" ]', script)
        self.assertIn('export GH_TOKEN="${comment_token}"', script)

    def test_pr_workflow_posts_collapsible_comment_body(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ozone-pr-s3-compatibility.yml").read_text(encoding="utf-8")
        script = (ROOT / "scripts" / "post_pr_comment.sh").read_text(encoding="utf-8")

        self.assertIn("bash scripts/post_pr_comment.sh", workflow)
        self.assertIn("out/pr-run/comment-body.md", script)
        self.assertIn("<details>", script)
        self.assertIn("<summary>Apache Ozone S3 compatibility result</summary>", script)
        self.assertIn("sed '/^<!-- ozone-s3-compatibility-bot -->$/d'", script)
        self.assertIn("--rawfile body", script)


class PrCommentPostingScriptTests(unittest.TestCase):
    def run_comment_script(
        self,
        env: dict[str, str],
        gh_exit: int = 0,
    ) -> tuple[subprocess.CompletedProcess[str], str | None, str | None, bool]:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            gh_log = root / "gh.log"
            fake_gh = bin_dir / "gh"
            fake_gh.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    set -euo pipefail
                    {{
                      echo "GH_TOKEN=${{GH_TOKEN:-}}"
                      printf 'ARGS=%s\\n' "$*"
                    }} > "{gh_log}"
                    exit {gh_exit}
                    """
                ),
                encoding="utf-8",
            )
            fake_gh.chmod(0o755)

            comment_path = root / "pr-comment.md"
            body_path = root / "comment-body.md"
            payload_path = root / "comment-payload.json"
            comment_path.write_text(
                "<!-- ozone-s3-compatibility-bot -->\n## Apache Ozone S3 compatibility result\n\nBody\n",
                encoding="utf-8",
            )

            script_env = {
                **env,
                "PATH": f"{bin_dir}:{env.get('PATH', os.environ.get('PATH', ''))}",
                "PR_COMMENT_MARKDOWN": str(comment_path),
                "COMMENT_BODY_PATH": str(body_path),
                "COMMENT_PAYLOAD_PATH": str(payload_path),
            }
            result = subprocess.run(
                [str(ROOT / "scripts" / "post_pr_comment.sh")],
                cwd=ROOT,
                env=script_env,
                text=True,
                capture_output=True,
                check=False,
            )

            gh_output = gh_log.read_text(encoding="utf-8") if gh_log.exists() else None
            body = body_path.read_text(encoding="utf-8") if body_path.exists() else None
            return result, gh_output, body, payload_path.exists()

    def test_cross_repo_comment_requires_ozone_comment_token(self) -> None:
        result, gh_output, _body, _payload_exists = self.run_comment_script(
            {
                "POST_COMMENT_INPUT": "true",
                "OZONE_OWNER": "apache",
                "OZONE_REPO_NAME": "ozone",
                "OZONE_PR_NUMBER": "10265",
                "GITHUB_REPOSITORY": "peterxcli/ozone-s3-compatibility",
                "GITHUB_TOKEN": "current-repo-token",
            }
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIsNone(gh_output)
        self.assertIn("Missing OZONE_PR_COMMENT_TOKEN", result.stdout)

    def test_same_repo_comment_can_use_github_token(self) -> None:
        result, gh_output, body, payload_exists = self.run_comment_script(
            {
                "POST_COMMENT_INPUT": "true",
                "OZONE_OWNER": "peterxcli",
                "OZONE_REPO_NAME": "ozone-s3-compatibility",
                "OZONE_PR_NUMBER": "7",
                "GITHUB_REPOSITORY": "peterxcli/ozone-s3-compatibility",
                "GITHUB_TOKEN": "current-repo-token",
            }
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIsNotNone(gh_output)
        self.assertIn("GH_TOKEN=current-repo-token", gh_output)
        self.assertIn("repos/peterxcli/ozone-s3-compatibility/issues/7/comments", gh_output)
        self.assertIsNotNone(body)
        self.assertIn("<details>", body)
        self.assertIn("<summary>Apache Ozone S3 compatibility result</summary>", body)
        self.assertEqual(1, body.count("<!-- ozone-s3-compatibility-bot -->"))
        self.assertTrue(payload_exists)

    def test_cross_repo_comment_uses_ozone_comment_token(self) -> None:
        result, gh_output, _body, _payload_exists = self.run_comment_script(
            {
                "POST_COMMENT_INPUT": "true",
                "OZONE_OWNER": "apache",
                "OZONE_REPO_NAME": "ozone",
                "OZONE_PR_NUMBER": "10265",
                "GITHUB_REPOSITORY": "peterxcli/ozone-s3-compatibility",
                "GITHUB_TOKEN": "current-repo-token",
                "OZONE_PR_COMMENT_TOKEN": "ozone-comment-token",
            }
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIsNotNone(gh_output)
        self.assertIn("GH_TOKEN=ozone-comment-token", gh_output)
        self.assertIn("repos/apache/ozone/issues/10265/comments", gh_output)

    def test_comment_api_failure_does_not_fail_workflow(self) -> None:
        result, gh_output, _body, _payload_exists = self.run_comment_script(
            {
                "POST_COMMENT_INPUT": "true",
                "OZONE_OWNER": "apache",
                "OZONE_REPO_NAME": "ozone",
                "OZONE_PR_NUMBER": "10265",
                "GITHUB_REPOSITORY": "peterxcli/ozone-s3-compatibility",
                "OZONE_PR_COMMENT_TOKEN": "ozone-comment-token",
            },
            gh_exit=1,
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIsNotNone(gh_output)
        self.assertIn("Failed to post PR comment", result.stdout)


class OzoneFailureFixerSkillTests(unittest.TestCase):
    def test_skill_document_has_actionable_ozone_failure_workflow(self) -> None:
        skill_path = ROOT / ".agents" / "skills" / "ozone-s3-compat-failure-fixer" / "SKILL.md"
        skill = skill_path.read_text(encoding="utf-8")

        self.assertNotIn("TODO", skill)
        self.assertIn("Use when", skill)
        self.assertIn("fetch_s3_compat_run.py", skill)
        self.assertIn("Ozone checkout", skill)
        self.assertIn("Do not fix from the comparison summary alone", skill)

    def test_helper_script_summarizes_feature_failures_from_artifact_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            artifact_dir = Path(tmp_dir)
            (artifact_dir / "pr-comment.md").write_text(
                "## Apache Ozone S3 compatibility result\n\n**New non-passing cases**\n",
                encoding="utf-8",
            )
            (artifact_dir / "run.json").write_text(
                json.dumps(
                    {
                        "run_id": "pr-42-abcdef123456",
                        "status": "completed",
                        "workflow_run_url": "https://github.com/example/actions/runs/42",
                        "sources": {"ozone": {"ref": "feature/s3", "short_commit": "abcdef123456"}},
                        "suites": {
                            "s3_tests": {
                                "label": "s3-tests",
                                "summary": suite_summary(passed=1, failed=1),
                                "cases": [
                                    {
                                        "classname": "s3tests.functional.test_bucket",
                                        "name": "test_bucket_list_v2",
                                        "features": ["bucket"],
                                        "status": "fail",
                                        "message": "expected CommonPrefixes",
                                        "detail": "traceback",
                                    },
                                    {
                                        "classname": "s3tests.functional.test_object",
                                        "name": "test_object_get",
                                        "features": ["object"],
                                        "status": "pass",
                                        "message": "",
                                    },
                                ],
                                "non_passing_cases": [
                                    {
                                        "classname": "s3tests.functional.test_bucket",
                                        "name": "test_bucket_list_v2",
                                        "features": ["bucket"],
                                        "status": "fail",
                                        "message": "expected CommonPrefixes",
                                        "detail": "traceback",
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(HELPER_PATH),
                    "--artifact-dir",
                    str(artifact_dir),
                    "--feature",
                    "bucket",
                ],
                check=False,
                text=True,
                capture_output=True,
            )

        self.assertEqual("", result.stderr)
        self.assertEqual(0, result.returncode)
        self.assertIn("test_bucket_list_v2", result.stdout)
        self.assertIn("expected CommonPrefixes", result.stdout)
        self.assertIn("Repair workflow", result.stdout)

    def test_helper_uses_exact_pr_number_matching(self) -> None:
        helper = load_failure_fixer_helper()

        self.assertFalse(helper.run_matches({"displayTitle": "Ozone PR #10 @ abcdef123456"}, "1", ""))
        self.assertTrue(helper.run_matches({"displayTitle": "Ozone PR #1 @ abcdef123456"}, "1", ""))

    def test_helper_refuses_to_delete_non_empty_custom_download_directory(self) -> None:
        helper = load_failure_fixer_helper()
        with tempfile.TemporaryDirectory() as tmp_dir:
            download_dir = Path(tmp_dir)
            marker = download_dir / "keep.txt"
            marker.write_text("do not delete", encoding="utf-8")

            with self.assertRaises(helper.CommandError):
                helper.download_artifact("owner/repo", "123", "9", download_dir)

            self.assertTrue(marker.exists())

    def test_download_artifact_retries_with_custom_exception(self) -> None:
        helper = load_failure_fixer_helper()
        with tempfile.TemporaryDirectory() as tmp_dir:
            download_dir = Path(tmp_dir) / "empty"
            download_dir.mkdir()
            calls: list[list[str]] = []

            def fake_run_command(command: list[str]) -> str:
                calls.append(command)
                if "--name" in command:
                    raise helper.CommandError("artifact not found")
                return ""

            with mock.patch.object(helper, "run_command", side_effect=fake_run_command):
                helper.download_artifact("owner/repo", "123", "9", download_dir)

        self.assertEqual(2, len(calls))
        self.assertIn("--name", calls[0])
        self.assertNotIn("--name", calls[1])


if __name__ == "__main__":
    unittest.main()
