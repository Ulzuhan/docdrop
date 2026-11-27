"""Prove the synthetic OCI rehearsal never proceeds after uncertain teardown."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "test-compatibilidad.sh"


class WriterGuardTests(unittest.TestCase):
    def check_rehearsal(self, uncertainty):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = root / "bin"
            tools.mkdir()
            scripts = root / "scripts"
            scripts.mkdir()
            shutil.copyfile(SCRIPT, scripts / SCRIPT.name)
            (scripts / "test-compatibilidad.mjs").touch()
            stubs = {
                "curl": "exit 0",
                "ss": '[ "$UNCERTAINTY" != socket-unknown ]',
                "node": """if [ "$2" = comprobar-go ]; then
  for i in {1..20}; do grep -Fxq candidate-started "$TRACE" && break; sleep 0.05; done
  grep -Fxq candidate-started "$TRACE" || exit 98
fi
echo "$2" >> "$TRACE" """,
                "candidate": 'echo candidate-started >> "$TRACE"; exit 0',
                "docker": """case "$1" in
  run) exit 0;;
  rm) [ "$UNCERTAINTY" != failed-remove ];;
  ps)
     if [ "$UNCERTAINTY" = candidate-still-present ] && grep -Fxq candidate-started "$TRACE"; then
          printf '%s\n' "$DOCDROP_CONTENEDOR"
     fi;;
  *) exit 97;;
esac""",
            }
            for name, body in stubs.items():
                path = tools / name
                path.write_text("#!/bin/bash\n" + body + "\n")
                path.chmod(0o755)
            sandbox = root / "scratch"
            sandbox.mkdir()
            events = root / "events"
            env = dict(os.environ, PATH=f"{tools}:/usr/bin:/bin",
                       TMPDIR=str(sandbox), TRACE=str(events),
                       UNCERTAINTY=uncertainty, DOCDROP_ROLLBACK_ESTRICTO="1",
                       DOCDROP_TEST_LAUNCH=str(tools / "candidate"))
            result = subprocess.run(["bash", str(scripts / SCRIPT.name)], cwd=root,
                                    env=env, capture_output=True, text=True, timeout=10)
            return result, events.read_text().splitlines()

    def test_guarded_success_runs_all_stages(self):
        result, stages = self.check_rehearsal("none")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(stages, ["sembrar-node", "candidate-started",
                                  "comprobar-go", "comprobar-node"])

    def test_stop_failure_refuses_to_start_another_writer(self):
        for case in ("failed-remove", "candidate-still-present", "socket-unknown"):
            with self.subTest(case=case):
                result, stages = self.check_rehearsal(case)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                expected = ["sembrar-node"]
                if case == "candidate-still-present":
                    expected += ["candidate-started", "comprobar-go"]
                self.assertEqual(stages, expected)


if __name__ == "__main__":
    unittest.main()
