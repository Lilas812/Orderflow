#!/usr/bin/env python3
"""Download an already purchased Batch job. Standard library only; GET only."""

import base64
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


JOB = "GLBX-20261105-RC8V97S64Y"
ROOT = Path(__file__).resolve().parents[1] / "data/research-v2/mbo-01"
CHUNK = 1024 * 1024
RESERVE = 64 * 1024 * 1024


class DownloadError(Exception):
    """Only locally authored, credential-free messages may be printed."""


class IntegrityError(DownloadError):
    def __init__(self, entry, actual_size, digest):
        super().__init__("SHA-256またはサイズ不一致。原本候補を保持し、処理を停止します。")
        self.details = {**public_entry(entry), "actual_size": actual_size,
                        "actual_sha256": digest, "verified": False}


def safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    allowed = (
        host == "databento.com" or host.endswith(".databento.com")
        or host.endswith(".amazonaws.com") or host == "storage.googleapis.com"
    )
    if (parsed.scheme != "https" or not allowed or parsed.username
            or parsed.password or parsed.port not in (None, 443)):
        raise DownloadError("安全なHTTPSダウンロード先を確認できません。URLは非表示です。")
    return parsed


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = safe_url(newurl)
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and target.netloc != urllib.parse.urlsplit(req.full_url).netloc:
            new.remove_header("Authorization")
        return new


class Client:
    def __init__(self, key):
        self.auth = "Basic " + base64.b64encode((key + ":").encode()).decode()
        self.opener = urllib.request.build_opener(SafeRedirect())

    def open(self, url, offset=None):
        parsed = safe_url(url)
        headers = {"Accept-Encoding": "identity"}
        if parsed.hostname == "databento.com" or parsed.hostname.endswith(".databento.com"):
            headers["Authorization"] = self.auth
        if offset:
            headers["Range"] = f"bytes={offset}-"
        # Never log a Request, URL, response body, or transport exception.
        return self.opener.open(urllib.request.Request(url, headers=headers), timeout=90)

    def list_files(self):
        url = "https://hist.databento.com/v0/batch.list_files?" + urllib.parse.urlencode(
            {"job_id": JOB}
        )
        with self.open(url) as response:
            data = response.read(16 * CHUNK + 1)
            if len(data) > 16 * CHUNK:
                raise DownloadError("ファイル一覧が16MiBを超えています。取得を停止します。")
            return json.loads(data)


def normalize(entries):
    if not isinstance(entries, list) or not entries:
        raise DownloadError("Batchのファイル一覧が空、または形式が不正です。")
    files, names = [], set()
    for row in entries:
        name = row.get("filename", "")
        if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name)
                or name in names or name.endswith(".part")):
            raise DownloadError("重複または安全でないファイル名があります。")
        size = row.get("size")
        digest = row.get("hash", "")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise DownloadError("manifestのサイズが不正です。")
        if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
            raise DownloadError("manifestのSHA-256が未提供、または未対応形式です。")
        url = row.get("urls", {}).get("https", "")
        safe_url(url)
        files.append({"filename": name, "size": size, "hash": digest.lower(), "url": url})
        names.add(name)
    return sorted(files, key=lambda item: item["filename"])


