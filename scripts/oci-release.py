#!/usr/bin/env python3
"""Verifica/carga/mezcla/copia el mismo layout OCI. Nunca construye una imagen."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

REPOSITORY = "ghcr.io/ulzuhan/docdrop"
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
HEX = re.compile(r"[a-f0-9]{64}")
SUPPORTED_ARCHES = ("amd64", "arm64")
SPEC = importlib.util.spec_from_file_location("rollback_baseline", Path(__file__).with_name("rollback-baseline.py"))
rollback_baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollback_baseline)
ROLLBACK = rollback_baseline.image()


class Refused(RuntimeError):
    pass


def command(*args):
    result = subprocess.run(args, capture_output=True, timeout=300)
    if result.returncode:
        raise Refused(f"{args[0]} failed")
    return result.stdout


def parse_arches(value):
    if value == "multi":
        return SUPPORTED_ARCHES
    if value in SUPPORTED_ARCHES:
        return (value,)
    raise Refused(f"unsupported architecture selector: {value}")


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


def _copy_blob(src_layout, dst_layout, descriptor):
    data = blob(src_layout, descriptor)
    hex_digest = descriptor["digest"].split(":")[1]
    if not HEX.fullmatch(hex_digest):
        raise Refused("invalid blob digest")
    dst = dst_layout / "blobs/sha256" / hex_digest
    if dst.is_symlink():
        raise Refused("symlink destination blob refused")
    if dst.exists():
        if not dst.is_file() or dst.read_bytes() != data:
            raise Refused("conflicting blob contents in target layout")
    else:
        dst.write_bytes(data)
    return data


def _read_root(layout, expected):
    if not DIGEST.fullmatch(expected):
        raise Refused("exact digest required")
    if layout.is_symlink() or not layout.is_dir():
        raise Refused("layout directory required")
    raw = command("skopeo", "inspect", "--raw", "oci:" + str(layout))
    if "sha256:" + hashlib.sha256(raw).hexdigest() != expected:
        raise Refused("layout root differs from the gated BuildKit digest")
    root = json.loads(raw)
    if root.get("mediaType") != "application/vnd.oci.image.index.v1+json":
        raise Refused("OCI index with provenance/SBOM required")
    return root


def verify(layout, expected, source, expected_arches=SUPPORTED_ARCHES):
    if not expected_arches or any(a not in SUPPORTED_ARCHES for a in expected_arches):
        raise Refused("unsupported target architecture set")
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise Refused("exact source SHA required")
    root = _read_root(layout, expected)
    runtimes = {}
    all_predicates = set()
    attestations = 0
    attestation_by_ref = {}
    for descriptor in root["manifests"]:
        manifest = json.loads(blob(layout, descriptor))
        config = json.loads(blob(layout, manifest["config"]))
        for layer in manifest["layers"]:
            blob(layout, layer)
        platform = descriptor.get("platform") or {}
        arch = platform.get("architecture")
        if platform.get("os") == "linux" and arch in expected_arches:
            if arch in runtimes:
                raise Refused(f"duplicate runtime for linux/{arch}")
            runtimes[arch] = (descriptor["digest"], manifest["config"]["digest"], config)
        elif descriptor.get("annotations", {}).get("vnd.docker.reference.type") == "attestation-manifest":
            attestations += 1
            preds = {json.loads(blob(layout, layer)).get("predicateType", "") for layer in manifest["layers"]}
            all_predicates.update(preds)
            ref_digest = descriptor.get("annotations", {}).get("vnd.docker.reference.digest")
            if ref_digest:
                attestation_by_ref.setdefault(ref_digest, set()).update(preds)
        else:
            raise Refused("unexpected executable platform in OCI index")
    if (set(runtimes) != set(expected_arches) or attestations < len(expected_arches)
            or "https://spdx.dev/Document" not in all_predicates
            or not any(value.startswith("https://slsa.dev/provenance/") for value in all_predicates)):
        raise Refused(f"expected runtimes for {','.join(expected_arches)}, provenance and SBOM required")
    if attestation_by_ref:
        for manifest_digest, _, _ in runtimes.values():
            preds = attestation_by_ref.get(manifest_digest, set())
            if ("https://spdx.dev/Document" not in preds
                    or not any(value.startswith("https://slsa.dev/provenance/") for value in preds)):
                raise Refused(f"missing attestation reference for runtime {manifest_digest}")
    image_ids = []
    for arch in expected_arches:
        _, image_id, config = runtimes[arch]
        labels = config.get("config", {}).get("Labels", {})
        if (config.get("architecture") != arch or config.get("os") != "linux"
                or labels.get("org.opencontainers.image.revision") != source
                or labels.get("io.kaicorp.docdrop.store-contract") != "go-json-v1"
                or labels.get("io.kaicorp.docdrop.rollback-image") != ROLLBACK):
            raise Refused("runtime provenance/rollback contract labels differ")
        image_ids.append(image_id)
    return image_ids[0] if len(image_ids) == 1 else ",".join(image_ids)


def merge(amd64_layout, amd64_digest, arm64_layout, arm64_digest, source, out_layout):
    verify(amd64_layout, amd64_digest, source, expected_arches=("amd64",))
    verify(arm64_layout, arm64_digest, source, expected_arches=("arm64",))
    amd64_root = _read_root(amd64_layout, amd64_digest)
    arm64_root = _read_root(arm64_layout, arm64_digest)
    if out_layout.is_symlink():
        raise Refused("output layout cannot be a symlink")
    (out_layout / "blobs/sha256").mkdir(parents=True, exist_ok=True)
    for src_layout, root in ((amd64_layout, amd64_root), (arm64_layout, arm64_root)):
        for descriptor in root["manifests"]:
            manifest = json.loads(_copy_blob(src_layout, out_layout, descriptor))
            _copy_blob(src_layout, out_layout, manifest["config"])
            for layer in manifest["layers"]:
                _copy_blob(src_layout, out_layout, layer)
    merged_root = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": amd64_root["manifests"] + arm64_root["manifests"],
    }
    merged_bytes = json.dumps(merged_root, separators=(",", ":")).encode()
    merged_hex = hashlib.sha256(merged_bytes).hexdigest()
    merged_digest = "sha256:" + merged_hex
    (out_layout / "blobs/sha256" / merged_hex).write_bytes(merged_bytes)
    (out_layout / "oci-layout").write_text('{"imageLayoutVersion":"1.0.0"}\n')
    top_descriptor = {
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "digest": merged_digest,
        "size": len(merged_bytes),
    }
    src_index = amd64_layout / "index.json"
    if src_index.is_file() and not src_index.is_symlink():
        parsed_index = json.loads(src_index.read_text())
        first = (parsed_index.get("manifests") or [{}])[0]
        if isinstance(first, dict) and first.get("annotations"):
            top_descriptor["annotations"] = first["annotations"]
    (out_layout / "index.json").write_text(json.dumps({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [top_descriptor],
    }))
    verify(out_layout, merged_digest, source, expected_arches=SUPPORTED_ARCHES)
    return merged_digest


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
    parser.add_argument("action", choices=("verify", "load", "candidate", "promote", "merge"))
    parser.add_argument("--layout", type=Path)
    parser.add_argument("--digest")
    parser.add_argument("--source")
    parser.add_argument("--arch", choices=("amd64", "arm64", "multi"))
    parser.add_argument("--amd64-layout", type=Path)
    parser.add_argument("--amd64-digest")
    parser.add_argument("--arm64-layout", type=Path)
    parser.add_argument("--arm64-digest")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.action == "merge":
        if not all((args.amd64_layout, args.amd64_digest, args.arm64_layout, args.arm64_digest, args.source, args.out)):
            raise Refused("merge requires amd64/arm64 layouts and digests, source, and out")
        print(merge(args.amd64_layout, args.amd64_digest, args.arm64_layout, args.arm64_digest, args.source, args.out))
        return
    if not args.layout or not args.digest or not args.source:
        raise Refused("--layout, --digest, and --source are required")
    if args.action == "load":
        arch = args.arch or "amd64"
        if arch == "multi":
            raise Refused("single arch required for load")
        image_id = verify(args.layout, args.digest, args.source, expected_arches=(arch,))
        # The daemon cannot preserve the index/attestations. Execute its exact
        # config ID and verify it against the hashed runtime inside that index.
        command("skopeo", "--override-os", "linux", "--override-arch", arch, "copy",
                "oci:" + str(args.layout), "docker-daemon:docdrop-go:ci")
        loaded = command("docker", "image", "inspect", "docdrop-go:ci", "--format", "{{.Id}}").decode().strip()
        if loaded != image_id:
            raise Refused("loaded runtime differs from the gated OCI config")
        print(image_id)
        return
    arch_sel = args.arch or "multi"
    if args.action in ("candidate", "promote") and arch_sel != "multi":
        raise Refused("multi-arch index required for publication")
    image_id = verify(args.layout, args.digest, args.source, expected_arches=parse_arches(arch_sel))
    if args.action in ("candidate", "promote"):
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
