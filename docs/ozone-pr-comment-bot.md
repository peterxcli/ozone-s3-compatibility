# Ozone PR Comment Bot

This repo can run a one-off S3 compatibility check for an Apache Ozone pull request and post a comparison comment back to that PR.

## Trigger Command

Comment on an Ozone PR with:

```text
/s3-compat
```

The comment listener should dispatch `ozone-pr-s3-compatibility` to this repository. The compatibility run tests the Ozone PR head branch, compares the result with the latest published main run from `gh-pages/data/runs`, and writes the PR run only to the Actions artifact. It does not publish the PR run into the GitHub Pages run history.

## Required Secrets

In this repository:

- `OZONE_PR_COMMENT_TOKEN`: token that can create issue comments on the Ozone repository.

In the Ozone repository or GitHub App that receives PR comments:

- `S3_COMPAT_DISPATCH_TOKEN`: token that can call `repository_dispatch` on this repository.

## Dispatch Payload

Send this repository a `repository_dispatch` event:

```json
{
  "event_type": "ozone-pr-s3-compatibility",
  "client_payload": {
    "ozone_owner": "apache",
    "ozone_repo_name": "ozone",
    "pr_number": "12345",
    "head_sha_short": "abcdef123456",
    "comment_url": "https://github.com/apache/ozone/pull/12345#issuecomment-1",
    "comment_id": "1234567890",
    "requested_by": "github-user",
    "s3_tests_args": "s3tests/functional",
    "mint_mode": "core",
    "mint_targets": "",
    "ozone_datanodes": "1",
    "post_comment": true
  }
}
```

Only `pr_number` is required. The rest of the fields default to the normal nightly inputs.

## Example Ozone-Side Forwarder

This workflow belongs in the repository that receives Ozone PR comments, or can be translated into a GitHub App webhook handler. Replace `peterxcli/ozone-s3-compatibility` if this repo lives elsewhere.

```yaml
name: dispatch-s3-compatibility

on:
  issue_comment:
    types:
      - created

permissions:
  contents: read

jobs:
  dispatch:
    if: ${{ github.event.issue.pull_request && contains(github.event.comment.body, '/s3-compat') }}
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch compatibility run
        uses: actions/github-script@v8
        with:
          github-token: ${{ secrets.S3_COMPAT_DISPATCH_TOKEN }}
          script: |
            const { data: pull } = await github.rest.pulls.get({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.issue.number
            });

            await github.rest.repos.createDispatchEvent({
              owner: 'peterxcli',
              repo: 'ozone-s3-compatibility',
              event_type: 'ozone-pr-s3-compatibility',
              client_payload: {
                ozone_owner: context.repo.owner,
                ozone_repo_name: context.repo.repo,
                pr_number: String(context.issue.number),
                head_sha: pull.head.sha,
                head_sha_short: pull.head.sha.slice(0, 12),
                head_ref: pull.head.ref,
                comment_url: context.payload.comment.html_url,
                comment_id: String(context.payload.comment.id),
                requested_by: context.payload.comment.user.login,
                s3_tests_args: 's3tests/functional',
                mint_mode: 'core',
                mint_targets: '',
                ozone_datanodes: '1',
                post_comment: true
              }
            });
```

## Manual Run

Use the `ozone-pr-s3-compatibility` workflow dispatch form and provide the Ozone PR number. Manual runs use the same comparison and artifact behavior, and can skip posting by setting `post_comment` to `false`.

## Agent-Assisted Fixing

This repo includes an agent skill at:

```text
.agents/skills/ozone-s3-compat-failure-fixer
```

Use it from an Ozone checkout when you want the agent to inspect the compatibility artifact and guide or implement a fix for a failing S3 feature. If your agent does not auto-discover repo-carried skills, copy or symlink that folder into your global skills directory, for example `~/.agents/skills/`.

Typical prompt from the Ozone PR checkout:

```text
Use ozone-s3-compat-failure-fixer to inspect the latest /s3-compat result for this PR, focus on the bucket listing failures, and fix the Ozone code.
```

The skill's helper script can also be run directly:

```bash
python /path/to/ozone-s3-compatibility/.agents/skills/ozone-s3-compat-failure-fixer/scripts/fetch_s3_compat_run.py \
  --pr-number "$(gh pr view --json number --jq .number)" \
  --commit "$(git rev-parse --short=12 HEAD)" \
  --feature bucket \
  --download-dir /tmp/ozone-s3-compat
```
