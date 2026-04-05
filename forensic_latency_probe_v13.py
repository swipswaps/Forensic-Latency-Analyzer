#!/usr/bin/env python3
# =============================================================================
# forensic_latency_probe_v13.py
# =============================================================================
# FULL REQUEST-COMPLIANT FORENSIC LATENCY ANALYZER v13.2.3 (HARDENED)
# =============================================================================
#
# v13.2.3 changes over v13.2.2:
#   - _sudo_available(): cached sudo -n check runs ONCE per process lifetime.
#     All sudo commands in run() are skipped instantly (not after 30s timeout)
#     when non-interactive sudo is unavailable.
#   - core_imbalance_check(): CPU column index found dynamically from header.
#   - disk(): %util column index found dynamically from iostat header.
#   - selinux_audit(): re.findall(r"avc:\s+denied") matches both spacing variants.
#   - irq_rate_audit() duplicate call removed. Called once after irq_affinity_audit().

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

LOG_DIR = os.path.abspath("./forensic_logs")
os.makedirs(LOG_DIR, exist_ok=True)
DB_FILE = os.path.join(LOG_DIR, "forensic_audit.db")
HTML_FILE = os.path.abspath("./forensic_summary.html")
DEPS_MARKER = os.path.join(LOG_DIR, ".deps_installed")

REQUIRED_TOOLS = [
    "vmstat", "iostat", "pidstat", "mpstat",
    "ss", "ping", "traceroute", "lsof",
    "strace", "dmesg", "journalctl", "netstat",
    "uptime", "lsmod", "numastat", "slabtop",
    "auditctl", "perf", "blktrace", "trace-cmd",
    "bpftrace", "nicstat", "numactl", "iotop",
    "ausearch", "sestatus", "sar"
]

DNF_MAP = {
    "sysstat":         "sysstat",
    "iproute2":        "iproute",
    "iputils-ping":    "iputils",
    "traceroute":      "traceroute",
    "lsof":            "lsof",
    "strace":          "strace",
    "linux-perf":      "perf",
    "net-tools":       "net-tools",
    "iotop":           "iotop",
    "blktrace":        "blktrace",
    "trace-cmd":       "trace-cmd",
    "bpftrace":        "bpftrace",
    "nicstat":         "nicstat",
    "numactl":         "numactl",
    "auditd":          "audit",
    "bcc-tools":       "bcc-tools",
    "policycoreutils": "policycoreutils",
}

APT_PACKAGES = list(DNF_MAP.keys())

SUMMARY_LINES  = []
CURRENT_RUN_ID = None

# =============================================================================
# DATABASE MANAGEMENT (IDEMPOTENT LOGGING)
# =============================================================================

class DatabaseManager:
    @staticmethod
    def init_db():
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
        try:
            conn   = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute("INSERT INTO runs (mode, status) VALUES (?, ?)", (mode, "RUNNING"))
            run_id = cursor.lastrowid
            conn.commit()
            conn.close()
            return run_id
        except Exception:
            return None

    @staticmethod
    def update_run_status(run_id, status, log_path=None, html_path=None, summary=None):
        if not run_id: return
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
        if not run_id: return
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
        if not run_id: return
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
    @staticmethod
    def ensure_deps():
        print("\n[MODULE:DEPS] VERIFYING SYSTEM DEPENDENCIES")
        missing = [t for t in REQUIRED_TOOLS if shutil.which(t) is None]
        if not missing:
            print("[DEPS:SUCCESS] All tools present in PATH.")
            return

        print(f"[DEPS:ACTION] Missing: {missing}. Initiating recoverable install.")
        sudo_works = run(["sudo", "-n", "true"], timeout=5) == 0
        if not sudo_works:
            print("[DEPS:WARNING] Non-interactive sudo failed. Install may prompt.")

        for attempt in range(3):
            try:
                if shutil.which("apt-get"):
                    if not os.path.exists(DEPS_MARKER):
                        run(["sudo", "-n", "apt-get", "update"], timeout=60)
                        with open(DEPS_MARKER, "w") as f:
                            f.write(datetime.datetime.now().isoformat())
                    ret = run(["sudo", "-n", "apt-get", "install", "-y"] + APT_PACKAGES, timeout=120)
                    if ret == 0: break
                elif shutil.which("dnf"):
                    dnf_pkgs = [DNF_MAP.get(p, p) for p in APT_PACKAGES]
                    ret = run(["sudo", "-n", "dnf", "install", "-y"] + dnf_pkgs, timeout=120)
                    if ret == 0: break
            except Exception as e:
                print(f"[DEPS:RETRY] Attempt {attempt+1} failed: {e}")
                time.sleep(5)

        missing_after = [t for t in REQUIRED_TOOLS if shutil.which(t) is None]
        if missing_after:
            print(f"[DEPS:WARNING] Still missing after install: {missing_after}")

