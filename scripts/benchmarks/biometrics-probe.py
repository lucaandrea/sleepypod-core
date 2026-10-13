"""Independent, read-only loopback telemetry probe around a benchmark command.

Usage: python3 biometrics-probe.py OUTPUT.json COMMAND [ARG ...]
Never retains response bodies or sensor samples.
"""
import json
import os
import signal
import pathlib
import subprocess
import sys
import threading
import time
import urllib.request

samples = []
phase = "baseline"
stop = threading.Event()
benchmark_pid = None


def process_tree_memory(root_pid):
    if root_pid is None:
        return 0, 0
    processes = {}
    for path in pathlib.Path('/proc').glob('[0-9]*/status'):
        try:
            fields = dict(line.split(':', 1) for line in path.read_text().splitlines() if ':' in line)
            processes[int(path.parent.name)] = (int(fields['PPid']), int(fields.get('VmRSS', '0 kB').split()[0]))
        except (OSError, ValueError, KeyError):
            continue
    selected = {root_pid}
    while True:
        children = {pid for pid, (parent, _) in processes.items() if parent in selected}
        if children <= selected:
            break
        selected |= children
    return sum(processes.get(pid, (0, 0))[1] for pid in selected), len(selected & processes.keys())


def sample():
    while not stop.is_set():
        row = {"phase": phase, "at": time.monotonic()}
        cpu = list(map(int, pathlib.Path("/proc/stat").read_text().splitlines()[0].split()[1:]))
        row["cpuTotal"] = sum(cpu[:8])
        row["cpuIdle"] = cpu[3] + cpu[4]
        row['benchmarkTreeRssKiB'], row['benchmarkProcessCount'] = process_tree_memory(benchmark_pid)
        memory = pathlib.Path('/proc/meminfo').read_text().splitlines()
        row['memAvailableKiB'] = int(next(line.split()[1] for line in memory if line.startswith('MemAvailable:')))
        row['temperatureC'] = int(pathlib.Path('/sys/class/thermal/thermal_zone0/temp').read_text()) / 1000
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
timeout_seconds = int(os.environ.get('BIOMETRICS_BENCHMARK_TIMEOUT_SECONDS', '600'))
if not 1 <= timeout_seconds <= 10800:
    raise SystemExit('Benchmark timeout must be between 1 and 10800 seconds')
thread = threading.Thread(target=sample)
thread.start()
try:
    time.sleep(4)
    phase = "benchmark"
    result = subprocess.Popen(sys.argv[2:], start_new_session=True)
    benchmark_pid = result.pid
    try:
        result.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        os.killpg(result.pid, signal.SIGKILL)
        result.wait()
    benchmark_pid = None
    phase = "after"
    time.sleep(3)
finally:
    stop.set()
    thread.join()
    pathlib.Path(sys.argv[1]).write_text(json.dumps({"version": "read-only-biometric-probe-v2", "timeoutSeconds": timeout_seconds, "samples": samples}, indent=2))
raise SystemExit(result.returncode)
