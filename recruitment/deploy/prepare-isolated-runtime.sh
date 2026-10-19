#!/usr/bin/env bash
# One-time, scoped runtime preparation. Existing websites and system Node stay unchanged.
set -euo pipefail

runtime_root=/opt/recruitment-reader/runtime
node_release=node-v24.22.0-linux-x64
node_sha256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008

[[ "$(uname -m)" == x86_64 ]] || { printf '%s\n' 'Unsupported CPU architecture.' >&2; exit 1; }
if sudo -n test -e "$runtime_root/node"; then
    printf '%s\n' 'Dedicated Node runtime already exists; inspect before changing it.' >&2
    exit 1
fi
if getent passwd recruitment-reader >/dev/null; then
    printf '%s\n' 'Dedicated service account already exists; inspect before reusing it.' >&2
    exit 1
fi

download_dir=$(mktemp -d /tmp/recruitment-runtime.XXXXXX)
chmod 0700 "$download_dir"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 180 \
    "https://nodejs.org/dist/v24.22.0/$node_release.tar.xz" -o "$download_dir/$node_release.tar.xz"
printf '%s  %s\n' "$node_sha256" "$download_dir/$node_release.tar.xz" | sha256sum --check --status

sudo -n useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin recruitment-reader
sudo -n install -d -m 0755 -o root -g root "$runtime_root" /opt/recruitment-reader/recruitment /var/www/recruitment-reader
sudo -n install -d -m 0755 -o recruitment-reader -g recruitment-reader /var/lib/recruitment-reader/data
sudo -n install -d -m 0700 -o root -g root /etc/recruitment-reader
sudo -n install -d -m 0755 -o root -g root /var/www/letsencrypt/.well-known/acme-challenge
sudo -n tar --extract --xz --file "$download_dir/$node_release.tar.xz" --directory "$runtime_root" --no-same-owner
sudo -n ln -s "$node_release" "$runtime_root/node"
"$runtime_root/node/bin/node" --version
printf '%s\n' 'Dedicated runtime prepared; no existing website or global runtime was changed.'
printf 'Verified download retained at %s\n' "$download_dir"