# =============================================================================
# LOGGING (TEE STDOUT + STDERR)
# =============================================================================

class TeeLogger:
    def __init__(self, logfile):
        self.logfile         = logfile
        self.log             = open(logfile, "a", buffering=1)
        self.terminal_stdout = sys.__stdout__
        self.terminal_stderr = sys.__stderr__

    def write(self, msg):
        self.terminal_stdout.write(msg)
        self.log.write(msg)

    def flush(self):
        self.terminal_stdout.flush()
        self.log.flush()

    def close(self):
        if self.log:
            self.log.close()
            self.log = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False

# =============================================================================
# SELF-ENFORCING COMPLIANCE LOGIC
# =============================================================================

def enforce_compliance():
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
                f"CRITICAL COMPLIANCE FAILURE: '{req}' missing."
            )
    if not isinstance(sys.stdout, TeeLogger):
        raise RuntimeError(
            "CRITICAL COMPLIANCE FAILURE: stdout is not a TeeLogger."
        )
    print("[COMPLIANCE] v13.2.3 Integrity Verified. All 23 modules present.")

# =============================================================================
# SUDO AVAILABILITY CACHE  (v13.2.3)
# =============================================================================

_SUDO_OK = None   # None=unchecked, True=works, False=unavailable

def _sudo_available():
    """Return True if sudo -n true exits 0. Cached after first call."""
    global _SUDO_OK
    if _SUDO_OK is None:
        try:
            _SUDO_OK = subprocess.call(
                ["sudo", "-n", "true"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5
            ) == 0
        except Exception:
            _SUDO_OK = False
        if not _SUDO_OK:
            print(
                "[SUDO:WARN] Non-interactive sudo unavailable. "
                "sudo commands will be skipped. "
                "To enable privileged tools add NOPASSWD rules:\n"
                "  sudo visudo -f /etc/sudoers.d/forensic-probe\n"
                "  owner ALL=(ALL) NOPASSWD: /usr/bin/perf, "
                "/usr/sbin/blktrace, /usr/bin/bpftrace, "
                "/usr/sbin/auditctl, /usr/bin/slabtop, "
                "/usr/bin/execsnoop, /usr/bin/trace-cmd"
            )
    return _SUDO_OK

# =============================================================================
# CORE EXECUTION WRAPPER
# =============================================================================

def run(cmd, timeout=30, capture_output=False):
    # Skip sudo commands instantly when non-interactive sudo is unavailable.
    # Without this guard each sudo call blocks for 30s waiting for a password.
    if cmd and str(cmd[0]) == "sudo" and not _sudo_available():
        print(f"[SKIP:SUDO] {' '.join(str(c) for c in cmd)}")
        return None

    print(f"\n[COMMAND] {' '.join(str(c) for c in cmd)}")
    print(f"[TIME]    {datetime.datetime.now().isoformat()}")
    try:
        p = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True
        )
        out_lines = []

        def stream(pipe, tag):
            try:
                for line in iter(pipe.readline, ""):
                    clean = line.rstrip()
                    print(f"{tag} {clean}")
                    if capture_output:
                        out_lines.append(clean)
            except Exception:
                pass

        t1 = Thread(target=stream, args=(p.stdout, "[STDOUT]"))
        t2 = Thread(target=stream, args=(p.stderr, "[STDERR]"))
        t1.start()
        t2.start()

        try:
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            print(f"[TIMEOUT] {timeout}s exceeded. Killing process group...")
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            p.wait()

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
    print("\n[MODULE:DOCTOR] SELF-HEALING ENVIRONMENT AUDIT")
    if os.path.exists("/.dockerenv"):
        print("[DOCTOR:INFO] Containerized environment detected.")
    else:
        print("[DOCTOR:INFO] Non-containerized environment.")

    if os.access(LOG_DIR, os.W_OK):
        print(f"[DOCTOR:SUCCESS] Log directory writable: {LOG_DIR}")
    else:
        print(f"[DOCTOR:CRITICAL] Log directory NOT writable: {LOG_DIR}")

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

    print("[DOCTOR:AUDIT] Checking perf tracing capability...")
    try:
        ret = subprocess.call(
            ["sudo", "-n", "perf", "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        if ret == 0:
            print("[DOCTOR:SUCCESS] Perf tracing available.")
        else:
            print("[DOCTOR:WARNING] Perf may be restricted. "
                  "Check /proc/sys/kernel/perf_event_paranoid.")
    except Exception:
        print("[DOCTOR:WARNING] Could not verify perf availability.")

    if shutil.which("systemctl"):
        print("[DOCTOR:AUDIT] systemd-oomd status and reclamation journal...")
        run(["systemctl", "status", "systemd-oomd", "--no-pager"], timeout=5)
        run(["journalctl", "-u", "systemd-oomd", "--since", "1 hour ago",
             "--no-pager"], timeout=15)

    if shutil.which("systemctl"):
        print("[DOCTOR:AUDIT] dbus-broker status...")
        run(["systemctl", "status", "dbus-broker", "--no-pager"], timeout=5)

    if os.path.exists("/proc/sys/kernel/random/entropy_avail"):
        with open("/proc/sys/kernel/random/entropy_avail") as f:
            entropy = f.read().strip()
        print(f"[METRIC:ENTROPY] {entropy}")
        if int(entropy) < 200:
            SUMMARY_LINES.append(
                f"WARNING: Low system entropy ({entropy} bits). "
                "Cryptographic ops may block."
            )


def psi():
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
                            f"CRITICAL: High {resource.upper()} pressure: "
                            f"{val}% (avg10). Tasks stalling right now."
                        )
        else:
            print(f"[PSI:WARN] {path} not found — kernel < 4.20 or CONFIG_PSI=n")


def core_imbalance_check():
    print("\n[MODULE:CPU_CORE] CORE IMBALANCE AUDIT")
    out = run(["mpstat", "-P", "ALL", "1", "1"], capture_output=True)
    if not out:
        return

    lines      = out.split("\n")
    header_idx = next((i for i, l in enumerate(lines) if "%idle" in l), -1)
    if header_idx == -1:
        print("[CPU_CORE:WARN] mpstat header not found.")
        return

    headers = lines[header_idx].split()
    try:
        idle_idx = headers.index("%idle")
        # Dynamic CPU column — avoids hardcoded parts[2] which breaks when
        # mpstat includes a timestamp column on some distributions.
        cpu_idx  = headers.index("CPU")
    except ValueError:
        print("[CPU_CORE:WARN] CPU or %idle column not in mpstat header.")
        return

    for line in lines[header_idx + 1:]:
        parts = line.split()
        if not parts or "all" in line:
            continue
        if len(parts) <= max(idle_idx, cpu_idx):
            continue
        try:
            idle = float(parts[idle_idx])
            core = parts[cpu_idx]
            print(f"[METRIC:CPU_CORE_{core}_IDLE] {idle}")
            DatabaseManager.log_metric(CURRENT_RUN_ID, f"CPU_CORE_{core}_IDLE", idle)
            if idle < 5.0:
                SUMMARY_LINES.append(
                    f"WARNING: Core {core} saturated (idle: {idle}%). "
                    "Check IRQ affinity, execsnoop, and auditd backlog."
                )
                print(f"[ACTION] Core {core} saturated. Running hardware counter audit...")
                run(["sudo", "perf", "stat", "-a", "-C", core, "sleep", "2"], timeout=10)
        except (ValueError, IndexError):
            pass


def cpu_sched():
    print("\n[MODULE:CPU_SCHED] SCHEDULER AND PROCESS AUDIT")
    run(["vmstat", "1", "3"])
    run(["pidstat", "-u", "1", "3"])
    run(["pidstat", "-w", "1", "3"])

    out = run(["uptime"], capture_output=True)
    if out:
        print(f"[METRIC:UPTIME] {out.strip()}")
        match = re.search(r"load average:\s+([\d.]+)", out)
        if match:
            load = float(match.group(1))
            print(f"[METRIC:LOAD_AVG] {load}")
            DatabaseManager.log_metric(CURRENT_RUN_ID, "LOAD_AVG_1M", load)


def perf_stat_system():
    print("\n[MODULE:PERF_STAT] SYSTEM-WIDE HARDWARE COUNTERS (5s)")
    run(["sudo", "perf", "stat", "-a", "sleep", "5"], timeout=10)


def perf_analysis(probe_ts):
    print("\n[MODULE:PERF] CPU CYCLE AND SCHEDULER TRACING (5s)")
    perf_data = os.path.join(LOG_DIR, f"perf_{probe_ts}.data")
    run(["sudo", "perf", "record", "-o", perf_data, "-a", "-g", "sleep", "5"], timeout=10)
    run(["sudo", "perf", "report", "-i", perf_data, "--stdio", "--max-stack", "10"])


def memory():
    print("\n[MODULE:MEM] MEMORY PRESSURE AND SLAB AUDIT")
    run(["vmstat", "-s"])
    run(["pidstat", "-r", "1", "3"])
    run(["slabtop", "-o", "-n", "1"])

    out = run(["lsof"], capture_output=True)
    if out:
        count = out.count("\n") - 1
        print(f"[METRIC:OPEN_FILES] {count}")
        DatabaseManager.log_metric(CURRENT_RUN_ID, "OPEN_FILES", count)


def numa_audit():
    print("\n[MODULE:NUMA] LOCALITY CONTENTION AUDIT")
    run(["numastat"])


def disk():
    print("\n[MODULE:DISK] I/O LATENCY AND THROUGHPUT")
    out = run(["iostat", "-xz", "1", "3"], capture_output=True)
    if not out or "%util" not in out:
        return

    lines      = out.split("\n")
    header_idx = next((i for i, l in enumerate(lines) if "%util" in l), -1)
    if header_idx == -1:
        return

    headers = lines[header_idx].split()
    try:
        # Dynamic column lookup — sysstat column order varies by version.
        util_idx = headers.index("%util")
        dev_idx  = 0   # Device is always column 0 in iostat -x output
    except ValueError:
        print("[DISK:WARN] %util column not found in iostat header.")
        return

    for line in lines[header_idx + 1:]:
        parts = line.split()
        if not parts or len(parts) <= util_idx:
            continue
        try:
            util = float(parts[util_idx])
            dev  = parts[dev_idx]
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
    print("\n[MODULE:BLKTRACE] BLOCK LAYER LATENCY TRACE (5s)")
    disk_out = run(
        ["bash", "-c", "lsblk -no NAME,TYPE | awk '$2==\"disk\"{print $1; exit}'"],
        capture_output=True
    )
    if not disk_out:
        print("[BLKTRACE:WARN] No block disk device found — skipping.")
        return
    disk_dev = disk_out.strip()
    run(["sudo", "blktrace", "-d", f"/dev/{disk_dev}", "-w", "5"], timeout=10)
    if shutil.which("blkparse"):
        run(["sudo", "blkparse", "-i", disk_dev])


def network():
    print("\n[MODULE:NET] SOCKET AND PROTOCOL AUDIT")
    run(["ss", "-tulnp"])
    run(["ss", "-ti"])
    run(["ss", "-s"])
    run(["netstat", "-s"])
    print("[ACTION] Checking network latency to 8.8.8.8...")
    run(["ping", "-c", "3", "8.8.8.8"])
    out = run(["ss", "-t", "-a"], capture_output=True)
    if out:
        count = out.count("\n") - 1
        print(f"[METRIC:TCP_CONNS] {count}")
        DatabaseManager.log_metric(CURRENT_RUN_ID, "TCP_CONNS", count)


def network_interface_stats():
    print("\n[MODULE:NICSTAT] INTERFACE THROUGHPUT AUDIT")
    if shutil.which("nicstat"):
        run(["nicstat", "1", "2"])
    else:
        print("[NICSTAT:WARN] nicstat not found — install nicstat package.")


def kernel():
    print("\n[MODULE:KERNEL] LOGS AND MODULE AUDIT")
    run(["dmesg", "--ctime", "--level=err,warn"])
    run(["lsmod"])


def kernel_function_trace():
    print("\n[MODULE:FTRACE] KERNEL FUNCTION TRACING (5s)")
    if shutil.which("trace-cmd"):
        run(["sudo", "trace-cmd", "record", "-p", "function", "sleep", "5"], timeout=10)
        run(["sudo", "trace-cmd", "report"])
    else:
        print("[FTRACE:WARN] trace-cmd not found — install trace-cmd package.")


def cgroup():
    print("\n[MODULE:CGROUP] THROTTLING AND QUOTA AUDIT")
    if os.path.exists("/sys/fs/cgroup"):
        run(["bash", "-c", "find /sys/fs/cgroup -maxdepth 2 -type f | head -n 20"])


def irq_affinity_audit():
    print("\n[MODULE:IRQ] AFFINITY AND INTERRUPT STORM AUDIT")
    run(["bash", "-c", "grep . /proc/irq/*/smp_affinity_list"])
    run(["cat", "/proc/interrupts"])


def irq_rate_audit():
    print("\n[MODULE:IRQ_RATE] PER-SECOND INTERRUPT RATES (5s via sar)")
    if shutil.which("sar"):
        run(["sar", "-I", "ALL", "1", "5"], timeout=10)
    else:
        print("[IRQ_RATE:WARN] sar not found — install sysstat package.")


def auditd_check():
    print("\n[MODULE:AUDITD] LOGGING OVERHEAD AUDIT")
    if shutil.which("auditctl"):
        run(["sudo", "auditctl", "-s"])
    else:
        print("[AUDITD:WARN] auditctl not found — install audit package.")


def short_lived_process_trace():
    print("\n[MODULE:BCC] TRACING TRANSIENT PROCESSES (5s via execsnoop)")
    if shutil.which("execsnoop"):
        run(["sudo", "execsnoop", "-d", "5"], timeout=10)
    else:
        print("[BCC:WARN] execsnoop not found — install bcc-tools package.")


def scheduler_latency_hist():
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
        "interval:s:5 { exit(); }"
    )
    run(["sudo", "bpftrace", "-e", expr], timeout=10)


