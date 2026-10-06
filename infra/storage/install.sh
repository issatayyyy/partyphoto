#!/bin/sh
set -eu

# Official Linux amd64 release; digest published by GitHub's release API.
version=4.48
sha256=4a7d108384d044d95212d1342cdda9533fa55842c1c9b41f606ca3c8a9561124
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) ;;
  *) echo 'This installer supports Linux amd64. Use the pinned Docker image on other platforms.' >&2; exit 1 ;;
esac

install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/partyphoto/seaweedfs/$version"
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --retry 2 \
  "https://github.com/seaweedfs/seaweedfs/releases/download/$version/linux_amd64.tar.gz" \
  --output "$temp_dir/release.tar.gz"
printf '%s  %s\n' "$sha256" "$temp_dir/release.tar.gz" | sha256sum --check --status
mkdir -p "$install_dir"
tar --extract --gzip --file "$temp_dir/release.tar.gz" --directory "$temp_dir" weed
install -m 700 "$temp_dir/weed" "$install_dir/weed"
printf 'Verified SeaweedFS %s installed at %s/weed\n' "$version" "$install_dir"
