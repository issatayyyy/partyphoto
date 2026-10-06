#!/bin/sh
set -eu
umask 077

# Explicit config has priority over identities saved in the filer. Fail closed
# when credentials are missing; never start SeaweedFS in anonymous Allow-All mode.
: "${S3_ACCESS_KEY_ID:?Set S3_ACCESS_KEY_ID}"
: "${S3_SECRET_ACCESS_KEY:?Set S3_SECRET_ACCESS_KEY}"
: "${S3_BUCKET:?Set S3_BUCKET}"
if [ "${#S3_ACCESS_KEY_ID}" -lt 8 ] || [ "${#S3_SECRET_ACCESS_KEY}" -lt 16 ]; then
  echo 'S3 access key must have at least 8 characters; secret must have at least 16.' >&2
  exit 1
fi
# These alphabets cover normal S3 keys and make JSON generation safe without jq.
case "$S3_ACCESS_KEY_ID$S3_SECRET_ACCESS_KEY" in *[!A-Za-z0-9_+/=-]*) echo 'S3 keys must use the alphanumeric/base64 alphabet.' >&2; exit 1 ;; esac
case "$S3_BUCKET" in ''|*[!a-z0-9.-]*|.*|*.|-*|*-|*..*) echo 'Invalid S3 bucket name.' >&2; exit 1 ;; esac
if [ "${#S3_BUCKET}" -lt 3 ] || [ "${#S3_BUCKET}" -gt 63 ]; then echo 'Invalid S3 bucket length.' >&2; exit 1; fi
mkdir -p /data/config
printf '{"identities":[{"name":"partyphoto","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Read:%s","Write:%s","List:%s","Tagging:%s","Admin:%s"]}]}' \
  "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" "$S3_BUCKET" "$S3_BUCKET" "$S3_BUCKET" "$S3_BUCKET" "$S3_BUCKET" > /data/config/s3.json
chmod 600 /data/config/s3.json
exec /usr/bin/weed mini -dir=/data -ip=127.0.0.1 -ip.bind=0.0.0.0 \
  -s3.port=9000 -s3.config=/data/config/s3.json -bucket="$S3_BUCKET" \
  -s3.autoCreateBucket=false -webdav=false -admin.ui=false -s3.iam=false \
  -s3.port.iceberg=0 -s3.port.lance=0 -master.telemetry=false \
  -filer.disableDirListing=true -filer.exposeDirectoryData=false
