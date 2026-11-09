import json
import re
import unittest
from spc_visuals import build_spc_visual


class SpcVisualTest(unittest.TestCase):
    def test_capability_uses_only_trusted_within_sigma_and_explicit_specs(self):
        processed = {'statistics': {'mean': 10}, 'capabilityStatus': {'sigmaEstimate': {'within': 2, 'overall': 7}, 'readiness': 'preliminary'}}
        controls = {'chartType': 'xBarR', 'lowerSpecLimit': 0, 'upperSpecLimit': 20}
        html = build_spc_visual(processed, controls, 'capability')
        data = json.loads(re.search(r"var d=(.*?);\n", html).group(1))
        self.assertEqual(data['sigma'], 2)
        self.assertEqual(data['lsl'], 0)
        self.assertIn('Simulation only', html)
        self.assertNotIn('fetch(', html)
        self.assertNotIn('<script src=', html)
        self.assertIsNone(build_spc_visual(processed, {'chartType': 'individual'}, 'capability'))
        self.assertIsNone(build_spc_visual(processed, {**controls, 'chartType': 'pChart'}, 'capability'))
        self.assertIsNone(build_spc_visual(processed, {**controls, 'upperSpecLimit': -1}, 'capability'))

    def test_rule_sets_have_distinct_ids_and_real_signal_counts(self):
        html = build_spc_visual({'ruleSummary': {'ruleSet': 'westernElectric', 'rules': [{'ruleNumber': 2, 'signalCount': 3}]}}, {}, 'rules')
        data = json.loads(re.search(r"var d=(.*?),select=", html).group(1))
        self.assertEqual(len(data['rules']), 4)
        self.assertIn('2 of 3', data['rules'][1]['description'])
        self.assertEqual(data['rules'][1]['count'], 3)
        self.assertEqual(data['rules'][0]['count'], 0)
        missing = build_spc_visual(None, {}, 'rules')
        data = json.loads(re.search(r"var d=(.*?),select=", missing).group(1))
        self.assertIsNone(data['rules'][0]['count'])

    def test_data_cannot_break_out_of_the_script(self):
        malicious = '</script><img src=x onerror=alert(1)>'
        html = build_spc_visual({'statistics': {'mean': 10}, 'capabilityStatus': {'sigmaEstimate': {'within': 1}, 'reasons': [malicious]}}, {'chartType': 'individual', 'upperSpecLimit': 15}, 'capability', 'he')
        self.assertNotIn(malicious, html)
        self.assertIn('dir="rtl"', html)
        self.assertIsNone(build_spc_visual({}, {}, 'unknown'))


class EvaluatedRuleVisualTest(unittest.TestCase):
    def test_only_evaluated_rules_have_counts(self):
        summary = {'ruleSummary': {'ruleSet': 'nelson', 'signalCount': 0, 'rules': []}}
        html = build_spc_visual(summary, {'chartType': 'ewma'}, 'rules')
        data = json.loads(re.search(r"var d=(.*?),select=", html).group(1))
        self.assertEqual(len(data['rules']), 1)
        self.assertTrue(data['limitOnly'])
        self.assertIsNone(build_spc_visual(summary, {'chartType': 'scatterPlot'}, 'rules'))
        self.assertIsNone(build_spc_visual(summary, {'chartType': 'histogram'}, 'rules'))
