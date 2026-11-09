import os
import ssl
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import certifi
import main

class CertificateConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {}, clear=True))
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.der = ssl.create_default_context().get_ca_certs(binary_form=True)[0]
        self.pem = ssl.DER_cert_to_PEM_cert(self.der).encode('ascii')
        self.public = self.folder / 'public.pem'
        self.public.write_bytes(self.pem)
        self.combined = self.folder / 'generated' / 'combined.pem'
        self.enterContext(patch.object(main, 'COMBINED_CA_BUNDLE_PATH', self.combined))
        self.enterContext(patch.object(main, 'BUNDLED_CA_BUNDLE_PATH', self.folder / 'absent.pem'))
        self.enterContext(patch('certifi.where', return_value=str(self.public)))

    def test_windows_roots_reach_the_httpx_bundle_with_verification_enabled(self):
        context = SimpleNamespace(get_ca_certs=lambda **_: [self.der])
        with patch.object(main.sys, 'platform', 'win32'), patch.object(main.ssl, 'create_default_context', return_value=context):
            main.configure_combined_ca_bundle()
        self.assertTrue(self.combined.is_file())
        self.assertEqual(os.environ['SSL_CERT_FILE'], str(self.combined))
        self.assertEqual(os.environ['REQUESTS_CA_BUNDLE'], str(self.combined))
        verified = ssl.create_default_context(cafile=str(self.combined))
        self.assertEqual(verified.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(verified.check_hostname)

    def test_explicit_ca_bundle_is_preserved_and_atomic_output_has_no_leftovers(self):
        custom = self.folder / 'custom.pem'
        custom.write_bytes(self.pem + b'\n# explicit corporate roots\n')
        os.environ['SSL_CERT_FILE'] = str(custom)
        main.configure_combined_ca_bundle()
        self.assertIn(b'# explicit corporate roots', self.combined.read_bytes())
        self.assertEqual(list(self.combined.parent.glob('spc-ca-*')), [])
        main.configure_combined_ca_bundle()
        self.assertEqual(os.environ['SSL_CERT_FILE'], str(self.combined))

    def test_bundled_ca_is_found_in_a_development_checkout(self):
        service = self.folder / 'services' / 'dspy-gateway'
        service.mkdir(parents=True)
        (self.folder / 'package.json').write_text('{}', encoding='utf8')
        bundled = self.folder / 'deploy' / 'docker' / 'certs' / 'bluecoat-ca-bundle.pem'
        bundled.parent.mkdir(parents=True)
        bundled.write_bytes(self.pem + b'\n# bundled corporate roots\n')
        with patch.object(main, '__file__', str(service / 'main.py')), patch.object(main.sys, 'platform', 'linux'):
            main.configure_combined_ca_bundle()
        self.assertIn(b'# bundled corporate roots', self.combined.read_bytes())
