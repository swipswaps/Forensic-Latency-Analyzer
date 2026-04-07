#!/usr/bin/env python3
# PATH: research_engine.py
#
# WHAT: Database-driven forensic research engine.
#       Takes structured findings from the probe (STORM/RANKED_ALERT lines),
#       clusters them by root cause, forms targeted search queries, and
#       searches authoritative documentation sources using a real Firefox
#       profile via xvfb-run to avoid bot detection.
#
# WHY:  The probe captures raw signals (firefox 121% CPU, IO_PRESSURE 23.56%).
#       This module closes the loop: it finds the official documentation,
#       known bug reports, and verified fixes for those exact conditions
#       and writes them back into the SQLite database for the UI to display.
#
# USAGE:
#   python3 research_engine.py --run-id 33
#   python3 research_engine.py --run-id 33 --finding "firefox high CPU IO pressure"
#   python3 research_engine.py --auto   # reads latest run from DB automatically
#
# DEPENDENCIES:
#   pip install selenium beautifulsoup4 lxml --break-system-packages
#   xvfb-run (already installed: confirmed on your Fedora system)
#   Firefox (with your real profile for cookie/session reuse)
#
# HOW BOT DETECTION IS AVOIDED:
#   1. Uses your real Firefox profile (~/.mozilla/firefox/*.default-release)
#      which carries real Google login cookies, so Google treats requests as
#      a known user rather than a bot.
#   2. Runs under xvfb-run (virtual X display) rather than --headless.
#      True headless leaks GPU/timing fingerprints. xvfb-run renders a full
#      window into a framebuffer — looks like a real desktop session.
#   3. Disables dom.webdriver.enabled in the cloned profile so Selenium's
#      navigator.webdriver flag is hidden from JavaScript fingerprinting.
#   4. Randomises inter-request delays (2-5s) to avoid rate-limit patterns.
#
# OUTPUT:
#   Writes to SQLite table `research_results`:
#     run_id, finding, query, source_url, source_title, excerpt, remediation, rank
#   The UI reads this table to populate the Research Panel.

import os
import sys
import re
import time
import json
import random
import shutil
import sqlite3
import argparse
import datetime
import traceback
import subprocess
from pathlib import Path

# ─── Configuration ────────────────────────────────────────────────────────────

LOG_DIR  = os.path.abspath("./forensic_logs")
DB_FILE  = os.path.join(LOG_DIR, "forensic_audit.db")

# Authoritative sources to search — ordered by authority for this domain.
# Google search is restricted to these domains to avoid low-quality results.
AUTHORITATIVE_SOURCES = [
    "bugzilla.mozilla.org",       # Firefox-specific bugs and fixes
    "wiki.archlinux.org",         # Best practical Linux tuning docs
    "docs.redhat.com",            # Fedora/RHEL official docs
    "access.redhat.com",          # Red Hat KCS solutions (verified fixes)
    "kernel.org",                 # Kernel PSI, scheduler, cgroup docs
    "man7.org",                   # Linux man pages
    "fedoraproject.org",          # Fedora-specific guidance
    "askubuntu.com",              # Community-verified solutions
    "unix.stackexchange.com",     # High-quality sysadmin Q&A
]

