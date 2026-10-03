#!/usr/bin/env python3
"""Verifica/carga/copia el mismo layout OCI. Nunca construye una imagen."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

REPOSITORY = "ghcr.io/ulzuhan/docdrop"
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
ROLLBACK = REPOSITORY + "@sha256:3d6842182751552f24668cf280c0e553bf3b8cd9d798588cdac88906f6c22378"


class Refused(RuntimeError):
    pass


def command(*args):
    result = subprocess.run(args, capture_output=True, timeout=300)
    if result.returncode:
        raise Refused(f"{args[0]} failed")
    return result.stdout


def blob(layout, descriptor):
    digest = descriptor.get("digest", "")
    if not DIGEST.fullmatch(digest) or descriptor.get("urls"):
        raise Refused("invalid/external OCI descriptor")
    path = layout / "blobs/sha256" / digest.split(":")[1]
    if path.is_symlink() or not path.is_file():
        raise Refused("missing/symlink OCI blob")
    data = path.read_bytes()
    if len(data) != descriptor.get("size") or "sha256:" + hashlib.sha256(data).hexdigest() != digest:
        raise Refused("OCI blob bytes do not match their descriptor")
    return data


def verify(layout, expected, source):
    if not DIGEST.fullmatch(expected) or not re.fullmatch(r"[a-f0-9]{40}", source):
        raise Refused("exact digest and source SHA required")
    if layout.is_symlink() or not layout.is_dir():
        raise Refused("layout directory required")
    raw = command("skopeo", "inspect", "--raw", "oci:" + str(layout))
    if "sha256:" + hashlib.sha256(raw).hexdigest() != expected:
        raise Refused("layout root differs from the gated BuildKit digest")
    root = json.loads(raw)
    if root.get("mediaType") != "application/vnd.oci.image.index.v1+json":
        raise Refused("OCI index with provenance/SBOM required")
    runtimes = []
    attestations = 0
    predicates = set()
    for descriptor in root["manifests"]:
        manifest = json.loads(blob(layout, descriptor))
        config = json.loads(blob(layout, manifest["config"]))
        for layer in manifest["layers"]:
            blob(layout, layer)
        if descriptor.get("platform") == {"architecture": "amd64", "os": "linux"}:
            runtimes.append((manifest["config"]["digest"], config))
        elif descriptor.get("annotations", {}).get("vnd.docker.reference.type") == "attestation-manifest":
            attestations += 1
            for layer in manifest["layers"]:
                predicates.add(json.loads(blob(layout, layer)).get("predicateType", ""))
        else:
            raise Refused("unexpected executable platform in OCI index")
    if (len(runtimes) != 1 or not attestations or "https://spdx.dev/Document" not in predicates
            or not any(value.startswith("https://slsa.dev/provenance/") for value in predicates)):
        raise Refused("one linux/amd64 runtime, provenance and SBOM required")
    image_id, config = runtimes[0]
    labels = config.get("config", {}).get("Labels", {})
    if (config.get("architecture") != "amd64" or config.get("os") != "linux"
            or labels.get("org.opencontainers.image.revision") != source
            or labels.get("io.kaicorp.docdrop.store-contract") != "go-json-v1"
            or labels.get("io.kaicorp.docdrop.rollback-image") != ROLLBACK):
        raise Refused("runtime provenance/rollback contract labels differ")
    return image_id


def copy(layout, expected, tag):
    auth = Path(os.environ.get("DOCKER_CONFIG", str(Path.home() / ".docker"))) / "config.json"
    if not auth.is_file():
        raise Refused("existing Docker registry login required")
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "digest"
        command("skopeo", "copy", "--all", "--preserve-digests", "--authfile", str(auth),
                "--digestfile", str(output), "oci:" + str(layout), "docker://" + REPOSITORY + ":" + tag)
        if output.read_text().strip() != expected:
            raise Refused("registry copy changed the gated digest")


def publication_context():
    match = re.fullmatch(r"refs/tags/v(\d+\.\d+\.\d+)", os.environ.get("GITHUB_REF", ""))
    if (not match or os.environ.get("GITHUB_EVENT_NAME") != "push"
            or os.environ.get("GITHUB_REPOSITORY") != "Ulzuhan/docdrop"):
        raise Refused("publication only from a stable tag push in Ulzuhan/docdrop")
    return match[1]


def immutable_version(version, expected):
    auth = Path(os.environ.get("DOCKER_CONFIG", str(Path.home() / ".docker"))) / "config.json"
    result = subprocess.run(["skopeo", "inspect", "--authfile", str(auth), "--raw", "docker://" + REPOSITORY + ":" + version],
                            capture_output=True, timeout=60)
    if result.returncode:
        # Auth/network errors must not masquerade as an absent version.
        if b"manifest unknown" not in result.stderr.lower():
            raise Refused("cannot establish whether release tag already exists")
    elif "sha256:" + hashlib.sha256(result.stdout).hexdigest() != expected:
        raise Refused("stable release tag already points to a different digest")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("verify", "load", "candidate", "promote"))
    parser.add_argument("--layout", required=True, type=Path)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--source", required=True)
    args = parser.parse_args()
    image_id = verify(args.layout, args.digest, args.source)
    if args.action == "load":
        # The daemon cannot preserve the index/attestations. Execute its exact
        # config ID and verify it against the hashed runtime inside that index.
        command("skopeo", "--override-os", "linux", "--override-arch", "amd64", "copy",
                "oci:" + str(args.layout), "docker-daemon:docdrop-go:ci")
        loaded = command("docker", "image", "inspect", "docdrop-go:ci", "--format", "{{.Id}}").decode().strip()
        if loaded != image_id:
            raise Refused("loaded runtime differs from the gated OCI config")
    elif args.action in ("candidate", "promote"):
        version = publication_context()
        immutable_version(version, args.digest)
        if args.action == "candidate":
            run_id = os.environ.get("GITHUB_RUN_ID", "")
            attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
            if not run_id.isdigit() or not attempt.isdigit():
                raise Refused("unique run/attempt required")
            copy(args.layout, args.digest, f"candidate-{run_id}-{attempt}")
        else:
            major, minor, _ = version.split(".")
            # Caller invokes promotion only after signed provenance verifies.
            for tag in (version, f"{major}.{minor}", major, "latest"):
                copy(args.layout, args.digest, tag)
    print(image_id)


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        print(str(exc) if isinstance(exc, Refused) else type(exc).__name__, file=sys.stderr)
        sys.exit(1)
