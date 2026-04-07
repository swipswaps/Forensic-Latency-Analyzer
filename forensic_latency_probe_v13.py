#!/usr/bin/env python3
# =============================================================================
# forensic_latency_probe_v13.py
# =============================================================================
# CANONICAL FORENSIC LATENCY ANALYZER v13.3.0
# Adds: firefox_forensic module, per-process strace, storm detection,
#       process signal support (SIGSTOP/SIGCONT/SIGKILL via --signal flag)
# =============================================================================

import os
import sys
import subprocess
import shutil
import datetime
import traceback
import argparse
import time
import re
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
    "sysstat": "sysstat",
    "iproute2": "iproute",
    "iputils-ping": "iputils",
    "traceroute": "traceroute",
    "lsof": "lsof",
    "strace": "strace",
    "linux-perf": "perf",
    "net-tools": "net-tools",
    "iotop": "iotop",
    "blktrace": "blktrace",
    "trace-cmd": "trace-cmd",
    "bpftrace": "bpftrace",
    "nicstat": "nicstat",
    "numactl": "numactl",
    "auditd": "audit",
    "bcc-tools": "bcc-tools",
    "policycoreutils": "policycoreutils",
}

APT_PACKAGES = list(DNF_MAP.keys())

SUMMARY_LINES = []
CURRENT_RUN_ID = None

# =============================================================================
# DATABASE MANAGEMENT
# =============================================================================

class DatabaseManager:
    @staticmethod
    def init_db():
        print(f"[DB:INIT] Ensuring robust log database at {DB_FILE}")
        try:
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
                    mode TEXT,
                    status TEXT,
                    log_path TEXT,
                    html_path TEXT,
                    summary TEXT,
                    process_tree TEXT
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS metrics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER,
                    key TEXT,
                    value REAL,
                    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(run_id) REFERENCES runs(id)
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER,
                    severity TEXT,
                    message TEXT,
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
            conn = sqlite3.connect(DB_FILE)
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
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE runs SET status = ?, log_path = ?, html_path = ?, summary = ? WHERE id = ?",
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
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute("INSERT INTO metrics (run_id, key, value) VALUES (?, ?, ?)", (run_id, key, value))
            conn.commit()
            conn.close()
        except Exception:
            pass

    @staticmethod
    def log_alert(run_id, severity, message):
        if not run_id: return
        try:
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute("INSERT INTO alerts (run_id, severity, message) VALUES (?, ?, ?)", (run_id, severity, message))
            conn.commit()
            conn.close()
        except Exception:
            pass

# =============================================================================
# DEPENDENCY MANAGEMENT
# =============================================================================

class DependencyManager:
    @staticmethod
    def ensure_deps():
        print("\n[MODULE:DEPS] VERIFYING SYSTEM DEPENDENCIES")
        missing = [t for t in REQUIRED_TOOLS if shutil.which(t) is None]
        if not missing:
            print("[DEPS:SUCCESS] All tools present in PATH.")
            return
        if os.path.exists(DEPS_MARKER):
            print("[DEPS:IDEMPOTENT] Marker file found. Skipping package manager install.")
            return
        print(f"[DEPS:ACTION] Missing tools detected: {missing}. Initiating recoverable install.")
        sudo_works = run(["sudo", "-n", "true"], timeout=5) == 0
        if not sudo_works:
            print("[DEPS:WARNING] Non-interactive sudo failed.")
            return
        for attempt in range(3):
            try:
                if shutil.which("apt-get"):
                    run(["sudo", "-n", "apt-get", "update"], timeout=60)
                    ret = run(["sudo", "-n", "apt-get", "install", "-y"] + APT_PACKAGES, timeout=120)
                    if ret == 0:
                        with open(DEPS_MARKER, "w") as f: f.write(datetime.datetime.now().isoformat())
                        break
                elif shutil.which("dnf"):
                    DNF_PACKAGES = [DNF_MAP.get(p, p) for p in APT_PACKAGES]
                    ret = run(["sudo", "-n", "dnf", "install", "-y"] + DNF_PACKAGES, timeout=120)
                    if ret == 0:
                        with open(DEPS_MARKER, "w") as f: f.write(datetime.datetime.now().isoformat())
                        break
            except Exception as e:
                print(f"[DEPS:RETRY] Attempt {attempt+1} failed: {e}")
                time.sleep(5)
        missing_after = [t for t in REQUIRED_TOOLS if shutil.which(t) is None]
        if missing_after:
            print(f"[DEPS:WARNING] Some tools still missing: {missing_after}")

