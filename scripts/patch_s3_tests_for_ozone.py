#!/usr/bin/env python3

import argparse
from pathlib import Path
import re
import sys


MARKER = "# Ozone compatibility patch: clean up plain objects and multipart uploads"

REPLACEMENT = """def list_current_objects(client, bucket, batch_size):
    kwargs = {'Bucket': bucket, 'MaxKeys': batch_size}
    truncated = True
    while truncated:
        listing = client.list_objects_v2(**kwargs)

        if listing.get('NextContinuationToken'):
            kwargs['ContinuationToken'] = listing['NextContinuationToken']
        truncated = listing['IsTruncated']

        objs = listing.get('Contents', [])
        if len(objs):
            yield [{'Key': o['Key']} for o in objs]

def list_multipart_uploads(client, bucket, batch_size):
    kwargs = {'Bucket': bucket, 'MaxUploads': batch_size}
    truncated = True
    while truncated:
        listing = client.list_multipart_uploads(**kwargs)

        kwargs['KeyMarker'] = listing.get('NextKeyMarker')
        kwargs['UploadIdMarker'] = listing.get('NextUploadIdMarker')
        truncated = listing['IsTruncated']

        uploads = listing.get('Uploads', [])
        if len(uploads):
            yield [{'Key': u['Key'], 'UploadId': u['UploadId']} for u in uploads]

def abort_multipart_uploads(client, bucket, batch_size):
    for uploads in list_multipart_uploads(client, bucket, batch_size):
        for upload in uploads:
            client.abort_multipart_upload(Bucket=bucket,
                    Key=upload['Key'], UploadId=upload['UploadId'])

def delete_current_objects(client, bucket, batch_size):
    for objects in list_current_objects(client, bucket, batch_size):
        client.delete_objects(Bucket=bucket,
                Delete={'Objects': objects, 'Quiet': True},
                BypassGovernanceRetention=True)

def nuke_bucket(client, bucket):
    # Ozone does not currently list plain objects in list_object_versions()
    # for non-versioned buckets, so upstream cleanup leaves normal objects
    # behind and the package-wide autouse fixture poisons later tests.
    # Ozone compatibility patch: clean up plain objects and multipart uploads
    batch_size = 128
    max_retain_date = None

    abort_multipart_uploads(client, bucket, batch_size)
    delete_current_objects(client, bucket, batch_size)

    # list and delete object versions in batches
    for objects in list_versions(client, bucket, batch_size):
        delete = client.delete_objects(Bucket=bucket,
                Delete={'Objects': objects, 'Quiet': True},
                BypassGovernanceRetention=True)

        # check for object locks on 403 AccessDenied errors
        for err in delete.get('Errors', []):
            if err.get('Code') != 'AccessDenied':
                continue
            try:
                res = client.get_object_retention(Bucket=bucket,
                        Key=err['Key'], VersionId=err['VersionId'])
                retain_date = res['Retention']['RetainUntilDate']
                if not max_retain_date or max_retain_date < retain_date:
                    max_retain_date = retain_date
            except ClientError:
                pass

    if max_retain_date:
        # wait out the retention period (up to 60 seconds)
        now = datetime.datetime.now(max_retain_date.tzinfo)
        if max_retain_date > now:
            delta = max_retain_date - now
            if delta.total_seconds() > 60:
                raise RuntimeError('bucket {} still has objects \\
locked for {} more seconds, not waiting for \\
bucket cleanup'.format(bucket, delta.total_seconds()))
            print('nuke_bucket', bucket, 'waiting', delta.total_seconds(),
                    'seconds for object locks to expire')
            time.sleep(delta.total_seconds())

        for objects in list_versions(client, bucket, batch_size):
            client.delete_objects(Bucket=bucket,
                    Delete={'Objects': objects, 'Quiet': True},
                    BypassGovernanceRetention=True)

    delete_current_objects(client, bucket, batch_size)
    abort_multipart_uploads(client, bucket, batch_size)
    client.delete_bucket(Bucket=bucket)

"""


UNAUTHENTICATED_MARKER = "# Ozone compatibility patch: skip unauthenticated client tests"

UNAUTHENTICATED_REPLACEMENT = """def get_unauthenticated_client():
    # Ozone compatibility patch: skip unauthenticated client tests
    import pytest
    pytest.skip('Ozone does not support unauthenticated (anonymous) access')

"""


def patch_repo(repo: Path) -> None:
    target = repo / "s3tests" / "functional" / "__init__.py"
    if not target.exists():
        raise FileNotFoundError(f"missing target file: {target}")

    text = target.read_text()
    new_text = text

    if MARKER not in new_text:
        pattern = r"def nuke_bucket\(client, bucket\):\n.*?(?=def nuke_prefixed_buckets)"
        new_text, count = re.subn(pattern, REPLACEMENT, new_text, count=1, flags=re.S)
        if count != 1:
            raise RuntimeError(f"could not locate nuke_bucket() in {target}")

    if UNAUTHENTICATED_MARKER not in new_text:
        pattern = r"def get_unauthenticated_client\(\):.*?(?=\ndef )"
        new_text, count = re.subn(pattern, UNAUTHENTICATED_REPLACEMENT, new_text, count=1, flags=re.S)
        if count != 1:
            raise RuntimeError(f"could not locate get_unauthenticated_client() in {target}")

    target.write_text(new_text)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, help="Path to the checked-out s3-tests repository")
    args = parser.parse_args()

    patch_repo(Path(args.repo))
    return 0


if __name__ == "__main__":
    sys.exit(main())
