from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_pages  # noqa: E402


class IndexPartitionBuildTests(unittest.TestCase):
    def test_partitioned_index_manifest_points_to_parallel_shards(self) -> None:
        payload = {
            "generated_at": "2026-04-02T07:22:59Z",
            "rate_formula": "compatibility_rate = passed / eligible",
            "suite_order": ["s3_tests", "mint"],
            "runs": [{"id": f"run-{index}"} for index in range(5)],
            "charts": {
                "overall": {"s3_tests": [{"run_id": "run-0"}]},
                "features": {
                    "s3_tests": {"bucket": [{"run_id": "run-0"}]},
                    "mint": {"core": [{"run_id": "run-0"}]},
                },
            },
        }

        manifest, shards = build_pages.partition_index_payload(payload, run_chunk_size=2)

        self.assertEqual(2, manifest["schema_version"])
        self.assertTrue(manifest["partitioned"])
        self.assertNotIn("runs", manifest)
        self.assertNotIn("charts", manifest)
        self.assertEqual(
            ["index/runs-000.json", "index/runs-001.json", "index/runs-002.json"],
            manifest["partitions"]["runs"],
        )
        self.assertEqual("index/charts-overall.json", manifest["partitions"]["charts_overall"])
        self.assertEqual(
            {
                "s3_tests": "index/charts-features-s3_tests.json",
                "mint": "index/charts-features-mint.json",
            },
            manifest["partitions"]["charts_features"],
        )
        self.assertEqual([{"id": "run-0"}, {"id": "run-1"}], shards["index/runs-000.json"]["runs"])
        self.assertEqual([{"id": "run-4"}], shards["index/runs-002.json"]["runs"])
        self.assertEqual(payload["charts"]["overall"], shards["index/charts-overall.json"]["overall"])
        self.assertEqual(
            payload["charts"]["features"]["s3_tests"],
            shards["index/charts-features-s3_tests.json"]["features"],
        )


if __name__ == "__main__":
    unittest.main()
