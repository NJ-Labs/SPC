import unittest

from env_config import normalize_endpoint, resolve_ai_config


class EndpointTests(unittest.TestCase):
    def test_server_base_v1_and_completion_urls(self):
        for endpoint in (
            "https://example.test", "https://example.test/", "https://example.test/v1/",
            "https://example.test/v1/chat/completions/",
        ):
            with self.subTest(endpoint=endpoint):
                self.assertEqual(normalize_endpoint(endpoint), "https://example.test/v1")

    def test_custom_path_prefix_is_preserved(self):
        for endpoint in ("http://example.test:9000/custom", "http://example.test:9000/custom/v1",
                         "http://example.test:9000/custom/v1/chat/completions"):
            with self.subTest(endpoint=endpoint):
                self.assertEqual(normalize_endpoint(endpoint), "http://example.test:9000/custom/v1")

    def test_invalid_urls_do_not_echo_sensitive_input(self):
        for endpoint in ("example.test/v1", "ftp://example.test", "https://user:secret@example.test/v1",
                         "https://example.test/v1?key=secret", "http://example.test:abc/v1", "https://exa mple.test"):
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(ValueError) as error:
                    normalize_endpoint(endpoint)
                self.assertNotIn("secret", str(error.exception))

    def test_rejects_obvious_self_loop_but_allows_other_ports(self):
        for host in ("localhost", "127.0.0.1", "[::1]", "0.0.0.0"):
            with self.subTest(host=host):
                with self.assertRaisesRegex(ValueError, "upstream model server"):
                    normalize_endpoint(f"http://{host}:8001/v1", gateway_port=8001)
        self.assertEqual(normalize_endpoint("http://localhost:9000", 8001), "http://localhost:9000/v1")


class ConfigTests(unittest.TestCase):
    def test_canonical_fields_override_legacy(self):
        config = resolve_ai_config({"AI_API_KEY": "secret", "DSPY_API_KEY": "old",
            "AI_MODEL": "Qwen/model", "VITE_AI_MODEL": "old-model",
            "AI_API_URL": "https://new.test/prefix", "AI_API_BASE": "https://old.test",
            "DSPY_API_BASE": "https://older.test", "VITE_AI_API_URL": "https://oldest.test"})
        self.assertEqual((config.api_key, config.model, config.api_base, config.provider),
                         ("secret", "Qwen/model", "https://new.test/prefix/v1", "openai"))
        self.assertNotIn("secret", repr(config))

    def test_legacy_fallbacks_and_blank_values(self):
        config = resolve_ai_config({"AI_API_KEY": " ", "DSPY_API_KEY": "legacy-key",
            "VITE_AI_MODEL": "legacy", "DSPY_API_BASE": "https://legacy.test/v1"})
        self.assertEqual((config.api_key, config.model, config.api_base, config.provider),
                         ("legacy-key", "legacy", "https://legacy.test/v1", "openai"))
        vite = resolve_ai_config({"VITE_AI_API_KEY": "key", "VITE_AI_MODEL": "model", "VITE_AI_API_URL": "https://legacy.test"})
        self.assertEqual(vite.api_base, "https://legacy.test/v1")
        self.assertEqual(vite.api_key, "key")

    def test_provider_override_and_legacy_prefix(self):
        self.assertEqual(resolve_ai_config({"AI_API_URL": "https://host.test", "AI_MODEL": "model", "AI_PROVIDER": "Anthropic"}).provider, "anthropic")
        prefixed = resolve_ai_config({"AI_MODEL": "gemini/gemini-2.0"})
        self.assertEqual((prefixed.provider, prefixed.model), ("gemini", "gemini/gemini-2.0"))
        self.assertEqual(resolve_ai_config({"AI_MODEL": "gemini/model", "AI_PROVIDER": "openai"}).provider, "openai")

    def test_missing_fields_are_left_to_caller(self):
        config = resolve_ai_config({})
        self.assertEqual((config.api_key, config.api_base, config.model, config.provider), (None, None, None, None))


if __name__ == "__main__":
    unittest.main()
