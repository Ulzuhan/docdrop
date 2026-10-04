#!/usr/bin/env python3
"""Reviewed rollback pair, verified against the exact successful signed release."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

REPO = "Ulzuhan/docdrop"
IMAGE = "ghcr.io/ulzuhan/docdrop"
CONFIG = Path(__file__).resolve().parents[1] / "release/rollback.json"


class Refused(RuntimeError):
    pass


def baseline(path=CONFIG):
    data = json.loads(path.read_text())
    if (set(data) != {"version", "digest", "source", "run", "attempt", "store_contract"}
            or not re.fullmatch(r"3\.\d+\.\d+", data.get("version", ""))
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", data.get("digest", ""))
            or not re.fullmatch(r"[a-f0-9]{40}", data.get("source", ""))
            or type(data.get("run")) is not int or data["run"] < 1
            or type(data.get("attempt")) is not int or data["attempt"] < 1
            or data.get("store_contract") != "go-json-v1"):
        raise Refused("exact reviewed 3.x rollback release required")
    return data


def image(path=CONFIG):
    return IMAGE + "@" + baseline(path)["digest"]


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise Refused(f"{args[0]} {args[1]} failed")
    return json.loads(result.stdout)


def verify(data):
    record = command("gh", "api", f"repos/{REPO}/actions/runs/{data['run']}")
    if (record.get("id") != data["run"] or record.get("run_attempt") != data["attempt"]
            or record.get("status") != "completed" or record.get("conclusion") != "success"
            or record.get("event") != "push" or record.get("path") != ".github/workflows/docker.yml"
            or record.get("head_branch") != "v" + data["version"] or record.get("head_sha") != data["source"]
            or record.get("repository", {}).get("full_name") != REPO
            or record.get("head_repository", {}).get("full_name") != REPO):
        raise Refused("rollback run/source/tag/attempt is not the reviewed successful release")
    verified = command("gh", "attestation", "verify", "oci://" + IMAGE + "@" + data["digest"],
                       "--repo", REPO, "--signer-workflow", REPO + "/.github/workflows/docker.yml",
                       "--source-digest", data["source"], "--source-ref", "refs/tags/v" + data["version"],
                       "--deny-self-hosted-runners", "--format", "json")
    uri = f"https://github.com/{REPO}/actions/runs/{data['run']}/attempts/{data['attempt']}"
    for entry in verified:
        result = entry.get("verificationResult", {})
        certificate = result.get("signature", {}).get("certificate", {})
        if certificate.get("runInvocationURI") == uri and any(
                s.get("name") == IMAGE and s.get("digest", {}).get("sha256") == data["digest"].split(":")[1]
                for s in result.get("statement", {}).get("subject", [])):
            return
    raise Refused("rollback signed by another run/attempt")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("image", "verify"))
    args = parser.parse_args()
    data = baseline()
    if args.action == "verify":
        verify(data)
    print(image())


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, ValueError, TypeError, subprocess.TimeoutExpired) as error:
        print(str(error) if isinstance(error, Refused) else type(error).__name__, file=sys.stderr)
        sys.exit(1)
