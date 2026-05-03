# Ozone S3 Compatibility Nightly

This repo builds Apache Ozone from source on GitHub Actions, starts the packaged compose cluster, runs `ceph/s3-tests` and `minio/mint`, and publishes a historical compatibility report to GitHub Pages. The default `s3-tests` run excludes cases marked `fails_on_aws`, because the target is AWS S3 compatibility rather than RGW-specific behavior.

The report keeps:

- Daily suite-level compatibility trends for `s3-tests` and `mint`
- Feature-level trend charts at the top of the page
- Sticky top navigation for Latest Run, Topline Trends, and Archived Runs
- The latest run shown as a full report
- Every archived run shown inline with its suite details
- A GitHub repo link in the published header
- Run-scope labels so smoke or subset publishes are distinguishable from full nightlies
- Comment-triggered Ozone PR checks that compare a PR run with the latest published main run without adding the PR run to Pages history

## Flow

Each nightly run does this:

1. Clone Ozone and reset to the requested ref, default `master`
2. Build the Ozone dist package
3. Start the packaged compose cluster from the built artifact
4. Stage `s3-tests` from the pinned repo submodule into `.work`, patch it, then run it
5. Stage `mint` from the pinned repo submodule into `.work`, patch it, build the required SDK/tool image payload, then run it against the same cluster
6. Normalize both outputs into one run JSON
7. Merge the new run into historical data and rebuild the static site
8. Force-push the rebuilt site and run data to `gh-pages`

The PR comment flow is separate. A comment listener on the Ozone PR sends `repository_dispatch` to this repo, `.github/workflows/ozone-pr-s3-compatibility.yml` runs against the PR head branch, compares `out/pr-run/run.json` with the latest published main run under `gh-pages/data/runs`, and posts the markdown comparison back to the PR. The Actions run title includes the PR number and dispatched short commit when the comment forwarder sends it, and the comparison is also written to the run summary. It uploads the PR run as an Actions artifact only; it does not write the PR run to `gh-pages/data/runs`.

## Repo Layout

- `.github/workflows/nightly.yml`: scheduled workflow and manual/`act` entrypoint
- `.github/workflows/ozone-pr-s3-compatibility.yml`: repository-dispatch/manual workflow for Ozone PR comment-triggered checks
- `.github/workflows/refresh-pages-ui.yml`: manual workflow that builds the Vue frontend and updates only the published UI assets on `gh-pages`
- `.agents/skills/ozone-s3-compat-failure-fixer`: repo-carried agent skill for inspecting PR compatibility artifacts from an Ozone checkout
- [`scripts/run-nightly.sh`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/scripts/run-nightly.sh): orchestration for clone/build/start/run
- [`scripts/normalize_run.py`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/scripts/normalize_run.py): converts raw outputs into a report-friendly JSON model
- [`scripts/build_pages.py`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/scripts/build_pages.py): rebuilds the static Pages site from historical run JSON files
- [`scripts/compare_runs.py`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/scripts/compare_runs.py): writes the Ozone PR comparison markdown against the latest published main run
- [`site/src/App.vue`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/site/src/App.vue) and [`site/src/components`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/site/src/components): Vue 3 frontend source
- [`site/vite.config.js`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/site/vite.config.js) and [`site/package.json`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/site/package.json): frontend build config

## GitHub Setup

1. Create the repo.
2. Push `main`.
3. In GitHub Pages settings, set the source to the `gh-pages` branch root.
4. Leave the workflow permissions at the repository default, or allow `contents: write`.
5. For Ozone PR comment posting, add `OZONE_PR_COMMENT_TOKEN` with permission to create comments on the Ozone repository.

The workflow handles branch creation itself if `gh-pages` does not exist yet.
If you only want to publish frontend changes without rebuilding run history, trigger `refresh-pages-ui`. It builds the Vue app, updates the published UI files on `gh-pages`, and leaves `data/` untouched.
For `/s3-compat` comments on Ozone PRs, install a comment forwarder in the Ozone repository or a GitHub App that sends `repository_dispatch` to this repo. See [`docs/ozone-pr-comment-bot.md`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/docs/ozone-pr-comment-bot.md).
For agent-assisted fixing from an Ozone checkout, install or reference the bundled `ozone-s3-compat-failure-fixer` skill and use it to download the PR artifact, summarize failing cases, inspect raw logs, and guide the Ozone-side fix.

