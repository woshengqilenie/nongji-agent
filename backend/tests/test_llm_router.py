from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from app.main import app


class LLMRouterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()

    def test_llm_stream_requires_messages(self) -> None:
        payload = {
            "endpoint": "http://127.0.0.1:5001/v1/chat/completions",
            "api_key": "dummy-key",
            "model": "deepseek-chat",
            "messages": [],
        }
        resp = self.client.post("/api/llm/chat/stream", json=payload)
        self.assertEqual(resp.status_code, 400)
        body = resp.json()
        self.assertIn("详情", body)
        self.assertEqual(body["详情"], "messages 不能为空")


if __name__ == "__main__":
    unittest.main()
