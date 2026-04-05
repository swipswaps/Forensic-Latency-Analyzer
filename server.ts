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
    res.json({ status: "ok", version: "13.2.1" });
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
      const { stdout } = await execAsync("ps -ax -o ppid,pid,comm --no-headers");
      const lines = stdout.trim().split("\n");
      const nodes: any = {};
      const tree: any = { name: "root", children: [] };

      lines.forEach(line => {
        const [ppid, pid, ...commParts] = line.trim().split(/\s+/);
        const comm = commParts.join(" ");
        nodes[pid] = { name: `${comm} (${pid})`, children: [], value: 1 };
      });

      lines.forEach(line => {
        const [ppid, pid] = line.trim().split(/\s+/);
        if (nodes[ppid] && nodes[pid]) {
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

  app.post("/api/run-probe", (req, res) => {
    const { advanced, loop, module } = req.body;
    const args = ["forensic_latency_probe_v13.py"];
    if (advanced) args.push("--advanced");
    if (loop) args.push("--loop", loop.toString());
    if (module) args.push("--module", module);

    // COMPLIANCE: Explicitly pass current working directory as an argument
    const projectRoot = process.cwd();
    args.push("--cwd", projectRoot);

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Transfer-Encoding", "chunked");

    const pythonProcess = spawn("python3", args, {
      env: { 
        ...process.env, 
        PROJECT_ROOT: projectRoot 
      }
    });

    pythonProcess.stdout.on("data", (data) => {
      res.write(data);
    });

    pythonProcess.stderr.on("data", (data) => {
      res.write(data);
    });

    pythonProcess.on("close", (code) => {
      res.end(`\n[PROCESS COMPLETED WITH CODE ${code}]\n`);
    });
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