## Publish Paths

- `nightly.yml`: runs Ozone, `s3-tests`, and Mint, normalizes a new run, rebuilds the full Pages output, and publishes both UI and `data/` to `gh-pages`
- `ozone-pr-s3-compatibility.yml`: runs Ozone PR branches on demand, compares with the latest published main run, comments on the Ozone PR, and uploads artifacts without publishing `data/`
- `refresh-pages-ui.yml`: refreshes the published UI while keeping existing `data/` intact, and regenerates `social-preview.svg` from the latest published run so the OG image stays current

## Local Run

Initialize the suite submodules first:

```bash
git submodule update --init --recursive
```

You can then run the orchestration script directly against the pinned submodules.

```bash
export OZONE_REPO=/Users/lixucheng/Documents/oss/apache/ozone
export S3_TESTS_ARGS='s3tests/functional/test_s3.py::test_bucket_list_empty'
export MINT_TARGETS='healthcheck awscli'
export OUTPUT_ROOT="$PWD/out/run"

bash scripts/run-nightly.sh
npm --prefix site ci
npm --prefix site run build
python3 scripts/build_pages.py --output-dir out/pages --new-run out/run/run.json
```

If you want to stage from different local clones instead of the pinned submodules, set these overrides before `bash scripts/run-nightly.sh`:

```bash
export S3_TESTS_SOURCE=/tmp/ozone-compat-src/s3-tests
export MINT_SOURCE=/tmp/ozone-compat-src/mint
```

Open `out/pages/index.html` in a local web server after that.

Set `S3_TESTS_MARK_EXPR=''` if you need to disable the default AWS marker filter for a one-off run.

## Using `act`

The workflow exposes `workflow_dispatch` inputs specifically so `nektos/act` can run a smaller smoke job locally.

Recommended first pass:

```bash
git submodule update --init --recursive

./scripts/build-act-runner.sh

act workflow_dispatch \
  -W .github/workflows/nightly.yml \
  -e .github/act/nightly-event.json \
  --secret GITHUB_TOKEN="$(gh auth token)"
```

Notes:

- `.actrc` maps `ubuntu-latest` and `ubuntu-24.04` to a local runner image with Docker, Java, Python, Maven, and rsync ready to go.
- `./scripts/build-act-runner.sh` builds the local `ozone-s3-compatibility/act-runner:latest` image used by `.actrc`.
- `actions/checkout` now initializes the `s3-tests` and `mint` submodules before the nightly job stages patched copies into `.work`.
- The full nightly path is heavy. Start with a narrow `s3-tests` selector and a small `mint_targets` list.
- When `mint_targets` is set, the local Mint image build now installs only those selected SDK/tool targets by default.
- Publishing is disabled in the sample `act` event file. Turn on `publish_pages` only when you actually want to push `gh-pages`.
- Set `ACT_RUNNER_PLATFORM` before building if you need to force a non-default Docker platform for the local runner image.

If you want to override the build-time subset independently of the runtime Mint selection, set `MINT_BUILD_TARGETS`. Leaving it unset makes the build follow `MINT_TARGETS`; setting it to an empty string forces the full Mint image build.

## Compatibility Rate

The site uses:

`compatibility_rate = passed / (passed + failed + errored)`

Skipped and `NA` results are tracked separately and excluded from the rate.

## Current Tradeoffs

- `s3-tests` history stores non-passing case detail instead of every passing case. That keeps the archive small enough for long-term Pages history while still keeping feature summaries for every run.
- `mint` stores full case detail because its output is compact.
- The default workflow uses one datanode to keep GitHub-hosted runners practical. If you want multi-node coverage, raise `ozone_datanodes` in `workflow_dispatch` or the workflow env.
