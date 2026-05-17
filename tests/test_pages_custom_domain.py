from __future__ import annotations

import unittest
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CUSTOM_DOMAIN = "ozone.s3.peterxcli.dev"


class PagesCustomDomainTests(unittest.TestCase):
    def test_vite_public_assets_include_pages_cname(self) -> None:
        cname_path = ROOT / "site" / "public" / "CNAME"

        self.assertTrue(cname_path.exists(), "site/public/CNAME must be published with the built Pages assets")
        self.assertEqual(CUSTOM_DOMAIN, cname_path.read_text(encoding="utf-8").strip())

    def test_refresh_pages_ui_stages_cname_when_present(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "refresh-pages-ui.yml").read_text(encoding="utf-8")

        self.assertIn('cp "${source_dir}/CNAME" .pages-repo/CNAME', workflow)
        self.assertIn("git -C .pages-repo add CNAME", workflow)

    def test_refresh_pages_ui_stages_generated_parquet_data(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "refresh-pages-ui.yml").read_text(encoding="utf-8")

        self.assertIn('cp -R "${source_dir}/data/catalog" .pages-repo/data/catalog', workflow)
        self.assertIn('cp -R "${source_dir}/data/runs/." .pages-repo/data/runs', workflow)
        self.assertIn("git -C .pages-repo add data/catalog", workflow)
        self.assertIn("git -C .pages-repo add data/runs", workflow)
        self.assertIn("rm -f .pages-repo/data/index.json .pages-repo/data/search-index.json", workflow)
        self.assertNotIn('cp "${source_dir}/data/search-index.json"', workflow)
        self.assertNotIn("git -C .pages-repo add data/search-index.json", workflow)
        self.assertNotIn("rm -rf .pages-repo/data/runs", workflow)

    def test_pages_workflows_publish_parquet_data_by_default(self) -> None:
        nightly = (ROOT / ".github" / "workflows" / "nightly.yml").read_text(encoding="utf-8")
        refresh = (ROOT / ".github" / "workflows" / "refresh-pages-ui.yml").read_text(encoding="utf-8")

        self.assertIn("VITE_REPORT_DATA_FORMAT=parquet npm --prefix site run build", nightly)
        self.assertIn("--data-format parquet", nightly)
        self.assertIn("VITE_REPORT_DATA_FORMAT=parquet npm --prefix site run build", refresh)
        self.assertIn("--data-format parquet", refresh)

    def test_generated_run_directory_is_ignored(self) -> None:
        gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")

        self.assertIn("run/", gitignore)

    def test_workflows_install_pyarrow_for_parquet_output(self) -> None:
        workflow_paths = [
            ROOT / ".github" / "workflows" / "nightly.yml",
            ROOT / ".github" / "workflows" / "refresh-pages-ui.yml",
            ROOT / ".github" / "workflows" / "ozone-pr-s3-compatibility.yml",
        ]

        for path in workflow_paths:
            with self.subTest(path=path.name):
                workflow = path.read_text(encoding="utf-8")
                self.assertIn("uses: astral-sh/setup-uv@", workflow)
                self.assertIn("uv sync --locked", workflow)
                self.assertNotIn("python3 -m pip install pyarrow", workflow)

    def test_pyarrow_is_managed_by_uv_project_metadata(self) -> None:
        pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

        self.assertEqual(">=3.11", pyproject["project"]["requires-python"])
        self.assertIn("pyarrow>=24.0.0", pyproject["project"]["dependencies"])
        self.assertFalse(pyproject["tool"]["uv"]["package"])


if __name__ == "__main__":
    unittest.main()