def selinux_audit():
    print("\n[MODULE:SELINUX] SECURITY POLICY AND AVC DENIAL AUDIT")
    if shutil.which("sestatus"):
        out = run(["sestatus"], capture_output=True)
        if out:
            mode_match = re.search(r"Current mode:\s+(\w+)", out)
            if mode_match:
                print(f"[METRIC:SELINUX_MODE] {mode_match.group(1)}")

    if shutil.which("ausearch"):
        print("[ACTION] Searching audit log for recent AVC denials (last 10 min)...")
        out = run(
            ["sudo", "ausearch", "-m", "AVC", "-ts", "recent"],
            timeout=20,
            capture_output=True
        )
        if out:
            # \s+ matches both "avc: denied" and "avc:  denied" spacing variants.
            count = len(re.findall(r"avc:\s+denied", out))
            print(f"[METRIC:SELINUX_DENIALS] {count}")
            DatabaseManager.log_metric(CURRENT_RUN_ID, "SELINUX_DENIALS", count)
            if count > 0:
                SUMMARY_LINES.append(
                    f"CRITICAL: {count} SELinux AVC denials in last 10 min. "
                    "High denial rate causes auditd CPU load and latency."
                )
    else:
        print("[SELINUX:WARN] ausearch not found — install audit package.")


