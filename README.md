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

## Flow

Each nightly run does this:

1. Clone Ozone and reset to the requested ref, default `master`
2. Build the Ozone dist package
3. Start the packaged compose cluster from the built artifact
4. Clone and run `s3-tests`
5. Clone `mint`, build the required SDK/tool image payload, then run it against the same cluster
6. Normalize both outputs into one run JSON
7. Merge the new run into historical data and rebuild the static site
8. Force-push the rebuilt site and run data to `gh-pages`

## Repo Layout

- `.github/workflows/nightly.yml`: scheduled workflow and manual/`act` entrypoint
- `.github/workflows/refresh-pages-ui.yml`: manual workflow that updates only `index.html`, `app.js`, `styles.css`, and `.nojekyll` on `gh-pages`
- [`scripts/run-nightly.sh`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/scripts/run-nightly.sh): orchestration for clone/build/start/run
- [`scripts/normalize_run.py`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/scripts/normalize_run.py): converts raw outputs into a report-friendly JSON model
- [`scripts/build_pages.py`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/scripts/build_pages.py): rebuilds the static Pages site from historical run JSON files
- [`site/index.html`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/site/index.html), [`site/app.js`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/site/app.js), [`site/styles.css`](/Users/lixucheng/Documents/small-project/ozone-s3-compatibility/site/styles.css): GitHub Pages frontend

## GitHub Setup

1. Create the repo.
2. Push `main`.
3. In GitHub Pages settings, set the source to the `gh-pages` branch root.
4. Leave the workflow permissions at the repository default, or allow `contents: write`.

The workflow handles branch creation itself if `gh-pages` does not exist yet.
If you only want to publish frontend changes from `site/` without rebuilding run history, trigger `refresh-pages-ui`. It updates the published UI files on `gh-pages` and leaves `data/` untouched.

## Publish Paths

- `nightly.yml`: runs Ozone, `s3-tests`, and Mint, normalizes a new run, rebuilds the full Pages output, and publishes both UI and `data/` to `gh-pages`
- `refresh-pages-ui.yml`: copies only `site/index.html`, `site/app.js`, `site/styles.css`, and `.nojekyll` to `gh-pages`; existing published `data/` stays unchanged

## Local Run

You can run the orchestration script directly. Override the repo URLs when you want to use local clones.

```bash
export OZONE_REPO=/Users/lixucheng/Documents/oss/apache/ozone
export S3_TESTS_REPO=/tmp/ozone-compat-src/s3-tests
export MINT_REPO=/tmp/ozone-compat-src/mint
export S3_TESTS_ARGS='s3tests/functional/test_s3.py::test_bucket_list_empty'
export MINT_TARGETS='healthcheck awscli'
export OUTPUT_ROOT="$PWD/out/run"

bash scripts/run-nightly.sh
python3 scripts/build_pages.py --output-dir out/pages --new-run out/run/run.json
```

Open `out/pages/index.html` in a local web server after that.

Set `S3_TESTS_MARK_EXPR=''` if you need to disable the default AWS marker filter for a one-off run.

## Using `act`

The workflow exposes `workflow_dispatch` inputs specifically so `nektos/act` can run a smaller smoke job locally.

Recommended first pass:

```bash
./scripts/build-act-runner.sh

act workflow_dispatch \
  -W .github/workflows/nightly.yml \
  -e .github/act/nightly-event.json \
  --secret GITHUB_TOKEN="$(gh auth token)"
```

Notes:

- `.actrc` maps `ubuntu-latest` and `ubuntu-24.04` to a local runner image with Docker, Java, Python, Maven, and rsync ready to go.
- `./scripts/build-act-runner.sh` builds the local `ozone-s3-compatibility/act-runner:latest` image used by `.actrc`.
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
