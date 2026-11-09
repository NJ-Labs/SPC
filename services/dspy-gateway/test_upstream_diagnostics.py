import unittest
from unittest.mock import patch
import litellm
import httpx
from fastapi.testclient import TestClient
import main

class UpstreamDiagnosticsTests(unittest.TestCase):
    def test_invalid_key_has_a_stable_code_and_no_raw_provider_details(self):
        error = litellm.AuthenticationError(message='Invalid or expired API key private-upstream-canary', model='offline', llm_provider='openai')
        mapped = main.upstream_http_error(error, 'request')
        self.assertEqual(mapped.status_code, 502)
        self.assertEqual(mapped.headers['X-SPC-Error-Code'], 'upstream_api_key_invalid')
        self.assertIn('invalid or expired', mapped.detail)
        self.assertIn('AI_API_KEY', mapped.detail)
        self.assertNotIn('private-upstream-canary', mapped.detail)

    def test_wrapped_expired_token_still_identifies_authentication(self):
        mapped = main.upstream_http_error(RuntimeError('Invalid or expired API key; invalid_token'), 'request')
        self.assertEqual(mapped.status_code, 502)
        self.assertEqual(mapped.headers['X-SPC-Error-Code'], 'upstream_api_key_invalid')

    def test_permission_denied_is_not_labelled_as_an_invalid_key(self):
        error = litellm.PermissionDeniedError(message='Model access denied', model='offline', llm_provider='openai', response=httpx.Response(403, request=httpx.Request('POST', 'https://offline.invalid/v1/chat/completions')))
        mapped = main.upstream_http_error(error, 'request')
        self.assertEqual(mapped.headers['X-SPC-Error-Code'], 'upstream_permission_denied')
        self.assertNotIn('invalid or expired', mapped.detail)

    def test_error_code_reaches_the_browser_over_http(self):
        error = litellm.AuthenticationError(message='private-upstream-canary', model='offline', llm_provider='openai')
        with patch.object(main, 'require_gateway_key'), patch.object(main.gateway, 'answer', side_effect=error), TestClient(main.app) as client:
            response = client.post('/v1/chat/completions', headers={'Origin': 'http://offline.test'}, json={'messages': [{'role': 'user', 'content': 'Offline test'}]})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.headers['X-SPC-Error-Code'], 'upstream_api_key_invalid')
        self.assertIn('x-spc-error-code', response.headers['Access-Control-Expose-Headers'].lower())
        self.assertNotIn('private-upstream-canary', response.text)
