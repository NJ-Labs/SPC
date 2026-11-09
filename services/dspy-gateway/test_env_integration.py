import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
import main


class EnvironmentIntegrationTest(unittest.TestCase):
    def setUp(self):
        folder = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.object(main, 'ENV_PATH', Path(folder) / 'absent.env'))

    def env(self, **changes):
        return {'AI_API_KEY': 'private-upstream-canary', 'AI_API_URL': 'https://models.example/prefix/v1/chat/completions', 'AI_MODEL': 'org/served-model', 'LITELLM_LOCAL_MODEL_COST_MAP': 'true', **changes}

    def test_root_env_wins_over_a_legacy_gateway_env(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            root = Path(folder)
            (root / 'package.json').write_text('{}', encoding='utf8')
            (root / '.env').write_text('AI_MODEL=root-model\n', encoding='utf8')
            service = root / 'services' / 'dspy-gateway'
            service.mkdir(parents=True)
            (service / '.env').write_text('AI_MODEL=legacy-model\n', encoding='utf8')
            with patch.object(main, '__file__', str(service / 'main.py')):
                self.assertEqual(main.resolve_env_path(), root / '.env')
                os.environ['SPC_ENV_FILE'] = str(service / '.env')
                self.assertEqual(main.resolve_env_path(), service / '.env')

    def test_three_values_resolve_without_a_provider_setting(self):
        instance = main.DSPyGateway()
        with patch.dict(os.environ, self.env(), clear=True), patch.object(instance, '_reload_env_if_changed'):
            model, base, _, _, kwargs = instance._resolve_litellm_runtime()
        self.assertEqual(model, 'org/served-model')
        self.assertEqual(base, 'https://models.example/prefix/v1')
        self.assertEqual(kwargs['api_key'], 'private-upstream-canary')
        self.assertEqual(kwargs['api_base'], base)

    def test_self_loop_detection_uses_the_bound_port_after_a_config_port_change(self):
        with patch.dict(os.environ, self.env(AI_GATEWAY_PORT='9002', SPC_GATEWAY_BIND_PORT='9001', AI_API_URL='http://127.0.0.1:9001/v1'), clear=True):
            self.assertEqual(main.active_gateway_port(), 9001)
            with self.assertRaises(main.AIConfigurationError):
                main.resolved_ai_config()
            os.environ['AI_API_URL'] = 'http://127.0.0.1:9002/v1'
            self.assertEqual(main.resolved_ai_config().api_base, 'http://127.0.0.1:9002/v1')

    def test_readiness_and_browser_config_use_the_same_three_values(self):
        with patch.dict(os.environ, self.env(), clear=True), patch.object(main.gateway, '_reload_env_if_changed'), patch.object(main.socket, 'create_connection') as connection:
            status = main.health_ready()
            config = main.runtime_config_response().body.decode()
        self.assertTrue(status['ready'], status)
        connection.assert_called_once_with(('models.example', 443), timeout=2)
        self.assertIn('org/served-model', config)
        self.assertNotIn('private-upstream-canary', config)
        self.assertNotIn('models.example', config)
        self.assertIn('"API_URL": "/"', config)

    def test_invalid_or_self_referencing_endpoint_has_a_clear_configuration_error(self):
        for url in ['http://127.0.0.1:8001/v1', 'https://user:private-upstream-canary@example.test/v1']:
            with self.subTest(url=url), patch.dict(os.environ, self.env(AI_API_URL=url), clear=True), patch.object(main.gateway, '_reload_env_if_changed'):
                status = main.health_ready()
                self.assertFalse(status['ready'])
                self.assertNotIn('private-upstream-canary', json.dumps(status))
                instance = main.DSPyGateway()
                with patch.object(instance, '_reload_env_if_changed'):
                    with self.assertRaises(RuntimeError) as error:
                        instance._resolve_litellm_runtime()
                mapped = main.upstream_http_error(error.exception, 'request')
                self.assertEqual(mapped.status_code, 503)
                self.assertNotIn('private-upstream-canary', mapped.detail)

    def test_env_file_reload_updates_endpoint_and_model_without_global_dspy_config(self):
        with tempfile.TemporaryDirectory() as folder:
            env_file = Path(folder) / '.env'
            env_file.write_text('AI_API_KEY=first-key\nAI_API_URL=https://first.test\nAI_MODEL=first\n', encoding='utf8')
            os.utime(env_file, (1000, 1000))
            instance = main.DSPyGateway()
            with patch.dict(os.environ, {}, clear=True), patch.object(main, 'ENV_PATH', env_file):
                first = instance._resolve_litellm_runtime()
                env_file.write_text('AI_API_KEY=second-key\nAI_API_URL=https://second.test/custom/v1/chat/completions\nAI_MODEL=second\n', encoding='utf8')
                os.utime(env_file, (1001, 1001))
                second = instance._resolve_litellm_runtime()
            self.assertEqual((first[0], first[1]), ('first', 'https://first.test/v1'))
            self.assertEqual((second[0], second[1]), ('second', 'https://second.test/custom/v1'))
            self.assertEqual(second[4]['api_key'], 'second-key')

    def test_gateway_calls_an_openai_server_with_the_exact_model_id_and_private_key(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append((self.path, self.headers.get('Authorization'), body['model']))
                result = {'id': 'offline', 'object': 'chat.completion', 'created': 0, 'model': body['model'], 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': '[[ ## answer ## ]]\n- Offline connection verified.\n[[ ## completed ## ]]'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
                encoded = json.dumps(result).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f'http://127.0.0.1:{server.server_port}/v1/chat/completions'
            instance = main.DSPyGateway()
            with patch.dict(os.environ, self.env(AI_API_URL=url, AI_MODEL='openai/gpt-oss-offline-test'), clear=True), patch.object(instance, '_reload_env_if_changed'), patch.object(main, 'gateway', instance):
                resolved = instance._resolve_litellm_runtime()
                self.assertEqual(resolved[1], url.removesuffix('/chat/completions'))
                with TestClient(main.app) as client:
                    config = client.get('/config/runtime-config.js').text
                    self.assertNotIn('private-upstream-canary', config)
                    response = client.post('/v1/chat/completions', headers={'Authorization': f'Bearer {main.DEFAULT_GATEWAY_API_KEY}'}, json={'messages': [{'role': 'user', 'content': 'Explain SPC briefly.'}]})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIn('Offline connection verified', response.json()['choices'][0]['message']['content'])
            self.assertTrue(requests)
            self.assertEqual(requests[0], ('/v1/chat/completions', 'Bearer private-upstream-canary', 'openai/gpt-oss-offline-test'))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
