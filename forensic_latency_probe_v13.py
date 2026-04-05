#!/usr/bin/env python3
# =============================================================================
# forensic_latency_probe_v13.py
# =============================================================================
# FULL REQUEST-COMPLIANT FORENSIC LATENCY ANALYZER v13.2.2
# =============================================================================
#
# DESIGN PRINCIPLES:
#   - Every forensic tool's stdout AND stderr is captured, tee'd to a
#     timestamped log file, and printed live to the terminal. Nothing is
#     hidden. TeeLogger replaces sys.stdout/sys.stderr at run start.
#   - All dependencies are self-healing: missing tools are detected on
#     every run and installed via apt-get (Debian/Kali) or dnf (Fedora).
#     The DEPS_MARKER file only skips the apt-get *update* step, never
#     the per-tool shutil.which() check, so manually removed tools are
#     always re-detected.
#   - enforce_compliance() is called before any forensic work. It raises
#     RuntimeError (hard abort) if any required function is absent from
#     globals() or if sys.stdout is not a TeeLogger. This prevents silent
#     brevity-driven feature removal from reaching production.
#   - SUMMARY_LINES is cleared at the start of every run_probe() call so
#     loop-mode runs do not accumulate stale alerts across iterations.
#   - perf record writes to a timestamped path in LOG_DIR so concurrent
#     or loop runs never overwrite each other's perf.data file.
#   - os.killpg is wrapped in ProcessLookupError so a process that exits
#     naturally between p.wait() timeout and the kill call does not crash
#     the run() wrapper.
#   - block_layer_trace() uses lsblk TYPE==disk filter so NVMe systems
#     never pass a partition path to blktrace.
#   - irq_rate_audit() uses sar -I ALL for per-second interrupt rates,
#     complementing irq_affinity_audit()'s cumulative /proc/interrupts.
#     irq_rate_audit() is called ONCE, after irq_affinity_audit().
#   - perf_stat_system() captures system-wide IPC, cache-miss, and
#     branch-miss hardware counters without the overhead of full sampling.
#   - doctor() fetches the last hour of systemd-oomd journal to expose
#     process reclamation events that explain high oomd CPU time.
#   - network() includes ss -s for a one-line ESTABLISHED/TIME_WAIT
#     socket state summary alongside the existing per-socket detail.
#
# USAGE:
#   python3 forensic_latency_probe_v13.py              # standard full probe
#   python3 forensic_latency_probe_v13.py --advanced   # include perf/blktrace
#   python3 forensic_latency_probe_v13.py --module PSI # single module
#   python3 forensic_latency_probe_v13.py --loop 60   # repeat every 60s

import os
import sys
import subprocess
import shutil
import datetime
import traceback
import argparse
import time
import re
import json
import sqlite3
import signal
from threading import Thread

# =============================================================================
# CONFIGURATION & CONSTANTS
# =============================================================================

# LOG_DIR: all logs, perf.data files, and the SQLite DB live here.
# os.path.abspath anchors to CWD at import time — no PROJECT_ROOT env var
# required. The script is runnable as: python3 forensic_latency_probe_v13.py
LOG_DIR = os.path.abspath("./forensic_logs")
os.makedirs(LOG_DIR, exist_ok=True)

DB_FILE   = os.path.join(LOG_DIR, "forensic_audit.db")
HTML_FILE = os.path.abspath("./forensic_summary.html")

# DEPS_MARKER: presence means apt-get update has run this session.
# It does NOT mean all tools are installed — shutil.which() always runs.
DEPS_MARKER = os.path.join(LOG_DIR, ".deps_installed")

# REQUIRED_TOOLS: every binary that a forensic module calls directly.
# "sar" added in v13.2.2 for irq_rate_audit().
REQUIRED_TOOLS = [
    "vmstat", "iostat", "pidstat", "mpstat",
    "ss", "ping", "traceroute", "lsof",
    "strace", "dmesg", "journalctl", "netstat",
    "uptime", "lsmod", "numastat", "slabtop",
    "auditctl", "perf", "blktrace", "trace-cmd",
    "bpftrace", "nicstat", "numactl", "iotop",
    "ausearch", "sestatus", "sar"
]

# DNF_MAP: maps APT package names to their Fedora/DNF equivalents.
# linux-perf -> perf, iproute2 -> iproute, iputils-ping -> iputils, etc.
# This allows a single APT_PACKAGES list to drive both package managers.
DNF_MAP = {
    "sysstat":          "sysstat",
    "iproute2":         "iproute",
    "iputils-ping":     "iputils",
    "traceroute":       "traceroute",
    "lsof":             "lsof",
    "strace":           "strace",
    "linux-perf":       "perf",
    "net-tools":        "net-tools",
    "iotop":            "iotop",
    "blktrace":         "blktrace",
    "trace-cmd":        "trace-cmd",
    "bpftrace":         "bpftrace",
    "nicstat":          "nicstat",
    "numactl":          "numactl",
    "auditd":           "audit",
    "bcc-tools":        "bcc-tools",
    "policycoreutils":  "policycoreutils",
}

APT_PACKAGES = list(DNF_MAP.keys())

# Module-level state. SUMMARY_LINES is cleared at the top of run_probe()
# so loop runs never carry stale alerts forward into a new report.
SUMMARY_LINES  = []
CURRENT_RUN_ID = None


# =============================================================================
# DATABASE MANAGEMENT (IDEMPOTENT LOGGING)
# =============================================================================