# Metric-to-query mapping: maps probe output patterns to search terms.
# Each entry: (regex_pattern, base_query, priority_sources)
FINDING_PATTERNS = [
    (r"firefox.*(?:cpu|%cpu|121|125|100)",
     "firefox high cpu usage linux reduce content processes",
     ["bugzilla.mozilla.org", "wiki.archlinux.org"]),

    (r"(?:IO_PRESSURE|io.*pressure).*(?:[5-9]\d|[1-9]\d{2})\.",
     "linux PSI io pressure high cause fix kernel tuning",
     ["kernel.org", "docs.redhat.com", "access.redhat.com"]),

    (r"(?:CPU_PRESSURE|cpu.*pressure).*(?:[5-9]\d|[1-9]\d{2})\.",
     "linux PSI cpu pressure stall information high fix",
     ["kernel.org", "access.redhat.com"]),

    (r"(?:MEMORY_PRESSURE|memory.*pressure)",
     "linux PSI memory pressure high swap thrashing fix",
     ["kernel.org", "access.redhat.com", "wiki.archlinux.org"]),

    (r"firefox.*(?:rss|memory|ram|2\d{3}MB|3\d{3}MB)",
     "firefox high memory usage linux limit fix 2025",
     ["bugzilla.mozilla.org", "wiki.archlinux.org"]),

    (r"(?:context.switch|cswch|xfwm4).*(?:[5-9]\d{2}|[1-9]\d{3})",
     "linux high context switches xfwm4 compositor latency fix",
     ["wiki.archlinux.org", "unix.stackexchange.com"]),

    (r"(?:socket|fd|file.descriptor).*(?:[1-9]\d{2})",
     "firefox too many open sockets file descriptors linux",
     ["bugzilla.mozilla.org", "man7.org"]),

    (r"(?:selinux|AVC|avc.*denied)",
     "SELinux AVC denial firefox fedora fix audit2allow",
     ["docs.redhat.com", "fedoraproject.org", "access.redhat.com"]),

    (r"(?:CRITICAL.*core|core.*saturated|idle.*[0-4]\.\d+)",
     "linux cpu core saturation IRQ affinity tuning fix",
     ["docs.redhat.com", "access.redhat.com", "kernel.org"]),

    (r"(?:btrfs|flush-btrfs)",
     "btrfs high io flush latency linux performance tuning",
     ["wiki.archlinux.org", "kernel.org"]),
]

# ─── Database Setup ───────────────────────────────────────────────────────────

def init_research_db():
    """Add research_results table to existing forensic DB. Idempotent."""
    conn = sqlite3.connect(DB_FILE)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS research_results (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id      INTEGER,
            finding     TEXT,
            query       TEXT,
            source_url  TEXT,
            source_title TEXT,
            excerpt     TEXT,
            remediation TEXT,
            rank        INTEGER,
            searched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(run_id) REFERENCES runs(id)
        )
    """)
    conn.commit()
    conn.close()
    print("[RESEARCH:DB] research_results table ready.")


def get_run_findings(run_id: int) -> list[str]:
    """Pull STORM and RANKED_ALERT lines from the run's log file."""
    conn = sqlite3.connect(DB_FILE)
    row = conn.execute("SELECT log_path, summary FROM runs WHERE id = ?", (run_id,)).fetchone()
    conn.close()

    findings = []

    if row:
        log_path, summary = row
        # From summary column (stored after run completes)
        if summary:
            for line in summary.split("\n"):
                if line.strip():
                    findings.append(line.strip())

        # From raw log file (contains STORM: lines emitted during run)
        if log_path and os.path.exists(log_path):
            with open(log_path, "r", errors="replace") as f:
                for line in f:
                    clean = line.strip()
                    if any(tag in clean for tag in ["[STORM:", "[RANKED_ALERT]", "CRITICAL:", "WARNING:"]):
                        findings.append(clean)

    # Deduplicate while preserving order
    seen = set()
    unique = []
    for f in findings:
        if f not in seen:
            seen.add(f)
            unique.append(f)

    print(f"[RESEARCH] Found {len(unique)} findings for run {run_id}")
    return unique


def cluster_findings(findings: list[str]) -> list[dict]:
    """
    Group related findings into clusters and form one search query per cluster.
    Strategy: match each finding against FINDING_PATTERNS. Findings that match
    the same pattern are grouped. Unmatched findings get their own cluster.
    """
    clusters = {}  # pattern_index → {query, sources, findings[]}

    for finding in findings:
        matched = False
        for i, (pattern, query, sources) in enumerate(FINDING_PATTERNS):
            if re.search(pattern, finding, re.IGNORECASE):
                if i not in clusters:
                    clusters[i] = {"query": query, "sources": sources, "findings": []}
                clusters[i]["findings"].append(finding)
                matched = True
                break  # one cluster per finding

        if not matched:
            # Generic fallback cluster
            key = f"misc_{len(clusters)}"
            clusters[key] = {
                "query": f"linux performance issue {finding[:60]}",
                "sources": ["wiki.archlinux.org", "unix.stackexchange.com"],
                "findings": [finding]
            }

    result = list(clusters.values())
    print(f"[RESEARCH] Clustered into {len(result)} search queries")
    return result


