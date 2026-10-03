"""Synthetic OCI graphs and mocked copiers; no Docker, registry or credentials."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("oci", Path(__file__).parents[1] / "oci-release.py")
oci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oci)
SOURCE = "b" * 40


class OCITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.layout = Path(self.tmp.name)
        (self.layout / "blobs/sha256").mkdir(parents=True)
        labels = {"org.opencontainers.image.revision": SOURCE, "io.kaicorp.docdrop.store-contract": "go-json-v1",
                  "io.kaicorp.docdrop.rollback-image": oci.ROLLBACK}
        self.config = self.put({"architecture": "amd64", "os": "linux", "config": {"Labels": labels}})
        layer = self.put(b"synthetic layer")
        runtime = self.put({"config": self.config, "layers": [layer]})
        attestation = self.put({"config": self.put({}), "layers": [
            self.put({"predicateType": "https://slsa.dev/provenance/v0.2"}),
            self.put({"predicateType": "https://spdx.dev/Document"})]})
        runtime["platform"] = {"architecture": "amd64", "os": "linux"}
        attestation["platform"] = {"architecture": "unknown", "os": "unknown"}
        attestation["annotations"] = {"vnd.docker.reference.type": "attestation-manifest"}
        self.root = {"mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [runtime, attestation]}

    def put(self, value):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        digest = hashlib.sha256(data).hexdigest()
        (self.layout / "blobs/sha256" / digest).write_bytes(data)
        return {"digest": "sha256:" + digest, "size": len(data)}

    def verify(self, root=None, expected=None, source=SOURCE):
        raw = json.dumps(root or self.root).encode()
        with patch.object(oci, "command", return_value=raw):
            return oci.verify(self.layout, expected or "sha256:" + hashlib.sha256(raw).hexdigest(), source)

    def test_valid_graph_returns_exact_runtime_config_id(self):
        self.assertEqual(self.verify(), self.config["digest"])

    def test_wrong_root_source_or_layer_cannot_pass(self):
        with self.assertRaises(oci.Refused):
            self.verify(expected="sha256:" + "a" * 64)
        with self.assertRaises(oci.Refused):
            self.verify(source="a" * 40)
        path = self.layout / "blobs/sha256" / self.config["digest"].split(":")[1]
        path.write_bytes(b"different bytes")
        with self.assertRaises(oci.Refused):
            self.verify()

    def test_extra_platform_or_missing_attestations_cannot_pass(self):
        root = copy.deepcopy(self.root)
        root["manifests"].append(copy.deepcopy(root["manifests"][0]))
        root["manifests"][-1]["platform"]["architecture"] = "arm64"
        with self.assertRaises(oci.Refused):
            self.verify(root)
        root = copy.deepcopy(self.root)
        root["manifests"].pop()
        with self.assertRaises(oci.Refused):
            self.verify(root)

    def test_external_descriptors_and_symlinks_are_rejected(self):
        descriptor = dict(self.config, urls=["https://example.invalid/config"])
        with self.assertRaises(oci.Refused):
            oci.blob(self.layout, descriptor)
        path = self.layout / "blobs/sha256" / self.config["digest"].split(":")[1]
        path.unlink()
        path.symlink_to(self.layout / "missing")
        with self.assertRaises(oci.Refused):
            oci.blob(self.layout, self.config)

    def test_publication_is_impossible_from_pr_main_dispatch_or_fork(self):
        good = {"GITHUB_REF": "refs/tags/v3.1.1", "GITHUB_EVENT_NAME": "push", "GITHUB_REPOSITORY": "Ulzuhan/docdrop"}
        with patch.dict(os.environ, good, clear=True):
            self.assertEqual(oci.publication_context(), "3.1.1")
        for key, value in (("GITHUB_REF", "refs/heads/main"), ("GITHUB_EVENT_NAME", "pull_request"),
                           ("GITHUB_EVENT_NAME", "workflow_dispatch"), ("GITHUB_REPOSITORY", "fork/docdrop")):
            with patch.dict(os.environ, dict(good, **{key: value}), clear=True):
                with self.assertRaises(oci.Refused):
                    oci.publication_context()

    def test_release_version_cannot_be_retagged_and_network_error_is_closed(self):
        expected = "sha256:" + hashlib.sha256(b"existing").hexdigest()
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"existing", b"")):
            oci.immutable_version("3.1.1", expected)
            with self.assertRaises(oci.Refused):
                oci.immutable_version("3.1.1", "sha256:" + "a" * 64)
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"", b"network failed")):
            with self.assertRaises(oci.Refused):
                oci.immutable_version("3.1.1", expected)
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"", b"manifest unknown")):
            oci.immutable_version("3.1.1", expected)

    def test_copy_uses_all_preserves_digest_and_rejects_changed_copy(self):
        authdir = self.layout / "auth"
        authdir.mkdir()
        (authdir / "config.json").write_text("{}")
        expected = "sha256:" + "c" * 64
        def copier(*args):
            self.assertIn("--all", args)
            self.assertIn("--preserve-digests", args)
            self.assertNotIn("--dest-creds", args)
            self.assertEqual(args[-2:], ("oci:" + str(self.layout), "docker://ghcr.io/ulzuhan/docdrop:3.1.1"))
            Path(args[args.index("--digestfile") + 1]).write_text(expected)
            return b""
        with patch.dict(os.environ, {"DOCKER_CONFIG": str(authdir)}), patch.object(oci, "command", side_effect=copier):
            oci.copy(self.layout, expected, "3.1.1")
        def changed(*args):
            Path(args[args.index("--digestfile") + 1]).write_text("sha256:" + "a" * 64)
            return b""
        with patch.dict(os.environ, {"DOCKER_CONFIG": str(authdir)}), patch.object(oci, "command", side_effect=changed):
            with self.assertRaises(oci.Refused):
                oci.copy(self.layout, expected, "3.1.1")


if __name__ == "__main__":
    unittest.main()
