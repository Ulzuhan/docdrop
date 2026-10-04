"""Synthetic baselines and attestation output; no credentials, network or Docker."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("baseline", Path(__file__).parents[1] / "rollback-baseline.py")
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.data = baseline.baseline()
        d = self.data
        self.record = {"id": d["run"], "run_attempt": d["attempt"], "status": "completed", "conclusion": "success",
                       "event": "push", "path": ".github/workflows/docker.yml", "head_branch": "v" + d["version"],
                       "head_sha": d["source"], "repository": {"full_name": baseline.REPO},
                       "head_repository": {"full_name": baseline.REPO}}
        self.verified = [{"verificationResult": {"signature": {"certificate": {"runInvocationURI":
                         f"https://github.com/{baseline.REPO}/actions/runs/{d['run']}/attempts/{d['attempt']}"}},
                         "statement": {"subject": [{"name": baseline.IMAGE, "digest": {"sha256": d['digest'].split(':')[1]}}]}}}]

    def test_reviewed_record_requires_exact_version_digest_source_run_attempt_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollback.json"
            for key, value in (("version", "latest"), ("version", "4.0.0"), ("digest", "sha256:bad"),
                               ("source", "main"), ("run", True), ("attempt", 0), ("store_contract", "new-store")):
                path.write_text(json.dumps(dict(self.data, **{key: value})))
                with self.subTest(key=key), self.assertRaises(baseline.Refused):
                    baseline.baseline(path)

    def test_exact_run_is_bound_to_the_verified_certificate_and_subject(self):
        with patch.object(baseline, "command", side_effect=[self.record, self.verified]) as command:
            baseline.verify(self.data)
        for flag in ("--source-digest", "--source-ref", "--deny-self-hosted-runners", "--signer-workflow"):
            self.assertIn(flag, command.call_args.args)

    def test_red_fork_wrong_tag_source_or_attempt_cannot_become_baseline(self):
        for field, value in (("status", "in_progress"), ("conclusion", "failure"), ("event", "pull_request"),
                             ("head_branch", "main"), ("head_sha", "a" * 40), ("run_attempt", 2),
                             ("head_repository", {"full_name": "fork/docdrop"})):
            with self.subTest(field=field), patch.object(baseline, "command", return_value=dict(self.record, **{field: value})):
                with self.assertRaises(baseline.Refused):
                    baseline.verify(self.data)

    def test_free_predicate_cannot_replace_the_exact_certificate_invocation(self):
        bad = copy.deepcopy(self.verified)
        result = bad[0]["verificationResult"]
        result["statement"]["predicate"] = {"invocationId": result["signature"]["certificate"]["runInvocationURI"]}
        result["signature"]["certificate"]["runInvocationURI"] += "0"
        with patch.object(baseline, "command", side_effect=[self.record, bad]), self.assertRaises(baseline.Refused):
            baseline.verify(self.data)

    def test_another_signed_digest_cannot_pass(self):
        bad = copy.deepcopy(self.verified)
        bad[0]["verificationResult"]["statement"]["subject"][0]["digest"]["sha256"] = "a" * 64
        with patch.object(baseline, "command", side_effect=[self.record, bad]), self.assertRaises(baseline.Refused):
            baseline.verify(self.data)