def public_entry(entry):
    return {key: entry[key] for key in ("filename", "size", "hash")}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as target:
            json.dump(value, target, ensure_ascii=False, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def remaining_bytes(files, raw):
    remaining = 0
    for entry in files:
        final = raw / entry["filename"]
        part = final.with_name(final.name + ".part")
        if final.is_symlink() or part.is_symlink():
            raise DownloadError("保存先にシンボリックリンクがあります。")
        if final.exists() and part.exists():
            raise DownloadError("完成ファイルと.partが同時に存在します。自動上書きはしません。")
        existing = final if final.exists() else part
        size = existing.stat().st_size if existing.exists() else 0
        if size > entry["size"] or (final.exists() and size != entry["size"]):
            raise DownloadError("既存ファイルのサイズがmanifestと異なります。上書きしません。")
        remaining += entry["size"] - size
    return remaining


def download_file(client, entry, raw, retries=3):
    final = raw / entry["filename"]
    part = final.with_name(final.name + ".part")
    if not final.exists():
        for attempt in range(retries):
            offset = part.stat().st_size if part.exists() else 0
            if offset == entry["size"]:
                if not part.exists():
                    part.touch()
                break
            try:
                with client.open(entry["url"], offset) as response:
                    if offset:
                        expected = f"bytes {offset}-{entry['size'] - 1}/{entry['size']}"
                        if response.status != 206 or response.headers.get("Content-Range") != expected:
                            raise DownloadError("Range再開の応答が不正です。.partは保持します。")
                    elif response.status != 200:
                        raise DownloadError("初回ダウンロードのHTTP応答が不正です。")
                    length = response.headers.get("Content-Length")
                    if length is not None and int(length) != entry["size"] - offset:
                        raise DownloadError("Content-Lengthがmanifestと異なります。")
                    if response.headers.get("Content-Encoding", "identity") != "identity":
                        raise DownloadError("転送時の自動展開は許可しません。")
                    written = offset
                    with part.open("ab") as target:
                        try:
                            while True:
                                chunk = response.read(CHUNK)
                                if not chunk:
                                    break
                                if written + len(chunk) > entry["size"]:
                                    raise DownloadError("manifestのサイズを超える応答です。")
                                target.write(chunk)
                                written += len(chunk)
                        finally:
                            target.flush()
                            os.fsync(target.fileno())
                if written != entry["size"]:
                    raise ConnectionError("short transfer")
                break
            except urllib.error.HTTPError as error:
                status = error.code
                error.close()
                if status not in (429, 500, 502, 503, 504) or attempt + 1 == retries:
                    raise DownloadError(f"ダウンロードHTTP {status}。.partは保持します。") from None
            except (OSError, urllib.error.URLError, http.client.HTTPException):
                if attempt + 1 == retries:
                    raise DownloadError("通信または書込みに失敗しました。.partから再開できます。") from None
            time.sleep(attempt + 1)
        candidate = part
    else:
        candidate = final
    digest = sha256(candidate)
    if candidate.stat().st_size != entry["size"] or "sha256:" + digest != entry["hash"]:
        raise IntegrityError(entry, candidate.stat().st_size, digest)
    if candidate == part:
        os.replace(part, final)
    final.chmod(0o444)
    return {**public_entry(entry), "sha256": digest, "verified": True}


def check_embedded_manifest(raw, files):
    path = raw / "manifest.json"
    if not path.exists():
        return {"source": "batch.list_files", "status": "matched",
                "note": "ジョブにmanifest.jsonなし。APIのファイルmanifestと全件照合。"}
    if path.stat().st_size > 16 * CHUNK:
        raise DownloadError("manifest.jsonが16MiBを超えています。")
    content = json.loads(path.read_text(encoding="utf-8"))
    if content.get("job_id") != JOB:
        raise DownloadError("ダウンロードしたmanifestのジョブIDが異なります。")
    listed = content.get("files")
    if not isinstance(listed, list):
        raise DownloadError("ダウンロードしたmanifestのfilesが不正です。")
    expected = {item["filename"]: public_entry(item) for item in files}
    seen = set()
    for row in listed:
        name = row.get("filename")
        if name in seen or name not in expected or {
            "filename": name, "size": row.get("size"), "hash": row.get("hash", "").lower()
        } != expected[name]:
            raise DownloadError("ダウンロードしたmanifestとAPI一覧が一致しません。")
        seen.add(name)
    if seen != set(expected) - {"manifest.json"} and seen != set(expected):
        raise DownloadError("ダウンロードしたmanifestに不足ファイルがあります。")
    return {"source": "manifest.json + batch.list_files", "status": "matched",
            "files_checked": len(seen)}


def run(client, root=ROOT, disk_free=None):
    files = normalize(client.list_files())
    print(f"ジョブ: {JOB}")
    for entry in files:
        print(f"  {entry['filename']}  {entry['size']:,} bytes")
    total = sum(entry["size"] for entry in files)
    print(f"合計: {total:,} bytes / {len(files)}ファイル")
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    raw = root / "raw"
    if raw.is_symlink():
        raise DownloadError("rawのシンボリックリンクは使用できません。")
    with (root / ".download.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DownloadError("同じ保存先で別のダウンロードが動いています。") from None
        index = {"job_id": JOB, "files": [public_entry(item) for item in files]}
        index_path = root / "download-index.json"
        if index_path.exists():
            if json.loads(index_path.read_text()) != index:
                raise DownloadError("前回とmanifestの版が異なります。既存ファイルは変更しません。")
        elif raw.exists() and any(raw.iterdir()):
            raise DownloadError("索引のない既存ファイルがあります。自動上書きはしません。")
        needed = remaining_bytes(files, raw)
        free = shutil.disk_usage(root).free if disk_free is None else disk_free
        print(f"残り取得量: {needed:,} bytes / 空き: {free:,} bytes / 安全余白: {RESERVE:,} bytes")
        if needed + RESERVE > free:
            raise DownloadError("ディスク空き不足。データ取得は開始していません。")
        if not index_path.exists():
            atomic_json(index_path, index)
        raw.mkdir(exist_ok=True)
        report = {"job_id": JOB, "status": "running", "expected_bytes": total, "files": []}
        report_path = root / "download-verification.json"
        started = time.monotonic()
        try:
            for entry in files:
                # Recheck available space in case other processes consumed the disk.
                if remaining_bytes([entry], raw) + RESERVE > shutil.disk_usage(root).free:
                    raise DownloadError("取得中にディスク空きが不足しました。.partは保持します。")
                result = download_file(client, entry, raw)
                report["files"].append(result)
                atomic_json(report_path, report)
                print(f"照合OK: {entry['filename']}", flush=True)
            report["manifest"] = check_embedded_manifest(raw, files)
            sums = root / "SHA256SUMS"
            with sums.open("w", encoding="utf-8") as target:
                for item in report["files"]:
                    target.write(f"{item['sha256']}  raw/{item['filename']}\n")
            report["status"] = "verified"
            report["elapsed_seconds"] = round(time.monotonic() - started, 3)
            atomic_json(report_path, report)
        except BaseException as error:
            report["status"] = "interrupted_or_failed"
            report["error_type"] = type(error).__name__
            if isinstance(error, IntegrityError):
                report["failed_file"] = error.details
            report["elapsed_seconds"] = round(time.monotonic() - started, 3)
            atomic_json(report_path, report)
            raise
    print(f"完了: {report_path}")
    return report


def main():
    key = os.environ.get("DATABENTO_API_KEY", "").strip()
    if not key:
        print("停止: ShellのDATABENTO_API_KEYが未設定です。", file=sys.stderr)
        return 1
    try:
        run(Client(key))
        return 0
    except urllib.error.HTTPError as error:
        print(f"停止: ファイル一覧のHTTP {error.code}。応答本文・URLは非表示です。", file=sys.stderr)
        error.close()
    except DownloadError as error:
        print(f"停止: {error}", file=sys.stderr)
    except KeyboardInterrupt:
        print("中断: .partを保持しました。同じコマンドで再開できます。", file=sys.stderr)
    except Exception:
        # Transport/JSON/library exceptions may contain a URL or credential.
        print("停止: 通信・読取・書込エラー。詳細は秘密保護のため非表示です。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
