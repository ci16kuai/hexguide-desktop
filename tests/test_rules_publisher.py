from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import runpy
from threading import Thread
import unittest


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