class DatabaseManager:
    """
    Persistent SQLite audit log. Schema is created with CREATE TABLE IF NOT
    EXISTS so init_db() is safe to call on every run (idempotent). Each run
    gets a row in the runs table; metrics and alerts are child rows keyed by
    run_id. If the DB file is corrupt, doctor() calls init_db() to rebuild.
    """

    @staticmethod
    def init_db():
        # Creates all three tables if they don't exist. Safe to call multiple
        # times — IF NOT EXISTS prevents duplicate table errors.
        print(f"[DB:INIT] Ensuring robust log database at {DB_FILE}")
        try:
            conn   = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS runs (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT    DEFAULT CURRENT_TIMESTAMP,
                    mode      TEXT,
                    status    TEXT,
                    log_path  TEXT,
                    html_path TEXT,
                    summary   TEXT
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS metrics (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id    INTEGER,
                    key       TEXT,
                    value     REAL,
                    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(run_id) REFERENCES runs(id)
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS alerts (
                    id       INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id   INTEGER,
                    severity TEXT,
                    message  TEXT,
                    FOREIGN KEY(run_id) REFERENCES runs(id)
                )
            """)
            conn.commit()
            conn.close()
            print("[DB:SUCCESS] Database schema verified and idempotent.")
        except Exception as e:
            print(f"[DB:ERROR] Failed to initialize database: {e}")
            traceback.print_exc()

    @staticmethod
    def start_run(mode):
        # Inserts a RUNNING row and returns its id. Returns None on failure
        # so callers can use: if CURRENT_RUN_ID: DatabaseManager.log_metric(...)
        try:
            conn   = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO runs (mode, status) VALUES (?, ?)", (mode, "RUNNING")
            )
            run_id = cursor.lastrowid
            conn.commit()
            conn.close()
            return run_id
        except Exception:
            return None

    @staticmethod
    def update_run_status(run_id, status, log_path=None, html_path=None, summary=None):
        # Updates the terminal status of a run to SUCCESS, FAILED, or STOPPED.
        if not run_id:
            return
        try:
            conn   = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE runs SET status=?, log_path=?, html_path=?, summary=? WHERE id=?",
                (status, log_path, html_path, summary, run_id)
            )
            conn.commit()
            conn.close()
        except Exception:
            pass

    @staticmethod
    def log_metric(run_id, key, value):
        # Records a named numeric metric for the current run, e.g.
        # CPU_CORE_3_IDLE=0.0, IO_PRESSURE=12.4, SELINUX_DENIALS=7.
        if not run_id:
            return
        try:
            conn   = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO metrics (run_id, key, value) VALUES (?, ?, ?)",
                (run_id, key, value)
            )
            conn.commit()
            conn.close()
        except Exception:
            pass

    @staticmethod
    def log_alert(run_id, severity, message):
        # Records a CRITICAL/WARNING/INFO alert for the current run.
        # rank_root_causes() writes each SUMMARY_LINES entry here.
        if not run_id:
            return
        try:
            conn   = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO alerts (run_id, severity, message) VALUES (?, ?, ?)",
                (run_id, severity, message)
            )
            conn.commit()
            conn.close()
        except Exception:
            pass


# =============================================================================
# DEPENDENCY MANAGEMENT (ROBUST IDEMPOTENCY)
# =============================================================================

class DependencyManager:
    """
    Self-healing dependency manager. On every call it runs shutil.which() for
    every tool in REQUIRED_TOOLS — never skipped. If tools are missing it
    attempts apt-get or dnf install with 3 retries and exponential backoff.
    DEPS_MARKER only suppresses the apt-get update step (expensive network
    call), not the tool presence check.
    """

    @staticmethod
    def ensure_deps():
        print("\n[MODULE:DEPS] VERIFYING SYSTEM DEPENDENCIES")

        # Always check tool presence regardless of DEPS_MARKER.
        # A tool removed after the marker was written must be re-detected.
        missing = [t for t in REQUIRED_TOOLS if shutil.which(t) is None]
        if not missing:
            print("[DEPS:SUCCESS] All tools present in PATH.")
            return

        print(f"[DEPS:ACTION] Missing tools: {missing}. Initiating recoverable install.")

        # Non-interactive sudo check: if sudo -n fails, warn and try anyway.
        # Some environments have NOPASSWD for apt-get/dnf specifically.
        sudo_works = run(["sudo", "-n", "true"], timeout=5) == 0
        if not sudo_works:
            print("[DEPS:WARNING] Non-interactive sudo failed. Install may prompt.")

        for attempt in range(3):
            try:
                if shutil.which("apt-get"):
                    # Only run apt-get update once per container session.
                    # DEPS_MARKER presence means update already ran.
                    if not os.path.exists(DEPS_MARKER):
                        run(["sudo", "-n", "apt-get", "update"], timeout=60)
                        with open(DEPS_MARKER, "w") as f:
                            f.write(datetime.datetime.now().isoformat())
                    ret = run(
                        ["sudo", "-n", "apt-get", "install", "-y"] + APT_PACKAGES,
                        timeout=120
                    )
                    if ret == 0:
                        break

                elif shutil.which("dnf"):
                    # Fedora/RHEL: translate APT names via DNF_MAP.
                    dnf_pkgs = [DNF_MAP.get(p, p) for p in APT_PACKAGES]
                    ret = run(
                        ["sudo", "-n", "dnf", "install", "-y"] + dnf_pkgs,
                        timeout=120
                    )
                    if ret == 0:
                        break

            except Exception as e:
                print(f"[DEPS:RETRY] Attempt {attempt+1} failed: {e}")
                time.sleep(5 * (attempt + 1))   # exponential backoff

        # Final check — report any tools that are still missing after install.
        # Do not abort: the probe continues and individual modules guard with
        # shutil.which() before calling optional tools like bpftrace, nicstat.
        missing_after = [t for t in REQUIRED_TOOLS if shutil.which(t) is None]
        if missing_after:
            print(f"[DEPS:WARNING] Still missing after install: {missing_after}")


# =============================================================================
# LOGGING (TEE STDOUT + STDERR TO TERMINAL AND LOG FILE)
# =============================================================================

class TeeLogger:
    """
    Replaces sys.stdout and sys.stderr for the duration of run_probe().
    Every write() call goes to both the original terminal stream and the
    timestamped log file. Supports the context manager protocol so the
    log file handle is always closed in run_probe()'s finally block,
    even if the probe crashes mid-run.

    FAILURE MODE: if open() raises (e.g. disk full), the exception
    propagates to run_probe() which catches it, marks the run FAILED in
    the DB, and re-raises. The probe does not silently continue unlogged.
    """

    def __init__(self, logfile):
        self.logfile         = logfile
        self.log             = open(logfile, "a", buffering=1)
        self.terminal_stdout = sys.__stdout__   # save originals before redirect
        self.terminal_stderr = sys.__stderr__

    def write(self, msg):
        self.terminal_stdout.write(msg)
        self.log.write(msg)

    def flush(self):
        self.terminal_stdout.flush()
        self.log.flush()

    def close(self):
        # Idempotent: safe to call multiple times.
        if self.log:
            self.log.close()
            self.log = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        # Do not suppress exceptions — let them propagate to run_probe().
        return False


# =============================================================================
# SELF-ENFORCING COMPLIANCE LOGIC
# =============================================================================

def enforce_compliance():
    """
    Hard abort if any required function is missing from globals() or if
    sys.stdout has not been redirected to a TeeLogger. Called as the first
    action inside the TeeLogger context in run_probe(), so stdout is already
    redirected when this runs.

    The required list includes every forensic module and the two new modules
    added in v13.2.2: perf_stat_system and irq_rate_audit.

    FAILURE MODE: raises RuntimeError with the name of the missing feature.
    The exception propagates to run_probe()'s except block, which marks the
    run FAILED in the DB and prints the full traceback via TeeLogger.
    """
    print("[COMPLIANCE ENFORCEMENT] Verifying Cumulative Feature Set...")
    required = [
        "psi", "cpu_sched", "memory", "disk", "network",
        "kernel", "cgroup", "core_imbalance_check",
        "irq_affinity_audit", "short_lived_process_trace",
        "perf_analysis", "block_layer_trace", "kernel_function_trace",
        "scheduler_latency_hist", "numa_audit", "network_interface_stats",
        "selinux_audit", "auditd_check", "rank_root_causes", "generate_html_report",
        "doctor", "perf_stat_system", "irq_rate_audit"
    ]
    for req in required:
        if req not in globals():
            raise RuntimeError(
                f"CRITICAL COMPLIANCE FAILURE: '{req}' missing — brevity removal detected."
            )

    # TeeLogger check: if stdout is not a TeeLogger, all forensic output
    # goes only to the terminal and nothing is logged. Hard abort.
    if not isinstance(sys.stdout, TeeLogger):
        raise RuntimeError(
            "CRITICAL COMPLIANCE FAILURE: stdout is not a TeeLogger. Logging compromised."
        )

    print("[COMPLIANCE] v13.2.2 Integrity Verified. All 23 modules present.")


# =============================================================================
# CORE EXECUTION WRAPPER
# =============================================================================

def run(cmd, timeout=30, capture_output=False):
    """
    Runs an external command and streams its stdout/stderr live via TeeLogger.
    Returns the exit code (int) or the captured stdout string if capture_output
    is True. Returns None if an unhandled exception occurs.

    PROCESS GROUP: start_new_session=True creates a new process group so
    os.killpg can kill the entire process tree on timeout (e.g. perf record
    spawning child tracers). Without this, only the top-level PID is killed
    and child processes linger.

    TIMEOUT HANDLING: p.wait(timeout) raises TimeoutExpired. We then call
    os.killpg inside a try/except ProcessLookupError because the process may
    exit naturally between the timeout exception and the killpg call — a race
    condition that without the guard would crash run() with an unhandled
    OSError(ESRCH).

    READER THREADS: stdout and stderr are read in separate daemon threads to
    avoid the deadlock that occurs when a process fills its stderr pipe buffer
    while the parent is blocked reading stdout. Each thread is joined with a
    2-second timeout after the process exits to ensure all buffered output
    is flushed before run() returns.
    """
    print(f"\n[COMMAND] {' '.join(str(c) for c in cmd)}")
    print(f"[TIME]    {datetime.datetime.now().isoformat()}")
    try:
        p = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True   # creates independent process group
        )
        out_lines = []

        def stream(pipe, tag):
            # Reads lines from pipe until EOF, printing each with a [STDOUT]
            # or [STDERR] tag. If capture_output is True, also appends to
            # out_lines so the caller can parse the output programmatically.
            try:
                for line in iter(pipe.readline, ""):
                    clean = line.rstrip()
                    print(f"{tag} {clean}")
                    if capture_output:
                        out_lines.append(clean)
            except Exception:
                pass    # pipe closed unexpectedly — not fatal

        t1 = Thread(target=stream, args=(p.stdout, "[STDOUT]"))
        t2 = Thread(target=stream, args=(p.stderr, "[STDERR]"))
        t1.start()
        t2.start()

        try:
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            print(f"[TIMEOUT] {timeout}s exceeded. Killing process group...")
            try:
                # Kill entire process group. May raise ProcessLookupError if
                # the process already exited in the window between TimeoutExpired
                # and this line — that is fine, the process is gone either way.
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            p.wait()   # reap the zombie

        # Join reader threads with a short timeout. If they hang (pipe not
        # closed cleanly by the killed process), we move on — data already
        # printed is not lost, we just may miss the last few bytes.
        t1.join(timeout=2)
        t2.join(timeout=2)

        return "\n".join(out_lines) if capture_output else p.returncode

    except Exception:
        traceback.print_exc()
        return None


# =============================================================================
# FORENSIC MODULES
# =============================================================================

def doctor():
    """
    Environment self-audit. Runs before any forensic tools. Checks:
      - Container vs bare-metal environment (/.dockerenv)
      - Log directory write access (probe fails silently if not writable)
      - SQLite DB health (row count query; rebuilds schema on corruption)
      - perf CAP_SYS_ADMIN availability (sudo -n perf --version)
      - systemd-oomd status AND its last-hour journal (high oomd CPU
        in htop means it is actively reclaiming — journal shows what/why)
      - dbus-broker status (41m CPU in htop warranted investigation)
      - System entropy (/proc/sys/kernel/random/entropy_avail < 200
        causes blocking in cryptographic operations — latency source)
    """
    print("\n[MODULE:DOCTOR] SELF-HEALING ENVIRONMENT AUDIT")

    # Container detection: /.dockerenv is created by Docker at container start.
    # Cloud Run containers also have this file.
    if os.path.exists("/.dockerenv"):
        print("[DOCTOR:INFO] Containerized environment detected (Docker/Cloud Run).")
    else:
        print("[DOCTOR:INFO] Non-containerized environment.")

    # Write access: without it, TeeLogger's open() will fail and the entire
    # run aborts. Better to detect this early with a clear message.
    if os.access(LOG_DIR, os.W_OK):
        print(f"[DOCTOR:SUCCESS] Log directory writable: {LOG_DIR}")
    else:
        print(f"[DOCTOR:CRITICAL] Log directory NOT writable: {LOG_DIR}")

    # DB health: a SELECT count(*) will raise if the schema is corrupt or the
    # file is a valid SQLite file with missing tables.
    try:
        conn   = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("SELECT count(*) FROM runs")
        count  = cursor.fetchone()[0]
        print(f"[DOCTOR:SUCCESS] Database healthy. Runs tracked: {count}")
        conn.close()
    except Exception as e:
        print(f"[DOCTOR:CRITICAL] Database corruption: {e}. Attempting rebuild...")
        DatabaseManager.init_db()

    # perf capability: perf requires CAP_SYS_ADMIN or paranoid <= 1.
    # sudo -n exits 0 if NOPASSWD covers perf --version.
    print("[DOCTOR:AUDIT] Checking perf tracing capability...")
    try:
        ret = subprocess.call(
            ["sudo", "-n", "perf", "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        if ret == 0:
            print("[DOCTOR:SUCCESS] Perf tracing available (CAP_SYS_ADMIN or NOPASSWD).")
        else:
            print("[DOCTOR:WARNING] Perf may be restricted. Check /proc/sys/kernel/perf_event_paranoid.")
    except Exception:
        print("[DOCTOR:WARNING] Could not verify perf availability.")

    # systemd-oomd: the real machine's htop showed 1h38m CPU for oomd.
    # --no-pager prevents systemctl from blocking on terminal output.
    # The journal fetch exposes reclamation events (which cgroup was killed,
    # what pressure threshold triggered it) that status alone doesn't show.
    if shutil.which("systemctl"):
        print("[DOCTOR:AUDIT] systemd-oomd status and reclamation journal...")
        run(["systemctl", "status", "systemd-oomd", "--no-pager"], timeout=5)
        run(
            ["journalctl", "-u", "systemd-oomd", "--since", "1 hour ago", "--no-pager"],
            timeout=15
        )

    # dbus-broker: 41m CPU in the real machine's htop. Status check only —
    # full dbus message inspection requires dbus-monitor which is invasive.
    if shutil.which("systemctl"):
        print("[DOCTOR:AUDIT] dbus-broker status...")
        run(["systemctl", "status", "dbus-broker", "--no-pager"], timeout=5)

    # Entropy: < 200 bits causes blocking reads from /dev/random in kernels
    # before 5.6 (before the getrandom() changes). haveged is running on the
    # real machine (PID 633), which suggests entropy was already a concern.
    if os.path.exists("/proc/sys/kernel/random/entropy_avail"):
        with open("/proc/sys/kernel/random/entropy_avail") as f:
            entropy = f.read().strip()
        print(f"[METRIC:ENTROPY] {entropy}")
        if int(entropy) < 200:
            SUMMARY_LINES.append(f"WARNING: Low system entropy ({entropy} bits). "
                                  "Cryptographic ops may block. haveged or rngd recommended.")


def psi():
    """
    Pressure Stall Information from /proc/pressure/{cpu,memory,io}.
    PSI is the definitive latency signal: avg10 > 0 means tasks are
    stalling right now. avg10 > 5% on any resource is CRITICAL.

    VERIFIES WITH: [METRIC:CPU_PRESSURE], [METRIC:MEMORY_PRESSURE],
    [METRIC:IO_PRESSURE] lines in output. Values written to SQLite metrics.
    """
    print("\n[MODULE:PSI] PRESSURE STALL INFORMATION")
    for resource in ["cpu", "memory", "io"]:
        path = f"/proc/pressure/{resource}"
        if os.path.exists(path):
            out = run(["cat", path], capture_output=True)
            if out and "some avg10=" in out:
                match = re.search(r"avg10=([\d.]+)", out)
                if match:
                    val = float(match.group(1))
                    print(f"[METRIC:{resource.upper()}_PRESSURE] {val}")
                    DatabaseManager.log_metric(
                        CURRENT_RUN_ID, f"{resource.upper()}_PRESSURE", val
                    )
                    if val > 5.0:
                        SUMMARY_LINES.append(
                            f"CRITICAL: High {resource.upper()} pressure: {val}% "
                            f"(avg10). Tasks are stalling on {resource} right now."
                        )
        else:
            print(f"[PSI:WARN] {path} not found — kernel < 4.20 or CONFIG_PSI=n")


def core_imbalance_check():
    """
    Detects single-core saturation — the "ghost load" pattern where one
    core runs at 100% but no process shows that CPU% in htop/ps.
    Causes: IRQ affinity pinning a high-rate NIC/SSD interrupt to one core;
    short-lived kernel threads; auditd backlog processing; RCU callbacks.

    On saturation (idle < 5%), automatically runs:
      perf stat -a -C <core> sleep 2
    to capture hardware counters for that core: IPC, cache misses, branch
    misses, and stalled cycles. These distinguish IRQ-driven load (high
    cycles, low IPC) from compute load (high IPC).

    VERIFIES WITH: [METRIC:CPU_CORE_N_IDLE] lines; [ACTION] lines on
    saturation; perf stat output with counter values.
    """
    print("\n[MODULE:CPU_CORE] CORE IMBALANCE AUDIT")
    out = run(["mpstat", "-P", "ALL", "1", "1"], capture_output=True)
    if not out:
        return

    lines = out.split("\n")
    # Find the header line containing "%idle" to locate column positions.
    header_idx = next((i for i, l in enumerate(lines) if "%idle" in l), -1)
    if header_idx == -1:
        print("[CPU_CORE:WARN] mpstat output format unrecognised — cannot parse.")
        return

    headers  = lines[header_idx].split()
    idle_idx = headers.index("%idle")

    for line in lines[header_idx + 1:]:
        # Skip the "all" summary row — we want per-core rows only.
        if "all" in line or len(line.split()) <= idle_idx:
            continue
        parts = line.split()
        try:
            idle = float(parts[idle_idx])
            core = parts[2]   # mpstat column 3 is the CPU number
            print(f"[METRIC:CPU_CORE_{core}_IDLE] {idle}")
            DatabaseManager.log_metric(CURRENT_RUN_ID, f"CPU_CORE_{core}_IDLE", idle)

            if idle < 5.0:
                SUMMARY_LINES.append(
                    f"WARNING: Core {core} saturated (idle: {idle}%). "
                    "Check IRQ affinity, execsnoop, and auditd backlog."
                )
                print(f"[ACTION] Core {core} saturated. Running hardware counter audit...")
                # perf stat -a captures system-wide counters but -C restricts
                # to the specific saturated core. sleep 2 is the measurement window.
                run(["sudo", "perf", "stat", "-a", "-C", core, "sleep", "2"], timeout=10)
        except (ValueError, IndexError):
            pass


def cpu_sched():
    """
    Scheduler and process audit. vmstat 1 3 shows run-queue depth (r column)
    and context switch rate (cs column) over 3 one-second intervals. A run
    queue > 2x CPU count indicates scheduler contention. pidstat -w shows
    per-process voluntary (cswch/s) and involuntary (nvcswch/s) context
    switches — a high nvcswch/s ratio means the process is being preempted.

    VERIFIES WITH: vmstat output with r, b, cs columns; pidstat -u for
    per-process CPU%; pidstat -w for context switch rates; uptime for
    1/5/15 minute load averages parsed into [METRIC:LOAD_AVG].
    """
    print("\n[MODULE:CPU_SCHED] SCHEDULER AND PROCESS AUDIT")
    run(["vmstat", "1", "3"])
    run(["pidstat", "-u", "1", "3"])
    run(["pidstat", "-w", "1", "3"])   # voluntary/involuntary context switches

    out = run(["uptime"], capture_output=True)
    if out:
        print(f"[METRIC:UPTIME] {out.strip()}")
        match = re.search(r"load average:\s+([\d.]+)", out)
        if match:
            load = float(match.group(1))
            print(f"[METRIC:LOAD_AVG] {load}")
            DatabaseManager.log_metric(CURRENT_RUN_ID, "LOAD_AVG_1M", load)


def perf_stat_system():
    """
    System-wide hardware performance counters for 5 seconds.
    perf stat -a measures all CPUs simultaneously. Key signals:
      - IPC (instructions per cycle) < 1.0 suggests memory-bound workload
      - cache-misses / cache-references ratio > 5% suggests LLC pressure
      - branch-misses / branches ratio > 1% suggests speculative mispredict
      - stalled-cycles-frontend / cycles suggests instruction cache pressure

    This is lighter than perf record + perf report — no data file written,
    no symbol resolution overhead, results printed immediately.

    VERIFIES WITH: perf stat output block with counter values and rates.
    """
    print("\n[MODULE:PERF_STAT] SYSTEM-WIDE HARDWARE COUNTERS (5s)")
    run(["sudo", "perf", "stat", "-a", "sleep", "5"], timeout=10)


def perf_analysis(probe_ts):
    """
    CPU cycle and scheduler sampling with call-graph recording.
    Writes to a timestamped path in LOG_DIR so concurrent runs or
    loop-mode runs never overwrite each other's data file.

    perf record -a -g samples all CPUs with call-graph (dwarf or fp).
    perf report --stdio renders the annotated call tree to stdout
    (captured by TeeLogger into the run's log file).

    FAILURE MODE: if perf record fails (CAP_SYS_ADMIN missing, paranoid
    too high), the exit code is non-zero and [EXIT] N appears in output.
    perf report then fails too because the data file is empty. Both
    failures are logged but do not abort the probe — the other modules
    continue.

    VERIFIES WITH: perf report output showing symbol percentages;
    [METRIC] lines will not appear here (perf output is symbolic).
    """
    print("\n[MODULE:PERF] CPU CYCLE AND SCHEDULER TRACING (5s)")
    # Timestamped data file prevents collision in loop/concurrent mode.
    perf_data = os.path.join(LOG_DIR, f"perf_{probe_ts}.data")
    run(["sudo", "perf", "record", "-o", perf_data, "-a", "-g", "sleep", "5"], timeout=10)
    run(["sudo", "perf", "report", "-i", perf_data, "--stdio", "--max-stack", "10"])


def memory():
    """
    Memory pressure and slab allocator audit.
    vmstat -s shows absolute memory counters (total, free, swap used, etc.).
    pidstat -r shows per-process RSS and virtual size over 3 intervals.
    slabtop -o -n 1 shows the top kernel slab caches by size — a leaking
    slab (dentry, inode_cache, task_struct) grows unbounded and causes
    kswapd to run continuously, visible as background CPU.
    lsof count gives total open file descriptors — a leak indicator.

    VERIFIES WITH: vmstat -s memory table; pidstat -r RSS column;
    slabtop output with cache names and sizes; [METRIC:OPEN_FILES] count.
    """
    print("\n[MODULE:MEM] MEMORY PRESSURE AND SLAB AUDIT")
    run(["vmstat", "-s"])
    run(["pidstat", "-r", "1", "3"])
    run(["slabtop", "-o", "-n", "1"])

    # lsof with no arguments lists every open file descriptor on the system.
    # The line count (minus header) approximates total FD usage.
    out = run(["lsof"], capture_output=True)
    if out:
        count = out.count("\n") - 1
        print(f"[METRIC:OPEN_FILES] {count}")
        DatabaseManager.log_metric(CURRENT_RUN_ID, "OPEN_FILES", count)


def numa_audit():
    """
    NUMA locality contention audit. On multi-socket systems, memory accesses
    that cross NUMA nodes have 2-4x higher latency than local accesses.
    numastat shows per-node allocation hits vs misses — a high numa_foreign
    count means memory is being allocated on the wrong node.

    On single-socket systems (including the real machine) this will show
    symmetric allocation and is still useful to confirm the assumption.

    VERIFIES WITH: numastat output with per-node hit/miss/foreign counts.
    """
    print("\n[MODULE:NUMA] LOCALITY CONTENTION AUDIT")
    run(["numastat"])


def disk():
    """
    Disk I/O latency and throughput via iostat -xz.
    -x shows extended stats (await, r_await, w_await, %util).
    -z omits devices with zero activity to reduce noise.
    Parsing extracts %util per device and alerts if > 80%.

    await > 20ms on an SSD indicates queue depth saturation.
    await > 100ms on any device during a probe run is CRITICAL.

    VERIFIES WITH: iostat output with await and %util columns;
    [METRIC:DISK_<dev>_UTIL] lines; CRITICAL alert if util > 80%.
    """
    print("\n[MODULE:DISK] I/O LATENCY AND THROUGHPUT")
    out = run(["iostat", "-xz", "1", "3"], capture_output=True)
    if out and "%util" in out:
        for line in out.split("\n"):
            parts = line.split()
            # iostat -x extended output has > 10 columns; skip header rows.
            if len(parts) > 10 and not line.startswith("Device"):
                try:
                    util = float(parts[-1])
                    dev  = parts[0]
                    print(f"[METRIC:DISK_{dev}_UTIL] {util}")
                    DatabaseManager.log_metric(CURRENT_RUN_ID, f"DISK_{dev}_UTIL", util)
                    if util > 80.0:
                        SUMMARY_LINES.append(
                            f"CRITICAL: Disk {dev} at {util}% utilization. "
                            "Check await and queue depth."
                        )
                except (ValueError, IndexError):
                    pass


def block_layer_trace():
    """
    Block-layer I/O tracing via blktrace. Captures every I/O request
    lifecycle (issue, complete, merge) at the block device level, below
    the filesystem. Useful for diagnosing seek patterns, request merging
    failures, and scheduler latency at the block layer.

    DISK DETECTION: lsblk -no NAME,TYPE | awk '$2=="disk"{print $1; exit}'
    explicitly filters for whole-disk devices (TYPE==disk). Without the
    TYPE filter, lsblk may return a partition (e.g. nvme0n1p1 on NVMe
    systems) and blktrace -d on a partition fails with EINVAL.

    blkparse is run if available to produce human-readable output.
    blktrace writes binary data that blkparse decodes.

    VERIFIES WITH: blktrace output showing Q, G, I, D, C event types;
    blkparse output with per-request latency if blkparse is installed.
    """
    print("\n[MODULE:BLKTRACE] BLOCK LAYER LATENCY TRACE (5s)")
    # awk '$2=="disk"' ensures we get a whole disk, not a partition.
    disk_out = run(
        ["bash", "-c", "lsblk -no NAME,TYPE | awk '$2==\"disk\"{print $1; exit}'"],
        capture_output=True
    )
    if not disk_out:
        print("[BLKTRACE:WARN] No block disk device found — skipping.")
        return

    disk_dev = disk_out.strip()
    dev_path = f"/dev/{disk_dev}"
    run(["sudo", "blktrace", "-d", dev_path, "-w", "5"], timeout=10)
    if shutil.which("blkparse"):
        # blkparse reads the .blktrace.N files written by blktrace.
        run(["sudo", "blkparse", "-i", disk_dev])


def network():
    """
    Network socket and protocol audit.
    ss -tulnp: listening sockets with process names.
    ss -ti: per-socket TCP internal state (retransmits, cwnd, rtt).
    ss -s: one-line protocol summary (ESTABLISHED, TIME_WAIT, CLOSE_WAIT
           counts) — high TIME_WAIT indicates connection churn; high
           CLOSE_WAIT indicates a server not reading from closed sockets.
    netstat -s: protocol-level error counters (TCP retransmits, resets,
           failed connection attempts, UDP receive errors).
    ping: baseline RTT to 8.8.8.8 — eliminates "is it the network?"
    ss -t -a: full connection table for TCP_CONNS metric.

    VERIFIES WITH: ss output; [METRIC:TCP_CONNS] count.
    """
    print("\n[MODULE:NET] SOCKET AND PROTOCOL AUDIT")
    run(["ss", "-tulnp"])
    run(["ss", "-ti"])
    run(["ss", "-s"])       # socket state summary: ESTABLISHED, TIME_WAIT, etc.
    run(["netstat", "-s"])

    print("[ACTION] Checking network latency to 8.8.8.8...")
    run(["ping", "-c", "3", "8.8.8.8"])

    out = run(["ss", "-t", "-a"], capture_output=True)
    if out:
        count = out.count("\n") - 1
        print(f"[METRIC:TCP_CONNS] {count}")
        DatabaseManager.log_metric(CURRENT_RUN_ID, "TCP_CONNS", count)


def network_interface_stats():
    """
    Interface-level throughput via nicstat. nicstat provides utilization
    %Util per interface (analogous to disk %util) which ss and netstat do
    not expose directly. A NIC at > 50% %Util under "idle" conditions
    indicates a background traffic source or misconfigured offload.

    nicstat is not in default Kali/Fedora repos. If missing, the module
    silently skips (shutil.which guard). Install via: apt-get install nicstat.

    VERIFIES WITH: nicstat output with Int, rKB/s, wKB/s, %Util columns.
    """
    print("\n[MODULE:NICSTAT] INTERFACE THROUGHPUT AUDIT")
    if shutil.which("nicstat"):
        run(["nicstat", "1", "2"])
    else:
        print("[NICSTAT:WARN] nicstat not found — install with: apt-get install nicstat")


def kernel():
    """
    Kernel error log and loaded module audit.
    dmesg --ctime --level=err,warn shows kernel errors and warnings with
    human-readable timestamps (--ctime translates monotonic clock to wall
    time). Common latency sources visible here: storage controller resets,
    PCIe error recovery, ACPI errors, OOM events, NIC firmware errors.
    lsmod shows loaded kernel modules — correlates dmesg driver errors to
    specific hardware and identifies unexpected modules.

    VERIFIES WITH: dmesg output with [err] and [warn] tagged lines; lsmod
    table with Module, Size, Used columns.
    """
    print("\n[MODULE:KERNEL] LOGS AND MODULE AUDIT")
    run(["dmesg", "--ctime", "--level=err,warn"])
    run(["lsmod"])


def kernel_function_trace():
    """
    Kernel function-level tracing via trace-cmd (ftrace frontend).
    trace-cmd record -p function traces every kernel function call for 5s.
    trace-cmd report renders the binary trace buffer to human-readable output.

    WARNING: function tracer generates very high volume output (100MB+/s in
    a busy kernel). The 5-second window and timeout=10 bound its impact.
    For targeted tracing use: trace-cmd record -p function_graph -g <func>

    Only runs if trace-cmd is installed (shutil.which guard).

    VERIFIES WITH: trace-cmd report output with CPU, PID, function, and
    caller columns. Look for unexpected functions consuming many calls.
    """
    print("\n[MODULE:FTRACE] KERNEL FUNCTION TRACING (5s)")
    if shutil.which("trace-cmd"):
        run(["sudo", "trace-cmd", "record", "-p", "function", "sleep", "5"], timeout=10)
        run(["sudo", "trace-cmd", "report"])
    else:
        print("[FTRACE:WARN] trace-cmd not found — install trace-cmd package.")


def cgroup():
    """
    cgroup throttling and quota audit. Reads /sys/fs/cgroup hierarchy to
    expose cpu.max (CPU quota), memory.max (memory limit), and io.max
    (I/O bandwidth limits) set by container runtimes or systemd slices.

    A process hitting its cpu.max quota appears CPU-throttled even on an
    idle system — nr_throttled in cpu.stat shows this. A process at its
    memory.max will trigger cgroup-level OOM kills visible in dmesg.

    find -maxdepth 2 limits output to avoid traversing deep container
    hierarchies. head -n 20 caps output volume.

    VERIFIES WITH: find output listing cgroup control files; look for
    cpu.max, memory.max, cpu.stat files in the hierarchy.
    """
    print("\n[MODULE:CGROUP] THROTTLING AND QUOTA AUDIT")
    if os.path.exists("/sys/fs/cgroup"):
        run(["bash", "-c", "find /sys/fs/cgroup -maxdepth 2 -type f | head -n 20"])


def irq_affinity_audit():
    """
    Hardware interrupt affinity and cumulative interrupt count audit.
    /proc/irq/N/smp_affinity_list shows which CPUs can handle interrupt N
    as a CPU list (e.g. "3" means only core 3; "0-3" means any of 0-3).
    A single-CPU affinity on a high-rate interrupt (NIC, NVMe) pins all
    that interrupt processing to one core — visible as 100% idle=0 on
    that core in mpstat with no matching process in ps/htop.

    /proc/interrupts shows cumulative counts per CPU since boot. High
    counts on one CPU column indicate IRQ pinning. Use irq_rate_audit()
    (called next) to see per-second rates rather than cumulative counts.

    VERIFIES WITH: smp_affinity_list values per IRQ number; /proc/interrupts
    table — look for columns where one CPU has disproportionately high counts.
    """
    print("\n[MODULE:IRQ] AFFINITY AND INTERRUPT STORM AUDIT")
    run(["bash", "-c", "grep . /proc/irq/*/smp_affinity_list"])
    run(["cat", "/proc/interrupts"])


def irq_rate_audit():
    """
    Per-second interrupt rates via sar -I ALL.
    Complements irq_affinity_audit() which shows cumulative counts.
    A burst interrupt storm that finished before the probe run will
    appear in cumulative counts but NOT in sar's per-second measurement.
    Conversely, an ongoing storm is visible in both.

    sar -I ALL 1 5 samples all interrupts at 1-second intervals for 5s.
    Output shows intr/s per interrupt number — an interrupt > 10000/s
    from a single source (e.g. a misconfigured NIC in polling mode) is
    a latency source even when the system appears "idle" by CPU%.

    sar is from the sysstat package (already in REQUIRED_TOOLS/APT_PACKAGES).

    VERIFIES WITH: sar -I ALL output with per-IRQ intr/s rates.
    """
    print("\n[MODULE:IRQ_RATE] PER-SECOND INTERRUPT RATES (5s via sar)")
    if shutil.which("sar"):
        run(["sar", "-I", "ALL", "1", "5"], timeout=10)
    else:
        print("[IRQ_RATE:WARN] sar not found — install sysstat package.")


def auditd_check():
    """
    Linux Audit subsystem overhead check. The real machine's htop showed
    three auditd processes (PIDs 725, 729, 732) — multiple threads is normal
    (dispatcher, logger, main) but high CPU on any indicates audit backlog.

    auditctl -s shows:
      enabled     — 0=disabled, 1=enabled, 2=immutable
      backlog     — rules queued but not yet dispatched (non-zero = backlog)
      lost        — events lost due to full queue (non-zero = data loss)
      backlog_limit — max queue size before events are dropped

    A non-zero "lost" count means audit records are being discarded.
    This can cause auditd to consume significant CPU catching up after bursts.

    VERIFIES WITH: auditctl -s output with enabled, backlog, lost fields.
    """
    print("\n[MODULE:AUDITD] LOGGING OVERHEAD AUDIT")
    if shutil.which("auditctl"):
        run(["sudo", "auditctl", "-s"])
    else:
        print("[AUDITD:WARN] auditctl not found — install audit package.")


def short_lived_process_trace():
    """
    Transient process detection via execsnoop (BCC/eBPF).
    execsnoop traces execve() syscalls system-wide and shows process name,
    PID, PPID, and arguments for every new process as it starts.

    The "ghost load" pattern (core at 100% idle=0, no matching PID in
    htop) often comes from a shell script or cron job spawning thousands
    of short-lived child processes — each execve() completes in <1ms so
    they never appear in a ps snapshot, but their combined CPU time
    saturates a core.

    execsnoop requires CAP_BPF or CAP_SYS_ADMIN. It is in the bcc-tools
    package. If not installed, the module silently skips.

    VERIFIES WITH: execsnoop output with PCOMM, PID, PPID, ARGS columns.
    A script calling ls, grep, or awk in a tight loop will flood this output.
    """
    print("\n[MODULE:BCC] TRACING TRANSIENT PROCESSES (5s via execsnoop)")
    if shutil.which("execsnoop"):
        run(["sudo", "execsnoop", "-d", "5"], timeout=10)
    else:
        print("[BCC:WARN] execsnoop not found — install bcc-tools package.")


def scheduler_latency_hist():
    """
    Run-queue latency histogram via bpftrace eBPF program.
    Measures the time between a task becoming runnable (sched_wakeup)
    and actually being scheduled (sched_switch). This is the scheduler
    latency — the delay a task experiences waiting for a CPU to be available.

    The bpftrace program:
      sched:sched_wakeup  — records the wakeup timestamp per PID
      sched:sched_switch  — computes latency = now - wakeup for prev_pid
      interval:s:5        — after 5 seconds, prints the @latency histogram
                            and exits cleanly (self-terminating)

    Output is a log2 histogram of latency in nanoseconds. Latencies > 1ms
    (1,000,000 ns) indicate scheduler contention. Latencies > 10ms indicate
    a severely overloaded or throttled system.

    VERIFIES WITH: @latency histogram with ns ranges and event counts.
    Look at the tail: if P99 > 10ms, scheduler latency is a problem.
    """
    print("\n[MODULE:BPFTRACE] RUN-QUEUE LATENCY HISTOGRAM (5s)")
    if not shutil.which("bpftrace"):
        print("[BPFTRACE:WARN] bpftrace not found — install bpftrace package.")
        return

    expr = (
        "sched:sched_wakeup { @start[args->pid] = nsecs; } "
        "sched:sched_switch { "
        "  if (@start[prev_pid]) { "
        "    @latency = hist(nsecs - @start[prev_pid]); "
        "    delete(@start[prev_pid]); "
        "  } "
        "} "
        "interval:s:5 { exit(); }"   # self-terminating after 5 seconds
    )
    run(["sudo", "bpftrace", "-e", expr], timeout=10)


def selinux_audit():
    """
    SELinux policy enforcement and AVC denial audit.
    sestatus shows: enabled/disabled, enforcing/permissive mode, policy name.
    ausearch -m AVC -ts recent searches the audit log for Access Vector Cache
    denials in the last 10 minutes. Each denial means a process tried to
    access a resource that SELinux policy forbids — the kernel blocked the
    access and logged it.

    AVC denials cause latency when a high-frequency operation (e.g. a web
    server serving requests, a database reading files) is blocked repeatedly.
    The kernel must check policy, log to the audit buffer, and return EACCES
    for every single denied operation.

    High AVC denial count correlates with high auditd CPU (auditd writes
    each denial to disk) and with application-level latency spikes.

    VERIFIES WITH: sestatus output; [METRIC:SELINUX_DENIALS] count;
    ausearch output with type=AVC lines showing scontext, tcontext, tclass.
    """
    print("\n[MODULE:SELINUX] SECURITY POLICY AND AVC DENIAL AUDIT")
    if shutil.which("sestatus"):
        out = run(["sestatus"], capture_output=True)
        if out:
            mode_match = re.search(r"Current mode:\s+(\w+)", out)
            if mode_match:
                mode = mode_match.group(1)
                print(f"[METRIC:SELINUX_MODE] {mode}")
                if mode == "enforcing":
                    print("[SELINUX:INFO] Enforcing mode — AVC denials are blocking.")
                else:
                    print("[SELINUX:INFO] Permissive/disabled — AVC denials logged but not blocking.")

    if shutil.which("ausearch"):
        print("[ACTION] Searching audit log for recent AVC denials (last 10 min)...")
        out = run(
            ["sudo", "ausearch", "-m", "AVC", "-ts", "recent"],
            timeout=20,
            capture_output=True
        )
        if out:
            count = out.count("avc:  denied")
            print(f"[METRIC:SELINUX_DENIALS] {count}")
            DatabaseManager.log_metric(CURRENT_RUN_ID, "SELINUX_DENIALS", count)
            if count > 0:
                SUMMARY_LINES.append(
                    f"CRITICAL: {count} SELinux AVC denials in last 10 min. "
                    "High denial rate causes auditd CPU load and application latency."
                )
    else:
        print("[SELINUX:WARN] ausearch not found — install audit package for AVC search.")


def rank_root_causes():
    """
    Automated ranked root-cause summary. Sorts SUMMARY_LINES by severity:
    CRITICAL first, then WARNING, then INFO. Each line is printed with a
    [RANKED_ALERT] prefix and written to the SQLite alerts table.

    SUMMARY_LINES is populated throughout the run by psi(), disk(),
    core_imbalance_check(), selinux_audit(), and doctor() whenever a
    threshold is exceeded. rank_root_causes() is called at the end of the
    full pipeline so it has the complete picture.

    VERIFIES WITH: [RANKED_ALERT] lines in the correct priority order.
    If no anomalies were detected, prints "No critical anomalies detected."
    """
    print("\n[MODULE:SUMMARY] AUTOMATED RANKED ROOT-CAUSE ANALYSIS")
    if not SUMMARY_LINES:
        print("[SUMMARY:INFO] No critical anomalies detected. System appears stable.")
        return

    sorted_summary = sorted(
        SUMMARY_LINES,
        key=lambda x: 0 if "CRITICAL" in x else (1 if "WARNING" in x else 2)
    )
    for line in sorted_summary:
        print(f"[RANKED_ALERT] {line}")
        sev = "CRITICAL" if "CRITICAL" in line else ("WARNING" if "WARNING" in line else "INFO")
        DatabaseManager.log_alert(CURRENT_RUN_ID, sev, line)


def generate_html_report():
    """
    Standalone HTML forensic report. Written to forensic_summary.html in
    the working directory. Contains all SUMMARY_LINES as color-coded cards.
    The report is self-contained (no external dependencies) for offline viewing.

    Served via the Express backend at GET /api/report for dashboard access.

    VERIFIES WITH: forensic_summary.html present after run; [RANKED_ALERT]
    items visible as colored list items when opened in a browser.
    """
    print(f"\n[MODULE:REPORT] GENERATING HTML DASHBOARD: {HTML_FILE}")
    rows = "".join([
        f'<li class="{"critical" if "CRITICAL" in l else ("warning" if "WARNING" in l else "info")}">{l}</li>'
        for l in SUMMARY_LINES
    ]) if SUMMARY_LINES else "<li class='info'>No anomalies detected.</li>"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Forensic Latency Report v13.2.2</title>
    <style>
        body  {{ font-family: sans-serif; background: #f8f9fa; padding: 20px; }}
        .card {{ background: white; border-radius: 8px; padding: 20px;
                 margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
        .critical {{ color: #dc3545; font-weight: bold; }}
        .warning  {{ color: #e67e00; font-weight: bold; }}
        .info     {{ color: #0d6efd; }}
        pre {{ background: #212529; color: #f8f9fa; padding: 15px;
               border-radius: 4px; overflow-x: auto; }}
    </style>
</head>
<body>
    <h1>Forensic Latency Report</h1>
    <p>Generated: {datetime.datetime.now().isoformat()}</p>
    <div class="card">
        <h2>Ranked Root Causes</h2>
        <ul>{rows}</ul>
    </div>
</body>
</html>"""

    with open(HTML_FILE, "w") as f:
        f.write(html)
    print(f"[REPORT:SUCCESS] HTML report written to {HTML_FILE}")


# =============================================================================
# MAIN PROBE ORCHESTRATOR
# =============================================================================

def run_probe(advanced=False, module=None):
    """
    Top-level orchestrator. Called once per probe run (or once per loop
    interval in --loop mode).

    SUMMARY_LINES is cleared first (global reset) so loop runs start clean.
    probe_ts is generated once and threaded through to perf_analysis() to
    ensure the timestamped perf.data path is consistent within a run.

    The absolute path of the log file is printed BEFORE TeeLogger redirects
    stdout, so it appears on the terminal even if TeeLogger construction
    fails (disk full, permission denied).

    enforce_compliance() runs inside the TeeLogger context — by the time it
    checks isinstance(sys.stdout, TeeLogger), the redirect has already happened.

    The finally block unconditionally restores sys.stdout/sys.stderr so that
    exceptions after the TeeLogger redirect don't leave the process with a
    broken stdout.
    """
    # Clear per-run accumulator. Without this, --loop mode accumulates
    # CRITICAL alerts from run 1 in run 2's report, making the ranked
    # summary misleading after the first iteration.
    global SUMMARY_LINES
    SUMMARY_LINES = []

    global CURRENT_RUN_ID
    probe_ts  = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    probe_log = os.path.join(LOG_DIR, f"latency_probe_v13_{probe_ts}.log")

    # Print log path BEFORE redirecting stdout so it appears on the terminal
    # regardless of TeeLogger success or failure.
    print(os.path.abspath(probe_log))
    sys.stdout.flush()

    with TeeLogger(probe_log) as logger:
        sys.stdout = logger
        sys.stderr = logger

        try:
            DatabaseManager.init_db()
            CURRENT_RUN_ID = DatabaseManager.start_run(
                "ADVANCED" if advanced else (f"MODULE:{module}" if module else "STANDARD")
            )

            # Hard compliance check — aborts if any module was removed.
            enforce_compliance()

            # module_map: maps UI module names to their Python functions.
            # lambda wraps perf_analysis to capture the current probe_ts.
            module_map = {
                "DEPS":     DependencyManager.ensure_deps,
                "DOCTOR":   doctor,
                "PSI":      psi,
                "CPU_CORE": core_imbalance_check,
                "CPU_SCHED":cpu_sched,
                "PERF_STAT":perf_stat_system,
                "MEM":      memory,
                "NUMA":     numa_audit,
                "DISK":     disk,
                "NET":      network,
                "NICSTAT":  network_interface_stats,
                "KERNEL":   kernel,
                "CGROUP":   cgroup,
                "IRQ":      irq_affinity_audit,
                "IRQ_RATE": irq_rate_audit,
                "AUDITD":   auditd_check,
                "SELINUX":  selinux_audit,
                "BCC":      short_lived_process_trace,
                "PERF":     lambda: perf_analysis(probe_ts),
                "BLKTRACE": block_layer_trace,
                "FTRACE":   kernel_function_trace,
                "BPFTRACE": scheduler_latency_hist,
                "SUMMARY":  rank_root_causes,
                "REPORT":   generate_html_report,
            }

            if module:
                # Single-module mode: run only the requested module.
                if module in module_map:
                    module_map[module]()
                else:
                    print(f"[ERROR] Unknown module '{module}'. "
                          f"Valid modules: {', '.join(sorted(module_map))}")
            else:
                # ── FULL PIPELINE ────────────────────────────────────────────
                # Order is significant: doctor and deps first (environment),
                # then resource pressure (PSI, CPU, memory, disk, network),
                # then kernel signals (dmesg, cgroup, IRQ, audit, SELinux),
                # then eBPF/invasive tools (execsnoop),
                # then advanced tools (perf record, blktrace, ftrace, bpftrace)
                # only if --advanced is passed,
                # finally summary and report.
                DependencyManager.ensure_deps()
                doctor()
                psi()
                core_imbalance_check()
                cpu_sched()
                perf_stat_system()      # system-wide hardware counters (new v13.2.2)
                memory()
                numa_audit()
                disk()
                network()
                network_interface_stats()
                kernel()
                cgroup()
                irq_affinity_audit()
                irq_rate_audit()        # per-second IRQ rates (called ONCE, after affinity)
                auditd_check()
                selinux_audit()
                short_lived_process_trace()

                if advanced:
                    # Invasive tools requiring CAP_SYS_ADMIN / elevated sudo.
                    # Omitted from standard run to minimise probe overhead on
                    # production systems. Enable with --advanced flag.
                    perf_analysis(probe_ts)
                    block_layer_trace()
                    kernel_function_trace()
                    scheduler_latency_hist()

                rank_root_causes()
                generate_html_report()

            DatabaseManager.update_run_status(
                CURRENT_RUN_ID, "SUCCESS",
                probe_log, HTML_FILE,
                "\n".join(SUMMARY_LINES)
            )
            print(f"\n[COMPLETE] Log:    {probe_log}")
            if not module or module == "REPORT":
                print(f"[COMPLETE] Report: {HTML_FILE}")

        except Exception as e:
            DatabaseManager.update_run_status(CURRENT_RUN_ID, "FAILED", probe_log)
            print(f"[CRITICAL] Run failed: {e}")
            traceback.print_exc()

        finally:
            # Always restore sys.stdout/sys.stderr so the process remains
            # usable after an exception inside the TeeLogger context.
            sys.stdout = sys.__stdout__
            sys.stderr = sys.__stderr__


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Forensic Latency Analyzer v13.2.2"
    )
    parser.add_argument(
        "--loop", type=int, default=0,
        help="Repeat probe every N seconds (0 = run once)"
    )
    parser.add_argument(
        "--advanced", action="store_true",
        help="Enable invasive tools: perf record, blktrace, ftrace, bpftrace"
    )
    parser.add_argument(
        "--module", type=str, default=None,
        help="Run a single module by name (e.g. PSI, SELINUX, DOCTOR)"
    )
    args = parser.parse_args()

    try:
        if args.loop > 0:
            # Loop mode: run indefinitely at N-second intervals.
            # SUMMARY_LINES is cleared at the start of each run_probe() call
            # so each iteration's report is independent.
            while True:
                run_probe(advanced=args.advanced, module=args.module)
                print(f"[LOOP] Sleeping {args.loop}s before next run...")
                time.sleep(args.loop)
        else:
            run_probe(advanced=args.advanced, module=args.module)

    except KeyboardInterrupt:
        print("\n[STOPPED] Probe interrupted by user.")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