def rank_root_causes():
    print("\n[MODULE:SUMMARY] AUTOMATED RANKED ROOT-CAUSE ANALYSIS")
    if not SUMMARY_LINES:
        print("[SUMMARY:INFO] No critical anomalies detected.")
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
    print(f"\n[MODULE:REPORT] GENERATING HTML DASHBOARD: {HTML_FILE}")
    rows = "".join([
        f'<li class="{"critical" if "CRITICAL" in l else ("warning" if "WARNING" in l else "info")}">{l}</li>'
        for l in SUMMARY_LINES
    ]) if SUMMARY_LINES else "<li class='info'>No anomalies detected.</li>"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Forensic Latency Report v13.2.3</title>
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
    global SUMMARY_LINES
    SUMMARY_LINES = []

    global CURRENT_RUN_ID
    probe_ts  = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    probe_log = os.path.join(LOG_DIR, f"latency_probe_v13_{probe_ts}.log")

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

            enforce_compliance()

            module_map = {
                "DEPS":      DependencyManager.ensure_deps,
                "DOCTOR":    doctor,
                "PSI":       psi,
                "CPU_CORE":  core_imbalance_check,
                "CPU_SCHED": cpu_sched,
                "PERF_STAT": perf_stat_system,
                "MEM":       memory,
                "NUMA":      numa_audit,
                "DISK":      disk,
                "NET":       network,
                "NICSTAT":   network_interface_stats,
                "KERNEL":    kernel,
                "CGROUP":    cgroup,
                "IRQ":       irq_affinity_audit,
                "IRQ_RATE":  irq_rate_audit,
                "AUDITD":    auditd_check,
                "SELINUX":   selinux_audit,
                "BCC":       short_lived_process_trace,
                "PERF":      lambda: perf_analysis(probe_ts),
                "BLKTRACE":  block_layer_trace,
                "FTRACE":    kernel_function_trace,
                "BPFTRACE":  scheduler_latency_hist,
                "SUMMARY":   rank_root_causes,
                "REPORT":    generate_html_report,
            }

            if module:
                if module in module_map:
                    module_map[module]()
                else:
                    print(f"[ERROR] Unknown module '{module}'. "
                          f"Valid: {', '.join(sorted(module_map))}")
            else:
                # Full pipeline — irq_rate_audit called ONCE after irq_affinity_audit.
                DependencyManager.ensure_deps()
                doctor()
                psi()
                core_imbalance_check()
                cpu_sched()
                perf_stat_system()
                memory()
                numa_audit()
                disk()
                network()
                network_interface_stats()
                kernel()
                cgroup()
                irq_affinity_audit()
                irq_rate_audit()
                auditd_check()
                selinux_audit()
                short_lived_process_trace()

                if advanced:
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
            sys.stdout = sys.__stdout__
            sys.stderr = sys.__stderr__


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Forensic Latency Analyzer v13.2.3")
    parser.add_argument("--loop",     type=int,  default=0,    help="Repeat every N seconds")
    parser.add_argument("--advanced", action="store_true",     help="Enable perf/blktrace/ftrace/bpftrace")
    parser.add_argument("--module",   type=str,  default=None, help="Run one module by name")
    args = parser.parse_args()

    try:
        if args.loop > 0:
            while True:
                run_probe(advanced=args.advanced, module=args.module)
                print(f"[LOOP] Sleeping {args.loop}s...")
                time.sleep(args.loop)
        else:
            run_probe(advanced=args.advanced, module=args.module)
    except KeyboardInterrupt:
        print("\n[STOPPED] Probe interrupted by user.")
    except Exception:
        traceback.print_exc()
        sys.exit(1)