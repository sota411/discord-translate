#!/bin/sh
set -eu

umask 077

source_url="https://raw.githubusercontent.com/moby/moby/v28.5.2/vendor/github.com/moby/profiles/seccomp/default.json"
source_sha256="01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28"
profile_sha256="f16b3056cacd6e9f22a959ac827e20d258ffdd5e804e67ed68dae27c297c9983"
profile_dir="${XDG_DATA_HOME:-$HOME/.local/share}/discord-translate/seccomp"
profile_path="$profile_dir/aarch64-v28.5.2.json"
source_file="$(mktemp)"
profile_file="$(mktemp)"

cleanup() {
  rm -f "$source_file" "$profile_file"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

for command_name in curl python3 sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "$command_name is required" >&2
    exit 1
  }
done

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  "$source_url" --output "$source_file"
printf '%s  %s\n' "$source_sha256" "$source_file" | sha256sum --check --status

python3 - "$source_file" "$profile_file" <<'PYTHON'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    profile = json.load(source)

profile.pop("archMap", None)
profile["architectures"] = ["SCMP_ARCH_AARCH64"]

with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as output:
    json.dump(profile, output, indent=2)
    output.write("\n")
PYTHON
printf '%s  %s\n' "$profile_sha256" "$profile_file" | sha256sum --check --status

install -d -m 700 "$profile_dir"
install -m 600 "$profile_file" "$profile_path"
printf '%s\n' "$profile_path"
