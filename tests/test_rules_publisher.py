from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import runpy
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import Mock, patch


class CommunityDragonHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not self.headers.get("User-Agent", "").startswith("HexGuide-rules/"):
            self.send_error(403)
            return
        body = b'{"modeName":"KIWI"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class RulesPublisherTest(unittest.TestCase):
    def test_confirmed_hotfix_rechecks_same_patch_without_republishing_unchanged_bytes(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "publish-rules.py"
        publish = runpy.run_path(str(script))["publish"]
        official_url = "https://lol.qq.com/gicp/news/410/37102797.html"
        notice = dict(id="main", title="26.23 官网更新公告", format=2, toVersion="16.23.1",
                      sha256="a" * 64, sourceUrl=official_url)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "announcements").mkdir()
            index = root / "announcements/index-v3.json"
            manifest = root / "rules/index.json"
            index.write_text(json.dumps({"entries": [notice]}), encoding="utf-8")
            build = Mock(side_effect=lambda *args: {"schemaVersion": 1, "clientPatch": "16.23", "augments": []})
            with patch.dict(publish.__globals__, download=Mock(), make_pack=build):
                publish(root)
                first = json.loads(manifest.read_bytes())
                hotfix = dict(notice, id="fix", title="不停机更新", sha256="b" * 64,
                              sourceUrl="https://lol.qq.com/gicp/news/410/12345678.html")
                index.write_text(json.dumps({"entries": [hotfix, notice]}), encoding="utf-8")
                publish(root)
                second = json.loads(manifest.read_bytes())
                self.assertNotEqual(first["announcementRevision"], second["announcementRevision"])
                self.assertEqual(first["sha256"], second["sha256"])
                self.assertEqual(first["updatedAt"], second["updatedAt"])
                pack = json.loads((root / "rules" / (second["sha256"] + ".json")).read_bytes())
                self.assertEqual(pack["officialAnnouncement"], {"version": "16.23.1", "url": official_url})
                publish(root)
                self.assertEqual(build.call_count, 2)

    def test_download_identifies_rules_publisher_to_upstream(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "publish-rules.py"
        download = runpy.run_path(str(script))["download"]

        with ThreadingHTTPServer(("127.0.0.1", 0), CommunityDragonHandler) as server:
            thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
            thread.start()
            try:
                source = f"http://127.0.0.1:{server.server_port}/16.23"
                self.assertEqual(download(source, "augment-lists.json"), {"modeName": "KIWI"})
            finally:
                server.shutdown()
                thread.join()
