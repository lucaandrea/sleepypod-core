"""Independent, read-only loopback telemetry probe around a benchmark command.

Usage: python3 biometrics-probe.py OUTPUT.json COMMAND [ARG ...]
Never retains response bodies or sensor samples.
"""
import json
import pathlib
import subprocess
import sys
import threading
import time
import urllib.request

samples = []
phase = "baseline"
stop = threading.Event()


def sample():
    while not stop.is_set():
        row = {"phase": phase, "at": time.monotonic()}
        cpu = list(map(int, pathlib.Path("/proc/stat").read_text().splitlines()[0].split()[1:]))
        row["cpuTotal"] = sum(cpu[:8])
        row["cpuIdle"] = cpu[3] + cpu[4]
        for endpoint in ["health/performance", "system/sensor-source", "device/status"]:
            began = time.monotonic()
            try:
                with urllib.request.urlopen("http://127.0.0.1:3000/api/" + endpoint, timeout=2) as response:
                    response.read()
                    status = response.status
                row[endpoint] = {"ms": (time.monotonic() - began) * 1000, "status": status}
            except Exception as error:
                row[endpoint] = {"ms": (time.monotonic() - began) * 1000, "error": type(error).__name__}
        samples.append(row)
        stop.wait(0.25)


if len(sys.argv) < 3:
    raise SystemExit("OUTPUT.json COMMAND [ARG ...] required")
thread = threading.Thread(target=sample)
thread.start()
try:
    time.sleep(4)
    phase = "benchmark"
    result = subprocess.run(sys.argv[2:], timeout=600, check=False)
    phase = "after"
    time.sleep(3)
finally:
    stop.set()
    thread.join()
    pathlib.Path(sys.argv[1]).write_text(json.dumps({"samples": samples}, indent=2))
raise SystemExit(result.returncode)
