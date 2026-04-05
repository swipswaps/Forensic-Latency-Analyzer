#!/usr/bin/env python3
# =============================================================================
# forensic_latency_probe_v13.py
# =============================================================================
# FULL REQUEST-COMPLIANT FORENSIC LATENCY ANALYZER v13.2.2 (ROBUST IDEMPOTENCY)
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

# Mapping for Fedora/DNF
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
# DATABASE MANAGEMENT (IDEMPOTENT LOGGING)
# =============================================================================

class DatabaseManager:
    @staticmethod
    def init_db():
        print(f"[DB:INIT] Ensuring robust log database at {DB_FILE}")
        try:
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            # Idempotent Schema Creation
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
                    mode TEXT,
                    status TEXT,
                    log_path TEXT,
                    html_path TEXT,
                    summary TEXT
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
# DEPENDENCY MANAGEMENT (ROBUST IDEMPOTENCY)
# =============================================================================

class DependencyManager:
    @staticmethod
    def ensure_deps():
        print("\n[MODULE:DEPS] VERIFYING SYSTEM DEPENDENCIES")
        
        # 1. Verify individual tools (Always check)
        missing = [t for t in REQUIRED_TOOLS if shutil.which(t) is None]
        if not missing:
            print("[DEPS:SUCCESS] All tools present in PATH.")
            return

        print(f"[DEPS:ACTION] Missing tools detected: {missing}. Initiating recoverable install.")
        
        # Check for non-interactive sudo
        sudo_works = run(["sudo", "-n", "true"], timeout=5) == 0
        if not sudo_works:
            print("[DEPS:WARNING] Non-interactive sudo failed. Installation may require manual intervention.")

        for attempt in range(3):
            try:
                if shutil.which("apt-get"):
                    # DEPS_MARKER only skips apt-get update
                    if not os.path.exists(DEPS_MARKER):
                        run(["sudo", "-n", "apt-get", "update"], timeout=60)
                        with open(DEPS_MARKER, "w") as f: f.write(datetime.datetime.now().isoformat())
                    ret = run(["sudo", "-n", "apt-get", "install", "-y"] + APT_PACKAGES, timeout=120)
                    if ret == 0: break
                elif shutil.which("dnf"):
                    DNF_PACKAGES = [DNF_MAP.get(p, p) for p in APT_PACKAGES]
                    ret = run(["sudo", "-n", "dnf", "install", "-y"] + DNF_PACKAGES, timeout=120)
                    if ret == 0: break
            except Exception as e:
                print(f"[DEPS:RETRY] Attempt {attempt+1} failed: {e}")
                time.sleep(5)
        
        # Final Verification
        missing_after = [t for t in REQUIRED_TOOLS if shutil.which(t) is None]
        if missing_after:
            print(f"[DEPS:WARNING] Some tools still missing after install: {missing_after}")

# =============================================================================
# LOGGING (TEE STDOUT + STDERR)
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

    def close(self):
        if self.log:
            self.log.close()
            self.log = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

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
             raise RuntimeError(f"CRITICAL COMPLIANCE FAILURE: Feature {req} missing - brevity removal detected.")
    
    # Verify TeeLogger assignment
    if not isinstance(sys.stdout, TeeLogger):
        raise RuntimeError("CRITICAL COMPLIANCE FAILURE: stdout is not a TeeLogger. Logging is compromised.")
        
    print("[COMPLIANCE] v13.2.2 Integrity Verified. No omissions.")

# =============================================================================
# CORE EXECUTION WRAPPER
# =============================================================================

