import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fs from "fs";
import cors from "cors";
import Database from "better-sqlite3";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  const LOG_DIR = path.join(process.cwd(), "forensic_logs");
  const DB_FILE = path.join(LOG_DIR, "forensic_audit.db");

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
  }

  const db = new Database(DB_FILE);

  // Idempotent Schema Initialization (Matching Python Probe)
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      mode TEXT,
      status TEXT,
      log_path TEXT,
      html_path TEXT,
      summary TEXT
    );
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      key TEXT,
      value REAL,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(run_id) REFERENCES runs(id)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      severity TEXT,
      message TEXT,
      FOREIGN KEY(run_id) REFERENCES runs(id)
    );
  `);

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", version: "13.2.6" });
  });

  app.get("/api/system-metrics", (req, res) => {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();
    const uptime = os.uptime();

    res.json({
      cpus: cpus.map(cpu => ({
        model: cpu.model,
        speed: cpu.speed,
        times: cpu.times
      })),
      memory: {
        total: totalMem,
        free: freeMem,
        used: totalMem - freeMem,
        percent: ((totalMem - freeMem) / totalMem) * 100
      },
      loadAvg,
      uptime,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch()
    });
  });

  app.get("/api/processes", async (req, res) => {
    try {
      const { stdout } = await execAsync("ps aux --sort=-%cpu | head -n 20");
      const lines = stdout.split("\n").filter(l => l.trim().length > 0);
      const headers = lines[0].split(/\s+/);
      const processes = lines.slice(1).map(line => {
        const parts = line.split(/\s+/);
        const obj: any = {};
        headers.forEach((h, i) => {
          if (i === headers.length - 1) {
            obj[h] = parts.slice(i).join(" ");
          } else {
            obj[h] = parts[i];
          }
        });
        return obj;
      });
      res.json(processes);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/doctor", async (req, res) => {
    const tools = ["python3", "perf", "bpftrace", "ss", "netstat", "blktrace", "execsnoop", "auditctl", "trace-cmd", "nicstat", "numactl"];
    const results: any = {};
    for (const tool of tools) {
      try {
        await execAsync(`which ${tool}`);
        results[tool] = { status: "OK", path: "found" };
      } catch {
        results[tool] = { status: "MISSING", path: null };
      }
    }
    res.json(results);
  });

  app.get("/api/network", async (req, res) => {
    try {
      const { stdout } = await execAsync("ss -tunap | head -n 50");
      res.json({ raw: stdout });
    } catch {
      try {
        const { stdout } = await execAsync("netstat -tunap | head -n 50");
        res.json({ raw: stdout });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  app.get("/api/system-diagnostics", async (req, res) => {
    const diagnostics: any = {};
    try {
      const { stdout: oomd } = await execAsync("systemctl is-active systemd-oomd || echo 'inactive'");
      diagnostics.oomd = oomd.trim();
      
      const { stdout: dbus } = await execAsync("systemctl is-active dbus-broker || echo 'inactive'");
      diagnostics.dbus = dbus.trim();

      if (fs.existsSync("/proc/sys/kernel/random/entropy_avail")) {
        diagnostics.entropy = fs.readFileSync("/proc/sys/kernel/random/entropy_avail", "utf8").trim();
      }

      const { stdout: interrupts } = await execAsync("cat /proc/interrupts | head -n 20");
      diagnostics.interrupts = interrupts;

    } catch (err) {
      diagnostics.error = "Failed to fetch some diagnostics";
    }
    res.json(diagnostics);
  });

  app.get("/api/process-tree", async (req, res) => {
    try {
      // Get detailed process info: ppid, pid, %cpu, %mem, comm
      const { stdout } = await execAsync("ps -ax -o ppid,pid,%cpu,%mem,comm --no-headers");
      const lines = stdout.trim().split("\n");
      const nodes: any = {};
      const tree: any = { name: "root", children: [], value: 0 };

      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) return;
        const ppid = parts[0];
        const pid = parts[1];
        const cpu = parseFloat(parts[2]);
        const mem = parseFloat(parts[3]);
        const comm = parts.slice(4).join(" ");
        
        // Use a combination of CPU and Memory for the "value" (size) of the block
        // We add a small baseline (0.1) so idle processes are still visible
        const value = Math.max(0.1, cpu + mem);
        
        nodes[pid] = { 
          name: `${comm} (${pid})`, 
          children: [], 
          value,
          cpu,
          mem,
          pid
        };
      });

      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) return;
        const ppid = parts[0];
        const pid = parts[1];
        
        if (nodes[ppid] && nodes[pid] && ppid !== pid) {
          nodes[ppid].children.push(nodes[pid]);
        } else if (nodes[pid]) {
          tree.children.push(nodes[pid]);
        }
      });

      res.json(tree);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/run-probe", (req, res) => {
    const { advanced, loop, module } = req.query;
    const args = ["forensic_latency_probe_v13.py"];
    if (advanced === "true") args.push("--advanced");
    if (loop) args.push("--loop", loop.toString());
    if (module) args.push("--module", module.toString());

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const pythonProcess = spawn("python3", ["-u", ...args]);

    const sendSSE = (data: string) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ text: data })}\n\n`);
    };

    // Send initial connection message
    sendSSE("[SYSTEM] Connected to forensic probe stream...\n");

    pythonProcess.stdout.on("data", (data) => {
      sendSSE(data.toString());
    });

    pythonProcess.stderr.on("data", (data) => {
      sendSSE(`[STDERR] ${data.toString()}`);
    });

    pythonProcess.on("close", (code, signal) => {
      const status = code !== null ? `CODE ${code}` : `SIGNAL ${signal}`;
      sendSSE(`\n[PROCESS COMPLETED WITH ${status}]\n`);
      if (!res.writableEnded) res.end();
    });

    pythonProcess.on("error", (err) => {
      sendSSE(`\n[ERROR] Failed to start process: ${err.message}\n`);
      if (!res.writableEnded) res.end();
    });

    // Cleanup if client disconnects
    req.on("close", () => {
      if (pythonProcess.exitCode === null) {
        console.log("Client disconnected, killing probe process...");
        // We can't send SSE here because the response is closed
        pythonProcess.kill("SIGKILL");
      }
    });
  });

  app.get("/api/process-logs/:processName", async (req, res) => {
    try {
      const { pid } = req.query;
      const processName = req.params.processName.split(" (")[0]; // Base name
      
      const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".log")).sort().reverse();
      if (files.length === 0) return res.json({ logs: ["No logs found."] });
      
      const latestLog = path.join(LOG_DIR, files[0]);
      
      // Search for either the process name or the PID
      let grepPattern = processName;
      if (pid) {
        grepPattern = `${processName}\\|${pid}`;
      }
      
      const { stdout } = await execAsync(`grep -i "${grepPattern}" "${latestLog}" | tail -n 50 || echo "No specific logs for ${processName} (PID: ${pid || 'N/A'})"`);
      res.json({ logs: stdout.split("\n").filter(l => l.trim().length > 0) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/db/latest-log", (req, res) => {
    try {
      const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".log")).sort().reverse();
      if (files.length === 0) return res.status(404).json({ error: "No logs found" });
      res.json({ path: files[0] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Database Endpoints
  app.get("/api/db/runs", (req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 50").all();
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/db/metrics/:runId", (req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM metrics WHERE run_id = ?").all(req.params.runId);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/db/alerts", (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT alerts.*, runs.timestamp as run_timestamp 
        FROM alerts 
        JOIN runs ON alerts.run_id = runs.id 
        ORDER BY alerts.id DESC
      `).all();
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/db/alerts/:runId", (req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM alerts WHERE run_id = ?").all(req.params.runId);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/logs", (req, res) => {
    fs.readdir(LOG_DIR, (err, files) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(files.filter(f => f.endsWith(".log")).sort().reverse());
    });
  });

  app.get("/api/log/:name", (req, res) => {
    const filePath = path.join(LOG_DIR, req.params.name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
    res.sendFile(filePath);
  });

  app.get("/api/report", (req, res) => {
    const reportPath = path.join(process.cwd(), "forensic_summary.html");
    if (!fs.existsSync(reportPath)) return res.status(404).json({ error: "Report not found" });
    res.sendFile(reportPath);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
