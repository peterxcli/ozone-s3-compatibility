from __future__ import annotations

import unittest
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


if __name__ == "__main__":
    unittest.main()