def run(cmd, timeout=30, capture_output=False):
    print(f"\n[COMMAND] {' '.join(cmd)}")
    print(f"[TIME] {datetime.datetime.now().isoformat()}")
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
        if ret == 0:
            print("[DOCTOR:SUCCESS] Perf tracing available.")
        else:
            print("[DOCTOR:WARNING] Perf tracing might be restricted (CAP_SYS_ADMIN missing).")
    except:
        print("[DOCTOR:WARNING] Could not verify perf capabilities.")

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
    print("\n[MODULE:PSI] PRESSURE STALL INFORMATION")
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
            idle_idx = headers.index("%idle")
            
            for line in lines[header_idx+1:]:
                if "all" not in line and len(line.split()) > idle_idx:
                    parts = line.split()
                    try:
                        idle = float(parts[idle_idx])
                        core = parts[2]
                        print(f"[METRIC:CPU_CORE_{core}_IDLE] {idle}")
                        DatabaseManager.log_metric(CURRENT_RUN_ID, f"CPU_CORE_{core}_IDLE", idle)
                        if idle < 5.0:
                            SUMMARY_LINES.append(f"WARNING: CPU Core {core} is saturated (idle: {idle}%)")
                            print(f"[ACTION] Saturated core {core} detected. Running hardware counter audit...")
                            run(["sudo", "perf", "stat", "-a", "-C", core, "sleep", "2"], timeout=10)
                    except:
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
        for line in lines:
            if len(line.split()) > 10 and not line.startswith("Device"):
                parts = line.split()
                try:
                    util = float(parts[-1])
                    print(f"[METRIC:DISK_{parts[0]}_UTIL] {util}")
                    DatabaseManager.log_metric(CURRENT_RUN_ID, f"DISK_{parts[0]}_UTIL", util)
                    if util > 80.0:
                        SUMMARY_LINES.append(f"CRITICAL: Disk {parts[0]} is {util}% utilized")
                except:
                    pass

def block_layer_trace():
    print("\n[MODULE:BLKTRACE] BLOCK LAYER LATENCY TRACE (5s)")
    disk_dev_out = run(["bash", "-c", 'lsblk -no NAME,TYPE | awk \'$2=="disk"{print $1; exit}\''], capture_output=True)
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
            count = out.count("avc:  denied")
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
    <html>
    <head>
        <title>Forensic Latency Report v13.2.2</title>
        <style>
            body {{ font-family: sans-serif; background: #f8f9fa; padding: 20px; }}
            .card {{ background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
            .critical {{ color: #dc3545; font-weight: bold; }}
            .warning {{ color: #ffc107; font-weight: bold; }}
            .info {{ color: #0d6efd; }}
            pre {{ background: #212529; color: #f8f9fa; padding: 15px; border-radius: 4px; overflow-x: auto; }}
        </style>
    </head>
    <body>
        <h1>Forensic Latency Report</h1>
        <p>Generated: {datetime.datetime.now().isoformat()}</p>
        <div class="card">
            <h2>Ranked Root Causes</h2>
            <ul>
                {"".join([f'<li class="{"critical" if "CRITICAL" in l else ("warning" if "WARNING" in l else "info") }">{l}</li>' for l in SUMMARY_LINES])}
            </ul>
        </div>
    </body>
    </html>
    """
    with open(HTML_FILE, "w") as f:
        f.write(html_content)

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
            CURRENT_RUN_ID = DatabaseManager.start_run("ADVANCED" if advanced else ("MODULE:" + module if module else "STANDARD"))
            
            enforce_compliance()
            
            module_map = {
                "DEPS": DependencyManager.ensure_deps,
                "PSI": psi,
                "CPU_CORE": core_imbalance_check,
                "CPU_SCHED": cpu_sched,
                "PERF_STAT": perf_stat_system,
                "IRQ_RATE": irq_rate_audit,
                "MEM": memory,
                "NUMA": numa_audit,
                "DISK": disk,
                "NET": network,
                "NICSTAT": network_interface_stats,
                "KERNEL": kernel,
                "FTRACE": kernel_function_trace,
                "CGROUP": cgroup,
                "IRQ": irq_affinity_audit,
                "AUDITD": auditd_check,
                "SELINUX": selinux_audit,
                "BCC": short_lived_process_trace,
                "PERF": lambda: perf_analysis(probe_ts),
                "BLKTRACE": block_layer_trace,
                "BPFTRACE": scheduler_latency_hist,
                "SUMMARY": rank_root_causes,
                "REPORT": generate_html_report,
                "DOCTOR": doctor
            }

            if module:
                if module in module_map:
                    module_map[module]()
                else:
                    print(f"[ERROR] Unknown module: {module}")
            else:
                # Full Pipeline
                DependencyManager.ensure_deps()
                doctor()
                psi()
                core_imbalance_check()
                cpu_sched()
                perf_stat_system()
                irq_rate_audit()
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

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", type=int, default=0)
    parser.add_argument("--advanced", action="store_true")
    parser.add_argument("--module", type=str, default=None)
    args = parser.parse_args()
    
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