def save_result(run_id, finding, query, rank, source_url, source_title, excerpt, remediation):
    conn = sqlite3.connect(DB_FILE)
    conn.execute("""
        INSERT INTO research_results
            (run_id, finding, query, source_url, source_title, excerpt, remediation, rank)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (run_id, finding, query, source_url, source_title, excerpt, remediation, rank))
    conn.commit()
    conn.close()


# ─── Firefox Profile Management ───────────────────────────────────────────────

def find_firefox_profile() -> str | None:
    """Find the default-release Firefox profile on this system."""
    profile_base = Path.home() / ".mozilla" / "firefox"
    if not profile_base.exists():
        print("[RESEARCH:WARN] No ~/.mozilla/firefox found")
        return None

    # Prefer default-release, fall back to any profile
    for d in profile_base.iterdir():
        if d.is_dir() and "default-release" in d.name:
            return str(d)
    for d in profile_base.iterdir():
        if d.is_dir() and not d.name.startswith("."):
            return str(d)
    return None


def clone_profile(src: str) -> str:
    """
    Clone the real Firefox profile to a temp dir.
    Required because Firefox locks the profile — running against the live
    profile while Firefox is open causes a lock conflict.
    The clone carries all cookies and session data.
    """
    dest = f"/tmp/firefox-research-profile-{os.getpid()}"
    if os.path.exists(dest):
        shutil.rmtree(dest)
    shutil.copytree(src, dest, symlinks=True)

    # Write user.js to disable automation detection flags
    user_js = os.path.join(dest, "user.js")
    prefs = [
        # Hide Selenium's webdriver flag from JavaScript fingerprinting
        'user_pref("dom.webdriver.enabled", false);',
        'user_pref("useAutomationExtension", false);',
        # Preserve cookies and session
        'user_pref("network.cookie.cookieBehavior", 0);',
        'user_pref("browser.sessionstore.resume_from_crash", true);',
        # Reduce telemetry noise
        'user_pref("datareporting.healthreport.uploadEnabled", false);',
        # Allow first-party Google cookies
        'user_pref("network.cookie.thirdparty.sessionOnly", false);',
    ]
    with open(user_js, "w") as f:
        f.write("\n".join(prefs) + "\n")

    # Remove lock files from the clone
    for lock in ["lock", ".parentlock"]:
        lock_path = os.path.join(dest, lock)
        if os.path.exists(lock_path):
            os.remove(lock_path)

    print(f"[RESEARCH] Profile cloned to {dest}")
    return dest


# ─── Browser Search Engine ────────────────────────────────────────────────────

def build_google_query(base_query: str, sources: list[str]) -> str:
    """
    Build a Google search query restricted to authoritative sources.
    Uses site: OR operator to limit results to trusted domains.
    """
    site_filter = " OR ".join(f"site:{s}" for s in sources[:4])  # max 4 site: operators
    return f"{base_query} ({site_filter})"


def search_with_selenium(query: str, profile_path: str, max_results: int = 5) -> list[dict]:
    """
    Perform a Google search using Selenium with the real Firefox profile
    under xvfb-run (virtual display, not true headless — avoids detection).
    Returns list of {title, url, snippet} dicts.
    """
    try:
        from selenium import webdriver
        from selenium.webdriver.firefox.options import Options
        from selenium.webdriver.firefox.firefox_profile import FirefoxProfile
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.common.exceptions import TimeoutException, NoSuchElementException
    except ImportError:
        print("[RESEARCH:ERROR] selenium not installed. Run: pip install selenium --break-system-packages")
        return []

    opts = Options()
    # NOT headless — use xvfb virtual display instead
    # opts.add_argument("--headless")  # deliberately omitted

    profile = FirefoxProfile(profile_path)
    # Mask webdriver via profile preference (belt + suspenders with user.js)
    profile.set_preference("dom.webdriver.enabled", False)
    profile.set_preference("useAutomationExtension", False)

    print(f"[RESEARCH:BROWSER] Opening Firefox under xvfb...")
    driver = webdriver.Firefox(options=opts, firefox_profile=profile)

    results = []
    try:
        encoded = query.replace(' ', '+')
        url = f"https://www.google.com/search?q={encoded}&num={max_results}"
        print(f"[RESEARCH:BROWSER] GET {url}")
        driver.get(url)

        # Wait for results or CAPTCHA
        time.sleep(random.uniform(2.5, 4.5))

        # Check for CAPTCHA
        page_src = driver.page_source
        if "unusual traffic" in page_src.lower() or "captcha" in page_src.lower():
            print("[RESEARCH:BROWSER] CAPTCHA detected — pausing 30s for manual solve if needed")
            time.sleep(30)
            page_src = driver.page_source

        # Extract search results
        # Google's result containers are <div class="g"> or <div data-sokoban-container>
        result_divs = driver.find_elements(By.CSS_SELECTOR, "div.g")
        if not result_divs:
            # Try alternate selectors (Google changes these frequently)
            result_divs = driver.find_elements(By.CSS_SELECTOR, "[data-hveid]")

        for div in result_divs[:max_results]:
            try:
                title_el = div.find_element(By.CSS_SELECTOR, "h3")
                title = title_el.text.strip()
                if not title:
                    continue

                # Get URL from the anchor wrapping h3
                link_el = div.find_element(By.CSS_SELECTOR, "a")
                href = link_el.get_attribute("href") or ""

                # Skip Google internal links
                if not href.startswith("http") or "google.com" in href:
                    continue

                # Get snippet
                snippet = ""
                for cls in ["VwiC3b", "yXK7lf", "lEBKkf"]:
                    try:
                        snippet = div.find_element(By.CLASS_NAME, cls).text.strip()
                        break
                    except NoSuchElementException:
                        pass

                results.append({
                    "title": title,
                    "url": href,
                    "snippet": snippet[:400]
                })
                print(f"[RESEARCH:RESULT] {title[:60]} — {href[:60]}")

            except (NoSuchElementException, Exception):
                continue

        time.sleep(random.uniform(1.5, 3.0))  # polite delay before closing

    except Exception as e:
        print(f"[RESEARCH:BROWSER:ERROR] {e}")
        traceback.print_exc()
    finally:
        driver.quit()

    return results


def search_with_xvfb(query: str, profile_path: str, max_results: int = 5) -> list[dict]:
    """
    Wrapper: launches search_with_selenium inside an xvfb virtual display
    by setting DISPLAY before calling the Selenium code.
    xvfb-run starts a new virtual X server for this process.
    """
    # Check if we already have a DISPLAY (running under xvfb-run externally)
    if os.environ.get("DISPLAY"):
        print(f"[RESEARCH:BROWSER] Using existing DISPLAY={os.environ['DISPLAY']}")
        return search_with_selenium(query, profile_path, max_results)

    # No display — launch xvfb-run as subprocess wrapper
    # We call ourselves recursively with DISPLAY set via xvfb-run
    print("[RESEARCH:BROWSER] No DISPLAY found — using xvfb-run")

    # Serialize query to a temp file to pass through subprocess boundary
    import tempfile
    query_file = tempfile.mktemp(suffix=".txt")
    result_file = tempfile.mktemp(suffix=".json")
    with open(query_file, "w") as f:
        f.write(query)

    # Re-invoke this script in xvfb subprocess with special --xvfb-inner mode
    cmd = [
        "xvfb-run", "-a",
        "python3", os.path.abspath(__file__),
        "--xvfb-inner",
        "--query-file", query_file,
        "--result-file", result_file,
        "--profile", profile_path,
        "--max-results", str(max_results)
    ]
    print(f"[RESEARCH:BROWSER] xvfb-run cmd: {' '.join(cmd)}")
    ret = subprocess.call(cmd, timeout=120)

    # Read results back
    results = []
    if os.path.exists(result_file):
        with open(result_file, "r") as f:
            try:
                results = json.load(f)
            except Exception:
                pass
        os.remove(result_file)

    if os.path.exists(query_file):
        os.remove(query_file)

    return results


def fetch_page_content(url: str, profile_path: str) -> str:
    """
    Fetch the full text content of a result page using Firefox.
    Used to extract remediation steps from the actual documentation page,
    not just the Google snippet.
    Returns the page body text (first 3000 chars).
    """
    try:
        from selenium import webdriver
        from selenium.webdriver.firefox.options import Options
        from selenium.webdriver.firefox.firefox_profile import FirefoxProfile
        from selenium.webdriver.common.by import By
    except ImportError:
        return ""

    opts = Options()
    profile = FirefoxProfile(profile_path)
    profile.set_preference("dom.webdriver.enabled", False)
    profile.set_preference("useAutomationExtension", False)

    driver = webdriver.Firefox(options=opts, firefox_profile=profile)
    content = ""
    try:
        driver.get(url)
        time.sleep(random.uniform(2.0, 3.5))
        # Try to get main content area; fall back to full body
        for selector in ["main", "article", "#content", ".content", "body"]:
            try:
                el = driver.find_element(By.CSS_SELECTOR, selector)
                content = el.text[:3000]
                if len(content) > 200:
                    break
            except Exception:
                continue
    except Exception as e:
        print(f"[RESEARCH:FETCH:ERROR] {url}: {e}")
    finally:
        driver.quit()

    return content


def extract_remediation(content: str, finding: str) -> str:
    """
    Extract actionable remediation steps from page content.
    Looks for: numbered steps, commands, config changes.
    Returns a concise remediation string.
    """
    if not content:
        return ""

    lines = content.split("\n")
    remediation_lines = []

    # Patterns that indicate actionable content
    action_patterns = [
        r"^\s*\d+\.",          # numbered step
        r"^\s*#+\s+",          # markdown heading
        r"\$\s+\S",            # shell command
        r"^sudo\s+",           # sudo command
        r"^echo\s+",           # echo command
        r"sysctl\s+",          # kernel tuning
        r"ulimit\s+",          # limits
        r"about:config",       # firefox config
        r"user_pref",          # firefox pref
        r"fix|workaround|solution|resolve|disable|enable|set|configure",
    ]

    in_relevant_section = False
    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Check if this line is near relevant content
        relevant = any(
            kw in line.lower()
            for kw in ["firefox", "cpu", "memory", "psi", "pressure", "performance",
                       "latency", "fix", "solution", "workaround", "configure"]
        )
        if relevant:
            in_relevant_section = True

        if in_relevant_section:
            is_action = any(re.search(p, line, re.IGNORECASE) for p in action_patterns)
            if is_action and len(line) > 5:
                remediation_lines.append(line)
            if len(remediation_lines) >= 8:
                break

    return "\n".join(remediation_lines[:8])


# ─── Main Research Pipeline ───────────────────────────────────────────────────

def run_research(run_id: int, manual_finding: str = None):
    """
    Full research pipeline for a given run ID.
    1. Pull findings from DB/log
    2. Cluster into search queries
    3. Search Google restricted to authoritative sources
    4. Fetch top result pages
    5. Extract remediation steps
    6. Save to research_results table
    """
    print(f"\n[RESEARCH] Starting research pipeline for run {run_id}")
    init_research_db()

    # Get findings
    if manual_finding:
        findings = [manual_finding]
    else:
        findings = get_run_findings(run_id)

    if not findings:
        print(f"[RESEARCH] No findings found for run {run_id}. Run a Standard probe first.")
        return

    # Cluster
    clusters = cluster_findings(findings)

    # Find Firefox profile
    profile_src = find_firefox_profile()
    if not profile_src:
        print("[RESEARCH:ERROR] No Firefox profile found. Is Firefox installed?")
        return

    # Clone profile (avoids lock conflict with running Firefox)
    profile_path = clone_profile(profile_src)

    try:
        for cluster_idx, cluster in enumerate(clusters):
            query = cluster["query"]
            sources = cluster["sources"]
            representative_finding = cluster["findings"][0]

            google_query = build_google_query(query, sources)
            print(f"\n[RESEARCH:QUERY] Cluster {cluster_idx + 1}/{len(clusters)}")
            print(f"[RESEARCH:QUERY] Finding: {representative_finding[:80]}")
            print(f"[RESEARCH:QUERY] Query: {google_query}")

            # Search Google
            results = search_with_xvfb(google_query, profile_path, max_results=5)

            if not results:
                print(f"[RESEARCH:WARN] No results for: {google_query}")
                continue

            # Fetch top 3 results for full content
            for rank, result in enumerate(results[:3], 1):
                url = result["url"]
                title = result["title"]
                snippet = result["snippet"]

                print(f"[RESEARCH:FETCH] Rank {rank}: {url}")
                page_content = fetch_page_content(url, profile_path)
                remediation = extract_remediation(page_content, representative_finding)

                # Save to DB
                save_result(
                    run_id=run_id,
                    finding=representative_finding,
                    query=google_query,
                    rank=rank,
                    source_url=url,
                    source_title=title,
                    excerpt=snippet,
                    remediation=remediation
                )

                print(f"[RESEARCH:SAVED] {title[:60]}")
                if remediation:
                    print(f"[RESEARCH:REMEDIATION] {remediation[:200]}")

                # Polite delay between page fetches
                time.sleep(random.uniform(3.0, 6.0))

            # Delay between clusters
            time.sleep(random.uniform(5.0, 10.0))

    finally:
        # Clean up cloned profile
        if os.path.exists(profile_path):
            shutil.rmtree(profile_path, ignore_errors=True)
            print(f"[RESEARCH] Cleaned up profile clone: {profile_path}")

    print(f"\n[RESEARCH:DONE] Research complete for run {run_id}")

    # Print summary
    conn = sqlite3.connect(DB_FILE)
    rows = conn.execute(
        "SELECT finding, source_title, source_url, rank FROM research_results WHERE run_id = ? ORDER BY rank",
        (run_id,)
    ).fetchall()
    conn.close()

    print(f"\n[RESEARCH:SUMMARY] {len(rows)} results saved:")
    for finding, title, url, rank in rows:
        print(f"  [{rank}] {title[:50]} — {url[:60]}")
        print(f"      Finding: {finding[:60]}")


def get_latest_standard_run_id() -> int | None:
    """Find the most recent STANDARD or ADVANCED run."""
    if not os.path.exists(DB_FILE):
        return None
    conn = sqlite3.connect(DB_FILE)
    row = conn.execute(
        "SELECT id FROM runs WHERE mode IN ('STANDARD','ADVANCED') AND status='SUCCESS' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    conn.close()
    return row[0] if row else None


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Forensic Research Engine v1.0")
    parser.add_argument("--run-id", type=int, help="Run ID to research")
    parser.add_argument("--auto", action="store_true", help="Use latest successful STANDARD run")
    parser.add_argument("--finding", type=str, help="Manual finding string to research")

    # Internal xvfb subprocess mode — not for direct use
    parser.add_argument("--xvfb-inner", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--query-file", type=str, help=argparse.SUPPRESS)
    parser.add_argument("--result-file", type=str, help=argparse.SUPPRESS)
    parser.add_argument("--profile", type=str, help=argparse.SUPPRESS)
    parser.add_argument("--max-results", type=int, default=5, help=argparse.SUPPRESS)

    args = parser.parse_args()

    # xvfb inner mode: run Selenium with DISPLAY already set by xvfb-run
    if args.xvfb_inner:
        with open(args.query_file, "r") as f:
            query = f.read().strip()
        results = search_with_selenium(query, args.profile, args.max_results)
        with open(args.result_file, "w") as f:
            json.dump(results, f)
        sys.exit(0)

    # Normal mode
    run_id = None
    if args.run_id:
        run_id = args.run_id
    elif args.auto:
        run_id = get_latest_standard_run_id()
        if not run_id:
            print("[RESEARCH:ERROR] No completed STANDARD/ADVANCED run found. Run a probe first.")
            sys.exit(1)
        print(f"[RESEARCH] Auto-selected run ID: {run_id}")
    else:
        parser.print_help()
        sys.exit(1)

    run_research(run_id, manual_finding=args.finding)