# =============================================================================
# LOGGING
# =============================================================================

class TeeLogger:
    def __init__(self, logfile):
        self.logfile = logfile
        self.log = open(logfile, "a", buffering=1)
        self.terminal_stdout = sys.__stdout__
        self.terminal_stderr = sys.__stderr__

    def write(self, msg):
        self.terminal_stdout.write(msg)
        self.log.write(msg)

    def flush(self):
        self.terminal_stdout.flush()
        self.log.flush()

    def fileno(self):
        return self.terminal_stdout.fileno()

    def isatty(self):
        return False

    def close(self):
        if self.log:
            self.log.close()
            self.log = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

# =============================================================================
# COMPLIANCE
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
        "doctor", "perf_stat_system", "irq_rate_audit", "firefox_forensic"
    ]
    for req in required:
        if req not in globals():
            raise RuntimeError(f"CRITICAL COMPLIANCE FAILURE: Feature {req} missing.")
    if not isinstance(sys.stdout, TeeLogger):
        print("[COMPLIANCE:WARNING] stdout is not a TeeLogger.")
    print("[COMPLIANCE] v13.3.0 Integrity Verified. No omissions.")

# =============================================================================
# CORE EXECUTION WRAPPER
# =============================================================================

def run(cmd, timeout=30, capture_output=False):
    print(f"\n[COMMAND] {' '.join(str(c) for c in cmd)}")
    print(f"[TIME]    {datetime.datetime.now().isoformat()}")

    if cmd[0] == "sudo":
        try:
            res = subprocess.call(["sudo", "-n", "true"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if res != 0:
                print(f"[SKIP] Sudo required for '{cmd[1]}' but non-interactive access is denied.")
                return "" if capture_output else 1
        except:
            return "" if capture_output else 1

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
                for line in iter(pipe.readline, ''):
                    clean_line = line.rstrip()
                    print(f"{tag} {clean_line}")
                    if capture_output: out_lines.append(clean_line)
            except Exception:
                pass

        t1 = Thread(target=stream, args=(p.stdout, "[STDOUT]"))
        t2 = Thread(target=stream, args=(p.stderr, "[STDERR]"))
        t1.start(); t2.start()

        try:
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            print(f"[TIMEOUT] Command timed out after {timeout}s. Killing process group...")
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except OSError:
                pass
            p.wait()

        t1.join(timeout=2)
        t2.join(timeout=2)

        return "\n".join(out_lines) if capture_output else p.returncode
    except Exception:
        traceback.print_exc()
        return None

# =============================================================================
# PROCESS SIGNAL HANDLER
# Called when --signal is passed. Sends SIGSTOP/SIGCONT/SIGKILL to a PID.
# This is the backend for the UI "pause/resume/kill" buttons.
# Outputs structured lines the UI parses for confirmation.
# =============================================================================

def send_signal_to_pid(pid: int, sig: str):
    """
    sig must be one of: STOP, CONT, KILL, TERM
    Prints [SIGNAL:OK] or [SIGNAL:ERROR] for the UI to parse.
    """
    sig_map = {
        "STOP": signal.SIGSTOP,
        "CONT": signal.SIGCONT,
        "KILL": signal.SIGKILL,
        "TERM": signal.SIGTERM,
    }
    if sig not in sig_map:
        print(f"[SIGNAL:ERROR] Unknown signal: {sig}. Use STOP, CONT, KILL, or TERM.")
        return

    # Validate the PID exists before attempting
    proc_dir = f"/proc/{pid}"
    if not os.path.exists(proc_dir):
        print(f"[SIGNAL:ERROR] PID {pid} does not exist.")
        return

    # Read the process name for confirmation output
    try:
        with open(f"{proc_dir}/comm", "r") as f:
            comm = f.read().strip()
    except Exception:
        comm = "unknown"

    # Read current state before acting
    try:
        with open(f"{proc_dir}/status", "r") as f:
            status_lines = f.read()
        state_match = re.search(r"^State:\s+(\S+)\s+\((\w+)\)", status_lines, re.MULTILINE)
        state = state_match.group(2) if state_match else "unknown"
    except Exception:
        state = "unknown"

    print(f"[SIGNAL:INFO] Target: PID {pid} ({comm}), current state: {state}")
    print(f"[SIGNAL:INFO] Sending SIG{sig}...")

    try:
        os.kill(pid, sig_map[sig])
        print(f"[SIGNAL:OK] SIG{sig} sent to PID {pid} ({comm})")

        # Verify state changed for STOP/CONT
        if sig in ("STOP", "CONT"):
            time.sleep(0.3)
            try:
                with open(f"{proc_dir}/status", "r") as f:
                    new_status = f.read()
                new_state = re.search(r"^State:\s+(\S+)\s+\((\w+)\)", new_status, re.MULTILINE)
                new_state_str = new_state.group(2) if new_state else "unknown"
                print(f"[SIGNAL:VERIFY] PID {pid} state is now: {new_state_str}")
            except Exception:
                print(f"[SIGNAL:VERIFY] Could not re-read state (process may have exited)")
    except PermissionError:
        print(f"[SIGNAL:ERROR] Permission denied — try running with sudo or as the process owner")
    except ProcessLookupError:
        print(f"[SIGNAL:ERROR] PID {pid} no longer exists")
    except Exception as e:
        print(f"[SIGNAL:ERROR] {e}")

# =============================================================================
# FIREFOX FORENSIC MODULE
# Produces verbatim tool output, storm detection, and structured alerts.
# All output tagged so the UI can parse it.
# =============================================================================

def firefox_forensic():
    """
    Targeted forensic sweep for Firefox and its content/GPU/socket processes.

    Captures:
    - All Firefox PIDs and their process states
    - Per-PID CPU/MEM from pidstat (1s × 5 samples)
    - Per-PID syscall counts from strace -c (5s attach, non-blocking)
    - Open file descriptors count and top fd types
    - TCP socket retransmits and buffer pressure from ss -ti
    - IPC socket storms from ss -xp
    - OOM and crash events from journalctl matching firefox
    - PSI stall contribution estimate
    - Structured [STORM:] alerts when thresholds are exceeded
    """
    print("\n[MODULE:FIREFOX] FIREFOX PROCESS FORENSIC SWEEP")

    # Step 1: Find all Firefox PIDs
    try:
        result = subprocess.check_output(
            ["pgrep", "-a", "firefox"],
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
    except subprocess.CalledProcessError:
        print("[FIREFOX:INFO] No firefox processes found. Is Firefox running?")
        return

    firefox_pids = []
    for line in result.split("\n"):
        if not line.strip():
            continue
        parts = line.split(None, 1)
        if parts:
            pid = parts[0]
            comm = parts[1] if len(parts) > 1 else "firefox"
            firefox_pids.append((pid, comm))

    print(f"[FIREFOX:INFO] Found {len(firefox_pids)} Firefox process(es):")
    for pid, comm in firefox_pids:
        # Read state from /proc directly — no tool overhead
        try:
            with open(f"/proc/{pid}/status") as f:
                status = f.read()
            state = re.search(r"^State:\s+(\S+\s+\(\w+\))", status, re.MULTILINE)
            threads = re.search(r"^Threads:\s+(\d+)", status, re.MULTILINE)
            vm_rss = re.search(r"^VmRSS:\s+(\d+)", status, re.MULTILINE)
            state_str = state.group(1) if state else "unknown"
            thread_count = threads.group(1) if threads else "?"
            rss_kb = int(vm_rss.group(1)) if vm_rss else 0
            rss_mb = rss_kb // 1024
            print(f"[FIREFOX:PID] {pid} | state={state_str} | threads={thread_count} | rss={rss_mb}MB | cmd={comm[:60]}")
            DatabaseManager.log_metric(CURRENT_RUN_ID, f"FIREFOX_PID_{pid}_RSS_MB", rss_mb)
            if rss_mb > 2000:
                msg = f"WARNING: Firefox PID {pid} consuming {rss_mb}MB RAM"
                print(f"[STORM:MEMORY] {msg}")
                SUMMARY_LINES.append(msg)
                DatabaseManager.log_alert(CURRENT_RUN_ID, "WARNING", msg)
        except Exception:
            print(f"[FIREFOX:PID] {pid} | state=unreadable | cmd={comm[:60]}")

    # Step 2: pidstat — per-PID CPU over 5 seconds (verbatim output shown)
    print("\n[FIREFOX:STEP] CPU usage per Firefox PID (5s sample)")
    pid_args = []
    for pid, _ in firefox_pids:
        pid_args += ["-p", pid]
    if pid_args:
        run(["pidstat"] + pid_args + ["-u", "1", "5"], timeout=12)

    # Step 3: pidstat I/O — disk read/write per PID
    print("\n[FIREFOX:STEP] I/O per Firefox PID (3s sample)")
    if pid_args:
        run(["pidstat"] + pid_args + ["-d", "1", "3"], timeout=8)

    # Step 4: strace syscall summary for the main firefox PID (non-blocking, 5s)
    # This is the key hidden data — shows exactly what syscalls are hammering the kernel
    main_pid = firefox_pids[0][0] if firefox_pids else None
    if main_pid and shutil.which("strace"):
        print(f"\n[FIREFOX:STEP] Syscall frequency for main PID {main_pid} (5s attach)")
        print(f"[FIREFOX:INFO] This shows kernel calls causing latency spikes")
        run(["strace", "-p", main_pid, "-c", "-f", "-e", "trace=all"], timeout=8)

    # Step 5: open file descriptors
    print("\n[FIREFOX:STEP] Open file descriptors")
    for pid, comm in firefox_pids[:3]:  # limit to first 3 to avoid lsof timeout
        try:
            fd_dir = f"/proc/{pid}/fd"
            fds = os.listdir(fd_dir)
            fd_count = len(fds)
            print(f"[FIREFOX:FD] PID {pid} has {fd_count} open file descriptors")
            DatabaseManager.log_metric(CURRENT_RUN_ID, f"FIREFOX_PID_{pid}_FD_COUNT", fd_count)
            if fd_count > 500:
                msg = f"WARNING: Firefox PID {pid} has {fd_count} open FDs — possible fd leak"
                print(f"[STORM:FD] {msg}")
                SUMMARY_LINES.append(msg)
                DatabaseManager.log_alert(CURRENT_RUN_ID, "WARNING", msg)
            # Count by type
            types = {"socket": 0, "pipe": 0, "file": 0, "anon": 0}
            for fd in fds[:200]:  # sample first 200
                try:
                    target = os.readlink(f"{fd_dir}/{fd}")
                    if target.startswith("socket"): types["socket"] += 1
                    elif target.startswith("pipe"):  types["pipe"] += 1
                    elif target.startswith("anon"):  types["anon"] += 1
                    else:                            types["file"] += 1
                except Exception:
                    pass
            print(f"[FIREFOX:FD] Type breakdown (sample): sockets={types['socket']} pipes={types['pipe']} files={types['file']} anon={types['anon']}")
            if types["socket"] > 100:
                msg = f"WARNING: Firefox PID {pid} has {types['socket']} open sockets — network storm possible"
                print(f"[STORM:NETWORK] {msg}")
                SUMMARY_LINES.append(msg)
                DatabaseManager.log_alert(CURRENT_RUN_ID, "WARNING", msg)
        except PermissionError:
            print(f"[FIREFOX:FD] PID {pid} — permission denied reading /proc/{pid}/fd")
        except Exception as e:
            print(f"[FIREFOX:FD] PID {pid} — {e}")

    # Step 6: TCP socket storm detection — ss with internal stats
    print("\n[FIREFOX:STEP] TCP socket analysis (retransmits, buffer pressure)")
    run(["ss", "-tip", f"pid in ({','.join(p for p, _ in firefox_pids)})"], timeout=10)

    # Step 7: IPC/Unix socket storm
    print("\n[FIREFOX:STEP] IPC socket usage")
    run(["ss", "-xp"], timeout=5)

    # Step 8: journalctl for Firefox crashes, OOM kills, Xorg errors
    print("\n[FIREFOX:STEP] System log events involving Firefox (last 1 hour)")
    run(["journalctl", "--since", "1 hour ago", "--no-pager", "--grep", "firefox|Web Content|OOM|segfault|killed"], timeout=10)

    # Step 9: kernel OOM and hung task events
    print("\n[FIREFOX:STEP] Kernel OOM and hung task events")
    run(["dmesg", "--ctime", "--level=err,warn", "--human"], timeout=5)

    # Step 10: PSI contribution — read /proc/pressure and correlate with load
    print("\n[FIREFOX:STEP] Current PSI (pressure stall) snapshot")
    for resource in ["cpu", "memory", "io"]:
        path = f"/proc/pressure/{resource}"
        if os.path.exists(path):
            try:
                with open(path) as f:
                    content = f.read().strip()
                print(f"[FIREFOX:PSI:{resource.upper()}] {content}")
                match = re.search(r"some avg10=([\d.]+)", content)
                if match:
                    val = float(match.group(1))
                    if val > 20.0:
                        msg = f"CRITICAL: {resource.upper()} PSI avg10={val}% — system stalling, Firefox likely contributor"
                        print(f"[STORM:PSI] {msg}")
                        SUMMARY_LINES.append(msg)
                        DatabaseManager.log_alert(CURRENT_RUN_ID, "CRITICAL", msg)
            except Exception as e:
                print(f"[FIREFOX:PSI:{resource.upper()}] Error: {e}")

    # Step 11: Summary — print what the user should do
    print("\n[FIREFOX:SUMMARY] Actions available from the UI:")
    for pid, comm in firefox_pids:
        short = comm.split()[0] if comm else "firefox"
        print(f"[FIREFOX:ACTION] PID {pid} ({short}): PAUSE (SIGSTOP), RESUME (SIGCONT), KILL (SIGKILL), RENICE (+10)")

    print("\n[FIREFOX:DONE] Firefox forensic sweep complete.")

# =============================================================================
# EXISTING FORENSIC MODULES (unchanged)
# =============================================================================

def doctor():
    print("\n[MODULE:DOCTOR] SELF-HEALING ENVIRONMENT AUDIT")
    if os.path.exists("/.dockerenv"):
        print("[DOCTOR:INFO] Containerized environment detected (Docker).")
    else:
        print("[DOCTOR:INFO] Non-containerized or alternative container environment.")
    if os.access(LOG_DIR, os.W_OK):
        print(f"[DOCTOR:SUCCESS] Log directory {LOG_DIR} is writable.")
    else:
        print(f"[DOCTOR:CRITICAL] Log directory {LOG_DIR} is NOT writable!")
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("SELECT count(*) FROM runs")
        count = cursor.fetchone()[0]
        print(f"[DOCTOR:SUCCESS] Database healthy. Total runs tracked: {count}")
        conn.close()
    except Exception as e:
        print(f"[DOCTOR:CRITICAL] Database corruption detected: {e}. Attempting recovery...")
        DatabaseManager.init_db()
    print("[DOCTOR:AUDIT] Checking kernel tracing capabilities...")
    try:
        ret = subprocess.call(["sudo", "-n", "perf", "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ret == 0: print("[DOCTOR:SUCCESS] Perf tracing available.")
        else: print("[DOCTOR:WARNING] Perf tracing might be restricted (CAP_SYS_ADMIN missing).")
    except: print("[DOCTOR:WARNING] Could not verify perf capabilities.")
    if shutil.which("systemctl"):
        print("[DOCTOR:AUDIT] Checking systemd-oomd status...")
        run(["systemctl", "status", "systemd-oomd", "--no-pager"], timeout=5)
        run(["journalctl", "-u", "systemd-oomd", "--since", "1 hour ago", "--no-pager"], timeout=15)
    if shutil.which("systemctl"):
        print("[DOCTOR:AUDIT] Checking dbus-broker status...")
        run(["systemctl", "status", "dbus-broker", "--no-pager"], timeout=5)
    if os.path.exists("/proc/sys/kernel/random/entropy_avail"):
        with open("/proc/sys/kernel/random/entropy_avail", "r") as f:
            entropy = f.read().strip()
            print(f"[METRIC:ENTROPY] {entropy}")
            if int(entropy) < 200:
                SUMMARY_LINES.append(f"WARNING: Low system entropy: {entropy}")

def psi():
    print("\n[MODULE:PSI] PRESSURE STALL INFORMATION (5 samples)")
    for f in ["cpu", "memory", "io"]:
        path = f"/proc/pressure/{f}"
        if os.path.exists(path):
            out = run(["cat", path], capture_output=True)
            if "some avg10=" in str(out):
                match = re.search(r"avg10=([\d.]+)", str(out))
                if match:
                    val = float(match.group(1))
                    print(f"[METRIC:{f.upper()}_PRESSURE] {val}")
                    DatabaseManager.log_metric(CURRENT_RUN_ID, f"{f.upper()}_PRESSURE", val)
                    if val > 5.0:
                        SUMMARY_LINES.append(f"CRITICAL: High {f.upper()} pressure detected: {val}%")

def core_imbalance_check():
    print("\n[MODULE:CPU_CORE] CORE IMBALANCE AUDIT")
    out = run(["mpstat", "-P", "ALL", "1", "1"], capture_output=True)
    if out:
        lines = out.split("\n")
        header_idx = -1
        for i, line in enumerate(lines):
            if "%idle" in line:
                header_idx = i
                break
        if header_idx != -1:
            headers = lines[header_idx].split()
            try:
                idle_idx = headers.index("%idle")
                cpu_idx = headers.index("CPU")
                for line in lines[header_idx+1:]:
                    parts = line.split()
                    if len(parts) > max(idle_idx, cpu_idx) and "all" not in line:
                        try:
                            idle = float(parts[idle_idx])
                            core = parts[cpu_idx]
                            print(f"[METRIC:CPU_CORE_{core}_IDLE] {idle}")
                            DatabaseManager.log_metric(CURRENT_RUN_ID, f"CPU_CORE_{core}_IDLE", idle)
                            if idle < 5.0:
                                SUMMARY_LINES.append(f"WARNING: CPU Core {core} is saturated (idle: {idle}%)")
                                run(["sudo", "perf", "stat", "-a", "-C", core, "sleep", "2"], timeout=10)
                        except: pass
            except ValueError:
                print("[ERROR] Could not find expected headers in mpstat output.")

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
            print(f"[METRIC:LOAD_AVG] {match.group(1)}")

def perf_analysis(probe_ts):
    print("\n[MODULE:PERF] CPU CYCLE AND SCHEDULER TRACING (5s)")
    perf_data = os.path.join(LOG_DIR, f"perf_{probe_ts}.data")
    run(["sudo", "perf", "record", "-o", perf_data, "-a", "-g", "sleep", "5"], timeout=10)
    run(["sudo", "perf", "report", "-i", perf_data, "--stdio", "--max-stack", "10"])

def perf_stat_system():
    print("\n[MODULE:PERF_STAT] SYSTEM-WIDE HARDWARE COUNTERS (5s)")
    run(["sudo", "perf", "stat", "-a", "sleep", "5"], timeout=10)

def memory():
    print("\n[MODULE:MEM] MEMORY PRESSURE AND SLAB AUDIT")
    run(["vmstat", "-s"])
    run(["pidstat", "-r", "1", "3"])
    run(["slabtop", "-o", "-n", "1"])
    out = run(["lsof"], capture_output=True)
    if out:
        count = out.count("\n") - 1
        print(f"[METRIC:OPEN_FILES] {count}")

def numa_audit():
    print("\n[MODULE:NUMA] LOCALITY CONTENTION AUDIT")
    run(["numastat"])

def disk():
    print("\n[MODULE:DISK] I/O LATENCY AND THROUGHPUT")
    out = run(["iostat", "-xz", "1", "3"], capture_output=True)
    if out and "%util" in out:
        lines = out.split("\n")
        last_header_idx = -1
        for i, line in enumerate(lines):
            if "Device" in line and "%util" in line:
                last_header_idx = i
        if last_header_idx != -1:
            headers = lines[last_header_idx].split()
            try:
                util_idx = headers.index("%util")
                dev_idx = headers.index("Device")
                for line in lines[last_header_idx+1:]:
                    if line.strip() == "": break
                    parts = line.split()
                    if len(parts) > max(util_idx, dev_idx):
                        try:
                            util = float(parts[util_idx])
                            dev = parts[dev_idx]
                            print(f"[METRIC:DISK_{dev}_UTIL] {util}")
                            DatabaseManager.log_metric(CURRENT_RUN_ID, f"DISK_{dev}_UTIL", util)
                            if util > 80.0:
                                SUMMARY_LINES.append(f"CRITICAL: Disk {dev} is {util}% utilized")
                        except: pass
            except ValueError:
                print("[ERROR] Could not find expected headers in iostat output.")

def block_layer_trace():
    print("\n[MODULE:BLKTRACE] BLOCK LAYER LATENCY TRACE (5s)")
    disk_dev_out = run(["bash", "-c", "lsblk -no NAME,TYPE | awk -v t=disk '$2==t{print $1; exit}'"], capture_output=True)
    if disk_dev_out:
        disk_dev = disk_dev_out.strip()
        dev_path = f"/dev/{disk_dev}"
        run(["sudo", "blktrace", "-d", dev_path, "-w", "5"], timeout=10)
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

def network_interface_stats():
    print("\n[MODULE:NICSTAT] INTERFACE THROUGHPUT AUDIT")
    if shutil.which("nicstat"):
        run(["nicstat", "1", "2"])

def kernel():
    print("\n[MODULE:KERNEL] LOGS AND MODULE AUDIT")
    run(["dmesg", "--ctime", "--level=err,warn"])
    run(["lsmod"])

def kernel_function_trace():
    print("\n[MODULE:FTRACE] KERNEL FUNCTION TRACING (5s)")
    if shutil.which("trace-cmd"):
        run(["sudo", "trace-cmd", "record", "-p", "function", "sleep", "5"], timeout=10)
        run(["sudo", "trace-cmd", "report"])

def cgroup():
    print("\n[MODULE:CGROUP] THROTTLING AND QUOTA AUDIT")
    if os.path.exists("/sys/fs/cgroup"):
        run(["bash", "-c", "find /sys/fs/cgroup -maxdepth 2 -type f | head -n 20"])

def irq_affinity_audit():
    print("\n[MODULE:IRQ] AFFINITY AND INTERRUPT STORM AUDIT")
    run(["bash", "-c", "grep . /proc/irq/*/smp_affinity_list"])
    run(["cat", "/proc/interrupts"])

def irq_rate_audit():
    print("\n[MODULE:IRQ_RATE] PER-SECOND INTERRUPT RATES (5s)")
    if shutil.which("sar"):
        run(["sar", "-I", "ALL", "1", "5"], timeout=10)

def auditd_check():
    print("\n[MODULE:AUDITD] LOGGING OVERHEAD AUDIT")
    if shutil.which("auditctl"):
        run(["sudo", "auditctl", "-s"])

def short_lived_process_trace():
    print("\n[MODULE:BCC] TRACING TRANSIENT PROCESSES (5s)")
    if shutil.which("execsnoop"):
        run(["sudo", "execsnoop", "-d", "5"], timeout=10)

def scheduler_latency_hist():
    print("\n[MODULE:BPFTRACE] RUN-QUEUE LATENCY HISTOGRAM (5s)")
    if shutil.which("bpftrace"):
        expr = "sched:sched_wakeup { @start[args->pid] = nsecs; } sched:sched_switch { if (@start[prev_pid]) { @latency = hist(nsecs - @start[prev_pid]); delete(@start[prev_pid]); } } interval:s:5 { exit(); }"
        run(["sudo", "bpftrace", "-e", expr], timeout=10)

def selinux_audit():
    print("\n[MODULE:SELINUX] SECURITY POLICY AND AVC DENIAL AUDIT")
    if shutil.which("sestatus"):
        out = run(["sestatus"], capture_output=True)
        if out:
            mode = re.search(r"Current mode:\s+(\w+)", out)
            if mode:
                print(f"[METRIC:SELINUX_MODE] {mode.group(1)}")
    if shutil.which("ausearch"):
        print("[ACTION] Searching for recent AVC denials...")
        out = run(["sudo", "ausearch", "-m", "AVC", "-ts", "recent"], timeout=20, capture_output=True)
        if out:
            count = len(re.findall(r"avc:\s+denied", out))
            print(f"[METRIC:SELINUX_DENIALS] {count}")
            DatabaseManager.log_metric(CURRENT_RUN_ID, "SELINUX_DENIALS", count)
            if count > 0:
                SUMMARY_LINES.append(f"CRITICAL: {count} SELinux AVC denials detected in last 10 mins.")

def rank_root_causes():
    print("\n[MODULE:SUMMARY] AUTOMATED RANKED ROOT-CAUSE ANALYSIS")
    if not SUMMARY_LINES:
        print("INFO: No critical anomalies detected.")
        return
    sorted_summary = sorted(SUMMARY_LINES, key=lambda x: 0 if "CRITICAL" in x else (1 if "WARNING" in x else 2))
    for line in sorted_summary:
        print(f"[RANKED_ALERT] {line}")
        sev = "CRITICAL" if "CRITICAL" in line else ("WARNING" if "WARNING" in line else "INFO")
        DatabaseManager.log_alert(CURRENT_RUN_ID, sev, line)

def generate_html_report():
    print(f"\n[MODULE:REPORT] GENERATING HTML DASHBOARD: {HTML_FILE}")
    html_content = f"""
    <html><head><title>Forensic Latency Report v13.3.0</title>
    <style>
        body {{ font-family: sans-serif; background: #f8f9fa; padding: 20px; }}
        .card {{ background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
        .critical {{ color: #dc3545; font-weight: bold; }}
        .warning {{ color: #ffc107; font-weight: bold; }}
        .info {{ color: #0d6efd; }}
        pre {{ background: #212529; color: #f8f9fa; padding: 15px; border-radius: 4px; overflow-x: auto; }}
    </style></head>
    <body>
        <h1>Forensic Latency Report v13.3.0</h1>
        <p>Generated: {datetime.datetime.now().isoformat()}</p>
        <div class="card"><h2>Ranked Root Causes</h2><ul>
            {"".join([f'<li class="{"critical" if "CRITICAL" in l else ("warning" if "WARNING" in l else "info")}">{l}</li>' for l in SUMMARY_LINES])}
        </ul></div>
    </body></html>
    """
    with open(HTML_FILE, "w") as f:
        f.write(html_content)

# =============================================================================
# MAIN PROBE RUNNER
# =============================================================================

def run_probe(advanced=False, module=None):
    global SUMMARY_LINES
    SUMMARY_LINES = []
    global CURRENT_RUN_ID

    probe_ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    probe_log = os.path.join(LOG_DIR, f"latency_probe_v13_{probe_ts}.log")

    print(os.path.abspath(probe_log))
    sys.stdout.flush()

    with TeeLogger(probe_log) as logger:
        sys.stdout = logger
        sys.stderr = logger
        try:
            DatabaseManager.init_db()
            CURRENT_RUN_ID = DatabaseManager.start_run(
                "ADVANCED" if advanced else ("MODULE:" + module if module else "STANDARD")
            )
            print(f"[RUN_ID] {CURRENT_RUN_ID}")
            sys.stdout.flush()

            enforce_compliance()

            module_map = {
                "DEPS":     DependencyManager.ensure_deps,
                "PSI":      psi,
                "CPU_CORE": core_imbalance_check,
                "CPU_SCHED":cpu_sched,
                "PERF_STAT":perf_stat_system,
                "IRQ_RATE": irq_rate_audit,
                "MEM":      memory,
                "NUMA":     numa_audit,
                "DISK":     disk,
                "NET":      network,
                "NICSTAT":  network_interface_stats,
                "KERNEL":   kernel,
                "FTRACE":   kernel_function_trace,
                "CGROUP":   cgroup,
                "IRQ":      irq_affinity_audit,
                "AUDITD":   auditd_check,
                "SELINUX":  selinux_audit,
                "BCC":      short_lived_process_trace,
                "PERF":     lambda: perf_analysis(probe_ts),
                "BLKTRACE": block_layer_trace,
                "BPFTRACE": scheduler_latency_hist,
                "SUMMARY":  rank_root_causes,
                "REPORT":   generate_html_report,
                "DOCTOR":   doctor,
                "FIREFOX":  firefox_forensic,
            }

            if module:
                if module in module_map:
                    module_map[module]()
                else:
                    print(f"[ERROR] Unknown module: {module}")
            else:
                # Full pipeline
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
                firefox_forensic()  # Always run Firefox forensics in full pipeline

                if advanced:
                    perf_analysis(probe_ts)
                    block_layer_trace()
                    kernel_function_trace()
                    scheduler_latency_hist()

                rank_root_causes()
                generate_html_report()

            DatabaseManager.update_run_status(CURRENT_RUN_ID, "SUCCESS", probe_log, HTML_FILE, "\n".join(SUMMARY_LINES))
            print(f"\n[COMPLETE] Log: {probe_log}")
            if not module or module == "REPORT":
                print(f"[COMPLETE] HTML Report: {HTML_FILE}")
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
    parser = argparse.ArgumentParser(description="Forensic Latency Probe v13.3.0")
    parser.add_argument("--loop", type=int, default=0)
    parser.add_argument("--advanced", action="store_true")
    parser.add_argument("--module", type=str, default=None)
    # Process signal support — used by the UI "Pause/Resume/Kill" buttons
    # Example: python3 forensic_latency_probe_v13.py --signal STOP --pid 3821
    parser.add_argument("--signal", type=str, default=None,
                        choices=["STOP", "CONT", "KILL", "TERM"],
                        help="Send a signal to a process. Requires --pid.")
    parser.add_argument("--pid", type=int, default=None,
                        help="Target PID for --signal.")
    args = parser.parse_args()

    # Signal mode — does not run a probe, just sends the signal and exits
    if args.signal:
        if not args.pid:
            print("[SIGNAL:ERROR] --signal requires --pid")
            sys.exit(1)
        send_signal_to_pid(args.pid, args.signal)
        sys.exit(0)

    try:
        if args.loop > 0:
            while True:
                run_probe(advanced=args.advanced, module=args.module)
                time.sleep(args.loop)
        else:
            run_probe(advanced=args.advanced, module=args.module)
    except KeyboardInterrupt:
        print("\n[STOPPED]")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
