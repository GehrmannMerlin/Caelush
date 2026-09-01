#!/usr/bin/env sh
set -eu

artifact_path=${1:-}
if [ -z "$artifact_path" ]; then
  echo "Usage: install.sh PATH_TO_CAELUSH_ARTIFACT" >&2
  exit 2
fi

temporary_dir=
cleanup() {
  if [ -n "$temporary_dir" ]; then rm -rf "$temporary_dir"; fi
}
trap cleanup EXIT INT TERM

artifact_dir=$artifact_path
if [ -f "$artifact_path" ]; then
  case "$artifact_path" in
    *.tgz|*.tar.gz)
      temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/caelush-install.XXXXXX")
      tar -xzf "$artifact_path" -C "$temporary_dir"
      artifact_dir=$temporary_dir
      ;;
    *)
      echo "Artifact must be a directory or .tgz archive." >&2
      exit 2
      ;;
  esac
fi

manifest="$artifact_dir/manifest.json"
if [ ! -f "$manifest" ]; then
  echo "Artifact manifest.json is missing." >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "Node.js 24.x is required." >&2; exit 1; }
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major !== 24) process.exit(1)' || {
  echo "Node.js 24.x is required." >&2
  exit 1
}

manifest_hash=$(node -e 'const fs=require("fs"), crypto=require("crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$manifest")
if [ -f "$artifact_dir/manifest.sha256" ]; then
  expected_hash=$(awk '{print $1}' "$artifact_dir/manifest.sha256")
  [ "$manifest_hash" = "$expected_hash" ] || { echo "Artifact manifest checksum mismatch." >&2; exit 1; }
fi
if [ -f "$artifact_dir/checksums.sha256" ]; then
  node - "$artifact_dir" "$artifact_dir/checksums.sha256" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[1]);
const checksumPath = path.resolve(process.argv[2]);
const separator = path.sep;
for (const line of fs.readFileSync(checksumPath, "utf8").split(/\r?\n/)) {
  if (line.trim() === "") continue;
  const match = /^(?<hash>[0-9a-fA-F]{64})\s{2}(?<relative>.+)$/.exec(line);
  if (match === null) throw new Error("Invalid artifact checksum record.");
  const target = path.resolve(root, match.groups.relative.replaceAll("/", separator));
  if (target !== root && !target.startsWith(root + separator)) throw new Error("Artifact checksum path escapes the artifact.");
  const details = fs.lstatSync(target);
  if (!details.isFile()) throw new Error("Artifact checksum target is not a regular file.");
  const actual = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  if (actual.toLowerCase() !== match.groups.hash.toLowerCase()) throw new Error("Artifact checksum mismatch.");
}
NODE
fi

platform=$(node -e 'process.stdout.write(process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform)' )
arch=$(node -e 'process.stdout.write(process.arch)')
artifact_platform=$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).platform)' "$manifest")
artifact_arch=$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).arch)' "$manifest")
[ "$platform" = "$artifact_platform" ] || { echo "Artifact platform does not match this system." >&2; exit 1; }
[ "$arch" = "$artifact_arch" ] || { echo "Artifact architecture does not match this system." >&2; exit 1; }

version=$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$manifest")
install_root=${CAELUSH_INSTALL_ROOT:-"$HOME/.local/share/caelush"}
version_dir="$install_root/$version"
bin_dir=${CAELUSH_BIN_DIR:-"$HOME/.local/bin"}
mkdir -p "$install_root" "$bin_dir"
if [ ! -d "$version_dir" ]; then
  mkdir "$version_dir"
  cp -R "$artifact_dir/." "$version_dir/"
fi

cat > "$bin_dir/caelush" <<EOF
#!/usr/bin/env sh
exec node "$version_dir/bin/caelush" "\$@"
EOF
chmod +x "$bin_dir/caelush"
echo "Caelush $version installed at $version_dir"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH to use the caelush command." ;;
esac
