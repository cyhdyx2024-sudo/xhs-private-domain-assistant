#!/usr/bin/env python3
"""Build reproducible extension and Bridge release archives with checksums."""
from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def fail(message: str) -> None:
    raise SystemExit(f"release check failed: {message}")


def add_file(archive: zipfile.ZipFile, source: Path, target: str) -> None:
    data = source.read_bytes()
    info = zipfile.ZipInfo(target, FIXED_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    archive.writestr(info, data)


def write_checksum(path: Path) -> Path:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    checksum = path.with_suffix(path.suffix + ".sha256")
    checksum.write_text(f"{digest}  {path.name}\n", encoding="utf-8")
    return checksum


manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
version = str(manifest.get("version") or "")
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    fail(f"invalid manifest version: {version!r}")

version_contracts = {
    ROOT / "extension" / "content.js": f"const VERSION = '{version}'",
    ROOT / "README.md": f"当前版本 V{version}",
    ROOT / "extension" / "README.md": f"当前版本 V{version}",
}
for path, expected in version_contracts.items():
    if expected not in path.read_text(encoding="utf-8"):
        fail(f"{path.relative_to(ROOT)} does not contain {expected!r}")

required_extension_files = {
    "manifest.json", "background.js", "content.js", "safety.js", "comment-copilot.js",
    "options.html", "options.js", "options.css", "popup.html", "popup.js", "popup.css",
    "floating-dock.css", "icon16.png", "icon48.png", "icon128.png",
}
missing = sorted(name for name in required_extension_files if not (ROOT / "extension" / name).is_file())
if missing:
    fail(f"missing extension files: {', '.join(missing)}")

DIST.mkdir(exist_ok=True)
for old in DIST.glob("xhs-*"):
    if old.is_file():
        old.unlink()

extension_zip = DIST / f"xhs-copilot-extension-v{version}.zip"
with zipfile.ZipFile(extension_zip, "w") as archive:
    for name in sorted(required_extension_files):
        add_file(archive, ROOT / "extension" / name, name)

with zipfile.ZipFile(extension_zip) as archive:
    names = set(archive.namelist())
    if "manifest.json" not in names or any(name.startswith("extension/") for name in names):
        fail("extension archive must contain manifest.json at archive root")

bridge_files = [
    *sorted(path for path in (ROOT / "server").glob("*.py") if not path.name.startswith("test_")),
    ROOT / "server" / ".env.example",
    ROOT / "server" / "README.md",
    ROOT / "LICENSE",
]
bridge_zip = DIST / f"xhs-copilot-bridge-v{version}.zip"
with zipfile.ZipFile(bridge_zip, "w") as archive:
    for path in bridge_files:
        target = "LICENSE" if path == ROOT / "LICENSE" else path.name
        add_file(archive, path, target)

extension_checksum = write_checksum(extension_zip)
bridge_checksum = write_checksum(bridge_zip)
print(extension_zip.relative_to(ROOT))
print(extension_checksum.relative_to(ROOT))
print(bridge_zip.relative_to(ROOT))
print(bridge_checksum.relative_to(ROOT))
