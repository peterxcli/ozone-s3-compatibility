---
name: ozone-s3-compat-failure-fixer
description: Use when working in an Apache Ozone checkout and asked to inspect or fix failures from the ozone-s3-compatibility PR bot, /s3-compat comments, S3 compatibility Actions artifacts, s3-tests failures, Mint failures, or feature-level compatibility regressions.
---

# Ozone S3 Compatibility Failure Fixer

## Purpose

Use this skill from an Ozone checkout after the S3 compatibility bot has run against an Ozone PR. The goal is to turn the bot's comparison artifact into a concrete Ozone fix with evidence.

## First Rule

Do not fix from the comparison summary alone. Always inspect the candidate `run.json`, failing case details, and raw logs before changing Ozone code. The PR comment is a map, not the evidence.

## Quick Start

From the Ozone checkout:

```bash
python /path/to/ozone-s3-compatibility/.agents/skills/ozone-s3-compat-failure-fixer/scripts/fetch_s3_compat_run.py \
  --compat-repo peterxcli/ozone-s3-compatibility \
  --pr-number "$(gh pr view --json number --jq .number)" \
  --commit "$(git rev-parse --short=12 HEAD)" \
  --download-dir /tmp/ozone-s3-compat
```

For an already-downloaded artifact:

```bash
python /path/to/skill/scripts/fetch_s3_compat_run.py \
  --artifact-dir /tmp/ozone-s3-compat \
  --feature bucket
```

## Workflow

1. Confirm you are in the Ozone PR checkout.
   - Run `git status -sb`.
   - Resolve the PR number with `gh pr view --json number,url,headRefOid`.
   - Use `S3_COMPAT_REPO` if the compatibility repo is not `peterxcli/ozone-s3-compatibility`.

2. Fetch the compatibility artifact.
   - Prefer `fetch_s3_compat_run.py --pr-number <n> --commit <short-sha>`.
   - If the run is known, use `--run-id <actions-run-id>`.
   - If the artifact is already downloaded, use `--artifact-dir`.

3. Read the evidence.
   - Start with the script summary.
   - Open `run.json` for exact suite summaries and case metadata.
   - Open `pr-comment.md` for "new", "still", and "no longer" non-passing categories.
   - Inspect raw logs under `raw/s3-tests`, `raw/mint`, and `raw/ozone` when present.

4. Narrow to the requested feature.
   - Match by `features`, test classname/name, and failure message.
   - For `s3-tests`, prefer the fully-qualified pytest case name as the external symptom.
   - For Mint, inspect `target_execution`, `cases`, and `raw/mint/console.log`.

5. Diagnose in Ozone.
   - Search Ozone code for the API path, request header, XML field, error code, or Java exception named by the failing case.
   - Check existing Ozone tests before adding new ones.
   - Add or update the smallest Ozone-side regression test that proves the expected S3 behavior.

6. Fix and verify.
   - Run the targeted Ozone test first.
   - If practical, run the exact failing `s3-tests` selector against a local Ozone cluster.
   - Re-run `/s3-compat` on the PR when the local evidence is good.

## Repair Heuristics

- New non-passing cases are the first priority; still-failing cases are useful context but may predate the PR.
- A PR run stores all `s3-tests` cases, so passing cases can prove that an older baseline failure was resolved.
- Baseline main runs usually store only non-passing `s3-tests` cases; absence from baseline does not always prove the case passed unless the baseline suite contains full `cases`.
- Treat setup errors separately from protocol failures. Bucket cleanup, cluster startup, and credential setup issues may point to test environment state rather than the feature.
- Do not patch `s3-tests` or Mint to hide an Ozone bug. Only adjust test harnesses when the evidence shows the harness is incompatible with the intended Ozone setup.

## Useful Commands

```bash
gh run list --repo "${S3_COMPAT_REPO:-peterxcli/ozone-s3-compatibility}" \
  --workflow ozone-pr-s3-compatibility.yml \
  --json databaseId,displayTitle,status,conclusion,createdAt,url \
  --limit 20
```

```bash
jq '.suites.s3_tests.non_passing_cases[] | {status, classname, name, features, message}' run.json
```

```bash
jq '.suites.s3_tests.cases[] | select(.status != "pass") | {status, classname, name, features, message}' run.json
```

## Output Expectations

When reporting back, include:

- PR number, Ozone commit, and compatibility workflow URL.
- The failing case names and which are new versus baseline.
- The Ozone files and tests inspected.
- The fix made and exact verification commands.
- Any remaining compatibility failures not covered by the fix.
