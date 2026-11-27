#!/usr/bin/env python3
"""Acquire the locked inner native-source ZIP; no application-source extraction."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import time
import urllib.parse
import urllib.request
import zipfile

# Temporary transport via the existing, independently verified public source asset.
# Replacement of that canonical asset must fail this pin, never refresh it implicitly.
OUTER = {
    "assetId": 798612637,
    "url": "https://github.com/GXinnnnnn/ACG-album/releases/download/v1.2.3/ACG-album-1.2.3-full-software-source.zip",
    "bytes": 294334499,
    "sha256": "3fac635ba522b1f2656440693f4faa8a693d0e5737c2f0d5f87c8e96fd097592",
}
ENTRY = "ACG-album-1.2.3-source/third-party/ACG-album-1.2.3-native-sources.zip"
HOSTS = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
CHUNK = 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and parsed.hostname in HOSTS, "Unapproved HTTPS endpoint")
    require(parsed.username is None and parsed.password is None, "Credentials are forbidden")
    require(parsed.port in (None, 443) and not parsed.fragment, "Unsafe URL authority")


class Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        self.count = 0

    def redirect_request(self, request, response, code, message, headers, new_url):
        self.count += 1
        require(self.count <= 5, "Too many redirects")
        safe_url(new_url)
        return super().redirect_request(request, response, code, message, headers, new_url)


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def hash_file(filename):
    digest = hashlib.sha256()
    total = 0
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            total += len(chunk)
            digest.update(chunk)
    return total, digest.hexdigest()


def main():
    require(len(sys.argv) == 2, "Usage: acquire-mac-native-source.py ABSOLUTE_NEW_DIRECTORY")
    requested = Path(sys.argv[1])
    require(requested.is_absolute(), "Absolute output directory required")
    parent = requested.parent.resolve(strict=True)
    directory = parent / requested.name
    # The caller owns the parent; create a new exclusive directory, never clean/reuse it.
    directory.mkdir(mode=0o700)
    outer = directory / "software-source.zip"
    inner = directory / "native-sources.zip"
    lock_path = Path(__file__).resolve().with_name("mac-native-sources.json")
    lock = json.loads(lock_path.read_text(encoding="utf-8"))["bundle"]
    require(lock["bytes"] == 246389582, "Unexpected native bundle lock size")
    require(lock["sha256"] == "0c713ac9d63c8e73119bfe68fec28693a25eecad0fc748e68ddd8c7cd71b8b01", "Unexpected native bundle lock SHA")
    safe_url(OUTER["url"])
    # No proxy/auth handlers, token, credential subprocess, retry, or response URL logging.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirects())
    deadline = time.monotonic() + 20 * 60
    request = urllib.request.Request(OUTER["url"], headers={"User-Agent": "ACG-native-source-acquisition/1", "Accept-Encoding": "identity"})
    total = 0
    digest = hashlib.sha256()
    with opener.open(request, timeout=30) as response, outer.open("xb") as output:
        require(response.status == 200, "Outer download did not return 200")
        safe_url(response.geturl())
        length = response.headers.get("Content-Length")
        if length is not None:
            require(int(length) == OUTER["bytes"], "Outer Content-Length mismatch")
        require(response.headers.get("Content-Encoding", "identity") == "identity", "Encoded outer body")
        while True:
            require(time.monotonic() < deadline, "Outer download deadline exceeded")
            chunk = response.read(CHUNK)
            require(time.monotonic() < deadline, "Outer download deadline exceeded")
            if not chunk:
                break
            total += len(chunk)
            require(total <= OUTER["bytes"], "Outer download exceeds locked size")
            digest.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    require((total, digest.hexdigest()) == (OUTER["bytes"], OUTER["sha256"]), "Whole outer identity mismatch")
    before = outer.lstat()
    require(stat.S_ISREG(before.st_mode), "Outer is not a regular file")
    require(hash_file(outer) == (OUTER["bytes"], OUTER["sha256"]), "Actual outer file identity mismatch")
    require(identity(outer.lstat()) == identity(before), "Outer changed during hashing")
    with outer.open("rb") as source:
        require(identity(os.fstat(source.fileno())) == identity(before), "Outer changed before ZIP inspection")
        with zipfile.ZipFile(source) as archive:
            names = set()
            selected = None
            for member in archive.infolist():
                name = member.filename
                parts = name.rstrip("/").split("/")
                require(name and "\\" not in name and ":" not in name and not PurePosixPath(name).is_absolute(), "Unsafe ZIP name")
                require(all(part not in ("", ".", "..") for part in parts), "Unsafe ZIP path")
                require(name.casefold() not in names, "Duplicate ZIP entry")
                names.add(name.casefold())
                if name == ENTRY:
                    require(selected is None, "Duplicate inner native archive")
                    selected = member
            require(selected is not None, "Inner native archive missing")
            require(not selected.is_dir() and stat.S_ISREG(selected.external_attr >> 16), "Inner entry must be a regular file")
            require(not selected.flag_bits & 1, "Encrypted inner archive forbidden")
            require(selected.file_size == lock["bytes"], "Inner archive size mismatch")
            inner_digest = hashlib.sha256()
            inner_bytes = 0
            with archive.open(selected, "r") as payload, inner.open("xb") as output:
                while True:
                    chunk = payload.read(CHUNK)  # Reading through EOF enforces ZIP CRC.
                    if not chunk:
                        break
                    inner_bytes += len(chunk)
                    require(inner_bytes <= lock["bytes"], "Inner archive exceeds locked size")
                    inner_digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            require((inner_bytes, inner_digest.hexdigest()) == (lock["bytes"], lock["sha256"]), "Whole inner identity mismatch")
        require(identity(os.fstat(source.fileno())) == identity(before), "Outer changed during extraction")
    require(identity(outer.lstat()) == identity(before), "Outer path changed")
    inner_before = inner.lstat()
    require(stat.S_ISREG(inner_before.st_mode), "Extracted archive must be regular")
    require(hash_file(inner) == (lock["bytes"], lock["sha256"]), "Actual output archive identity mismatch")
    require(identity(inner.lstat()) == identity(inner_before), "Extracted archive changed")
    receipt = {"kind": "acg-mac-native-source-acquisition", "wholeOuterVerified": True,
               "outerExpectedFact": OUTER, "entry": ENTRY, "crcReadToEOF": True,
               "inner": {"bytes": inner_bytes, "sha256": lock["sha256"]},
               "lockBundleUrl": lock["url"], "inputMode": "local-archive"}
    # assetId is historical expected metadata, not a newly observed GitHub API fact.
    with (directory / "ACQUISITION.json").open("x", encoding="utf-8") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    # No GITHUB_ENV change until every verification above has succeeded.
    github_env = os.environ.get("GITHUB_ENV")
    if github_env:
        require(not any(char in str(inner) for char in "\r\n\x00"), "Unsafe environment path")
        with open(github_env, "a", encoding="utf-8") as output:
            output.write("ACG_MAC_NATIVE_SOURCE_ARCHIVE=" + str(inner) + "\n")
    print(json.dumps({"nativeSourceArchive": str(inner), "bytes": inner_bytes, "sha256": lock["sha256"]}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid exposing signed redirect URLs, response headers or environment values.
        raise SystemExit("Native source acquisition failed (" + type(error).__name__ + "); retained fresh directory for diagnosis") from None
