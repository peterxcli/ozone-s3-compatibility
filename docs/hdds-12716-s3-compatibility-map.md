# HDDS-12716 S3 Compatibility Gap Map

This snapshot maps the latest published `ozone-s3-compatibility` failures to the
HDDS-12716 Ozone S3 gateway phase 4 Jira tree.

## Source Snapshot

- Compatibility report: <https://peterxcli.github.io/ozone-s3-compatibility/>
- Published run data: <https://github.com/peterxcli/ozone-s3-compatibility/tree/gh-pages/data/runs>
- Run inspected: `2026-05-02T05-19-40Z`
- Report generated at: `2026-05-02T06:27:16Z`
- Ozone commit: `9e89ee799e1a3d72b75bacac48d787f396eb9dd4`
- ceph/s3-tests commit: `fb8b73092bb1dd8db829f1205a9e52e73bf9a232`
- minio/mint commit: `12559d50625b722d11fd798ae8ac2fb204e66dd1`
- Jira umbrella: <https://issues.apache.org/jira/browse/HDDS-12716>

Latest run summary:

| Suite | Eligible | Passed | Failed | Errored | Skipped | Compatibility |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `s3-tests` | 711 | 201 | 510 | 0 | 79 | 28.27% |
| `mint` | 46 | 38 | 8 | 0 | 0 | 82.61% |

## Mapping Summary

The table groups non-passing cases by the main incompatibility they expose. A
single test can carry multiple feature markers, so counts are approximate for
overlapping areas.

| Failure domain | Current failures | HDDS-12716 or related Jira coverage | Assessment |
| --- | ---: | --- | --- |
| Signing, chunked uploads, presign, auth/header behavior | 20+ | HDDS-12542, HDDS-14802, HDDS-15139, HDDS-15140, HDDS-15141, HDDS-15142, HDDS-15143, HDDS-12871, HDDS-5195, HDDS-12935 | Covered by active or recent HDDS-12716 subtasks. |
| ListObjects/ListObjectsV2/ListBuckets semantics | ~22 | HDDS-12870, HDDS-12882, HDDS-11298 | Covered, but still failing in the latest run. |
| ACL, object ownership, expected bucket owner | ~42 | HDDS-9631, HDDS-13056, HDDS-13032 | Covered by linked or subtasked work. |
| STS, IAM session policy, WebIdentity, ABAC | ~61 | HDDS-13323, HDDS-13985 and STS subtasks under HDDS-13323 | Mostly covered. IAM user policy API coverage may need an explicit scope decision. |
| Lifecycle and expiration | ~24 | HDDS-8342 | Covered by linked lifecycle feature work. |
| CORS | 14 | HDDS-13850, HDDS-14386 | Covered. |
| Conditional requests and conditional writes/copy | 9 | HDDS-13117 and subtasks | Covered. |
| Multipart and copy behavior | ~18 | HDDS-11109, HDDS-12336, HDDS-2130, HDDS-8238 | Partially covered. |
| Object tagging | 17 marker failures | HDDS-10435, HDDS-10655, HDDS-11691, HDDS-13081 | Existing related issues, but not cleanly tracked under HDDS-12716. Current failures suggest follow-up or regression tracking. |
| Metadata/content headers/content type | ~8 | HDDS-6440, HDDS-1948, HDDS-5271 | Older resolved issues exist. Current failures should be triaged as regression or missing compatibility details. |
| SSE-C/SSE-S3/SSE-KMS/bucket encryption/copy encryption | ~100 | Older encrypted bucket issues exist, including HDDS-4005, HDDS-5501, HDDS-10784 | Missing a focused HDDS-12716 S3 API SSE compatibility task. |
| S3 Select | 32 | None found | Missing. |
| Object Lock, legal hold, retention | 36 | None found | Missing. |
| Bucket versioning, version IDs, delete markers | ~31 | No focused HDDS-12716 issue found | Missing or needs explicit out-of-scope decision. |
| Bucket policy status, PublicAccessBlock, NotPrincipal | Part of ~35 bucket policy failures | No focused issue found | Missing. |
| GetObjectAttributes and modern checksum APIs | ~15 | HDDS-10633 and HDDS-15032 cover Content-MD5 only | Missing for `GetObjectAttributes`, `x-amz-checksum-*`, and `CRC64NVME`. |
| Bucket logging | 6 | None found | Missing. |
| POST Object browser/form upload | 25 | None found | Missing. |
| GetObjectTorrent | 1 | None found | Missing or should be marked intentionally unsupported. |
| Mint `/minio/health/live` | 1 | Not an S3 API compatibility issue | Exclude from HDDS-12716 or mark expected unsupported. |

## Candidate Jira Follow-ups

These are the incompatibilities that do not appear to have a specific task or
linked issue in the HDDS-12716 tree.

1. Support or explicitly reject S3 Select (`SelectObjectContent`).
2. Track S3 SSE compatibility across SSE-C, SSE-S3, SSE-KMS, bucket encryption,
   multipart copy, and encrypted copy behavior.
3. Track S3 Object Lock APIs, including retention, legal hold, and object lock
   metadata response behavior.
4. Track S3 bucket versioning compatibility, including version IDs, delete
   markers, and versioned object ACL behavior.
5. Track S3 PublicAccessBlock and BucketPolicyStatus APIs.
6. Track modern object checksum APIs and `GetObjectAttributes`, including
   `CRC64NVME` and `x-amz-checksum-*` behavior.
7. Track S3 bucket logging APIs.
8. Track POST Object browser/form upload compatibility.
9. Decide whether `GetObjectTorrent` should be supported or documented as
   unsupported.
10. Decide whether Mint `healthcheck` should stay in compatibility scoring,
    since `/minio/health/live` is MinIO-specific rather than an AWS S3 API.

## Notes

- The latest run archives all Mint cases and only non-passing `s3-tests` cases,
  so this map focuses on failures and feature summaries rather than every
  passing test.
- Some failures are cascading effects from a smaller root cause. For example,
  ACL and bucket policy failures can cause downstream list, copy, or ownership
  cases to fail.
- The HDDS-12716 Jira page is used as the source of truth for direct subtasks
  and linked issues. Related older issues outside HDDS-12716 are listed only
  when they are useful for deciding whether to create a follow-up or regression
  task.
