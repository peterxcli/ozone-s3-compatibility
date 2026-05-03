from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import normalize_run  # noqa: E402
import compare_runs  # noqa: E402


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
    def test_pr_workflow_run_name_uses_pr_number_and_dispatch_commit(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ozone-pr-s3-compatibility.yml").read_text(encoding="utf-8")

        self.assertIn("run-name:", workflow)
        self.assertIn("github.event.client_payload.pr_number", workflow)
        self.assertIn("github.event.client_payload.head_sha_short", workflow)
        self.assertIn("inputs.ozone_head_sha_short", workflow)

    def test_pr_workflow_writes_comparison_to_action_summary(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ozone-pr-s3-compatibility.yml").read_text(encoding="utf-8")

        self.assertIn("Publish comparison summary", workflow)
        self.assertIn("GITHUB_STEP_SUMMARY", workflow)
        self.assertIn("cat out/pr-run/pr-comment.md", workflow)


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
                    str(
                        ROOT
                        / ".agents"
                        / "skills"
                        / "ozone-s3-compat-failure-fixer"
                        / "scripts"
                        / "fetch_s3_compat_run.py"
                    ),
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


if __name__ == "__main__":
    unittest.main()
