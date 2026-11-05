"""Offline tests: no Databento requests, no real credentials."""

import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import download_mbo_batch as download


def item(name, data):
    return {"filename": name, "size": len(data),
            "hash": "sha256:" + hashlib.sha256(data).hexdigest(),
            "urls": {"https": "https://api.databento.com/download/" + name}}


class Response(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status, self.headers = status, headers or {}


class FakeClient:
    def __init__(self, bodies, entries=None, behavior=None):
        self.bodies = bodies
        self.entries = entries or [item(name, value) for name, value in bodies.items()]
        self.calls = []
        self.behavior = behavior

    def list_files(self):
        return self.entries

    def open(self, url, offset=None):
        name = url.rsplit("/", 1)[1]
        offset = offset or 0
        self.calls.append((name, offset))
        if self.behavior:
            response = self.behavior(name, offset, len(self.calls))
            if response is not None:
                return response
        data = self.bodies[name]
        headers = {"Content-Length": str(len(data) - offset)}
        if offset:
            headers["Content-Range"] = f"bytes {offset}-{len(data)-1}/{len(data)}"
        return Response(data[offset:], 206 if offset else 200, headers)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "isolated"
        self.output = io.StringIO()
        self.redirect = contextlib.redirect_stdout(self.output)
        self.redirect.__enter__()
        self.addCleanup(self.redirect.__exit__, None, None, None)

    def test_complete_manifest_sha_read_only_and_idempotent(self):
        body = b"record\n" * 10
        manifest = json.dumps({"job_id": download.JOB, "files": [item("one.zst", body)]}).encode()
        client = FakeClient({"one.zst": body, "manifest.json": manifest})
        result = download.run(client, self.root)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["manifest"]["status"], "matched")
        self.assertEqual((self.root / "raw/one.zst").stat().st_mode & 0o222, 0)
        self.assertEqual(len((self.root / "SHA256SUMS").read_text().splitlines()), 2)
        client.calls.clear()
        again = download.run(client, self.root)
        self.assertEqual(client.calls, [])
        self.assertEqual(result["files"], again["files"])
        self.assertNotIn("https://", (self.root / "download-index.json").read_text())

    def test_no_embedded_manifest_uses_api_manifest(self):
        result = download.run(FakeClient({"one.zst": b"123"}), self.root)
        self.assertEqual(result["manifest"]["source"], "batch.list_files")

    def test_insufficient_disk_never_downloads(self):
        client = FakeClient({"one.zst": b"123"})
        with self.assertRaises(download.DownloadError):
            download.run(client, self.root, disk_free=0)
        self.assertEqual(client.calls, [])
        self.assertFalse((self.root / "raw").exists())

    def test_disconnected_stream_resumes_exact_offset(self):
        body = b"abcdefghij"
        client = FakeClient({"one.zst": body}, behavior=lambda n, off, call:
                            Response(body[:4]) if call == 1 else None)
        with patch.object(download.time, "sleep"):
            download.run(client, self.root)
        self.assertEqual(client.calls, [("one.zst", 0), ("one.zst", 4)])
        self.assertEqual((self.root / "raw/one.zst").read_bytes(), body)
        self.assertFalse((self.root / "raw/one.zst.part").exists())

    def test_interrupted_run_then_same_command_resumes(self):
        body = b"abcdefghij"
        class Interrupted(Response):
            def read(self, size=-1):
                if self.tell():
                    raise KeyboardInterrupt()
                return super().read(4)
        client = FakeClient({"one.zst": body}, behavior=lambda *args: Interrupted(body))
        with self.assertRaises(KeyboardInterrupt):
            download.run(client, self.root)
        self.assertEqual((self.root / "raw/one.zst.part").read_bytes(), body[:4])
        second = FakeClient({"one.zst": body})
        download.run(second, self.root)
        self.assertEqual(second.calls, [("one.zst", 4)])

    def test_range_ignored_does_not_append_full_body(self):
        body = b"abcdefghij"
        client = FakeClient({"one.zst": body}, behavior=lambda n, off, call:
                            Response(body[:4]) if call == 1 else Response(body))
        with patch.object(download.time, "sleep"), self.assertRaises(download.DownloadError):
            download.run(client, self.root)
        self.assertEqual((self.root / "raw/one.zst.part").read_bytes(), body[:4])

    def test_hash_mismatch_is_not_marked_verified(self):
        client = FakeClient({"one.zst": b"bad"}, entries=[item("one.zst", b"YES")])
        with self.assertRaises(download.DownloadError):
            download.run(client, self.root)
        result = json.loads((self.root / "download-verification.json").read_text())
        self.assertEqual(result["status"], "interrupted_or_failed")
        self.assertEqual(result["failed_file"]["actual_sha256"], hashlib.sha256(b"bad").hexdigest())
        self.assertFalse((self.root / "raw/one.zst").exists())
        self.assertTrue((self.root / "raw/one.zst.part").exists())

    def test_changed_manifest_never_overwrites_existing(self):
        download.run(FakeClient({"one.zst": b"123"}), self.root)
        client = FakeClient({"one.zst": b"456"})
        with self.assertRaises(download.DownloadError):
            download.run(client, self.root)
        self.assertEqual(client.calls, [])
        self.assertEqual((self.root / "raw/one.zst").read_bytes(), b"123")

    def test_bad_embedded_manifest_fails(self):
        body = b"123"
        manifest = json.dumps({"job_id": "WRONG", "files": []}).encode()
        with self.assertRaises(download.DownloadError):
            download.run(FakeClient({"one.zst": body, "manifest.json": manifest}), self.root)
        self.assertEqual(json.loads((self.root / "download-verification.json").read_text())["status"],
                         "interrupted_or_failed")

    def test_unsafe_paths_and_digests_rejected(self):
        for name in ("../secret", "/absolute", "a.part", "a\nb"):
            with self.assertRaises(download.DownloadError):
                download.normalize([item(name, b"1")])
        row = item("one.zst", b"1")
        row["hash"] = "md5:not-sha256"
        with self.assertRaises(download.DownloadError):
            download.normalize([row])

    def test_bad_content_range_and_length_rejected(self):
        for headers in ({"Content-Length": "999"}, {"Content-Encoding": "gzip"}):
            raw = Path(self.directory.name)
            client = FakeClient({"one.zst": b"123"}, behavior=lambda *args: Response(b"123", headers=headers))
            with self.assertRaises(download.DownloadError):
                download.download_file(client, download.normalize(client.entries)[0], raw)
        client = FakeClient({"one.zst": b"123"}, behavior=lambda *args:
                            Response(b"23", 206, {"Content-Range": "bytes 0-2/3"}))
        raw = Path(self.directory.name)
        (raw / "one.zst.part").write_bytes(b"1")
        with self.assertRaises(download.DownloadError):
            download.download_file(client, download.normalize(client.entries)[0], raw)

    def test_cross_host_redirect_drops_basic_auth(self):
        request = urllib.request.Request("https://api.databento.com/download/file",
                                         headers={"Authorization": "Basic DUMMY_TEST_CREDENTIAL"})
        redirected = download.SafeRedirect().redirect_request(
            request, None, 302, "", {}, "https://storage.googleapis.com/bucket/file")
        self.assertIsNone(redirected.get_header("Authorization"))
        with self.assertRaises(download.DownloadError):
            download.SafeRedirect().redirect_request(request, None, 302, "", {}, "http://example.com")

    def test_auth_failure_does_not_leak_response(self):
        error = urllib.error.HTTPError("https://example.com/SECRET", 401, "SECRET", {},
                                      io.BytesIO(b"SECRET"))
        with patch.dict(download.os.environ, {"DATABENTO_API_KEY": "DUMMY_SECRET"}), \
                patch.object(download.Client, "list_files", side_effect=error), \
                contextlib.redirect_stderr(self.output):
            self.assertEqual(download.main(), 1)
        self.assertNotIn("SECRET", self.output.getvalue())
        self.assertIn("401", self.output.getvalue())

    def test_empty_file_and_partial_symlink(self):
        result = download.run(FakeClient({"empty.zst": b""}), self.root)
        self.assertEqual(result["status"], "verified")
        raw = self.root / "raw"
        (raw / "other.zst.part").symlink_to(raw / "empty.zst")
        with self.assertRaises(download.DownloadError):
            download.remaining_bytes(download.normalize([item("other.zst", b"123")]), raw)

    def test_concurrent_run_refuses_same_destination(self):
        self.root.mkdir()
        with (self.root / ".download.lock").open("a+") as lock:
            download.fcntl.flock(lock, download.fcntl.LOCK_EX | download.fcntl.LOCK_NB)
            client = FakeClient({"one.zst": b"123"})
            with self.assertRaises(download.DownloadError):
                download.run(client, self.root)
            self.assertEqual(client.calls, [])

    def test_http_client_is_get_basic_with_empty_password(self):
        client = download.Client("DUMMY_CREDENTIAL")
        with patch.object(client.opener, "open", return_value=Response(b"[]")) as opened:
            self.assertEqual(client.list_files(), [])
            request = opened.call_args.args[0]
            self.assertEqual(request.get_method(), "GET")
            self.assertEqual(request.full_url,
                             "https://hist.databento.com/v0/batch.list_files?job_id=" + download.JOB)
            auth = request.get_header("Authorization")
            self.assertEqual(download.base64.b64decode(auth.split(" ")[1]), b"DUMMY_CREDENTIAL:")


if __name__ == "__main__":
    unittest.main()
