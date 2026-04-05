import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fs from "fs";
import cors from "cors";
import Database from "better-sqlite3";

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

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", version: "13.0.0" });
  });

  app.post("/api/run-probe", (req, res) => {
    const { advanced, loop, module } = req.body;
    const args = ["forensic_latency_probe_v13.py"];
    if (advanced) args.push("--advanced");
    if (loop) args.push("--loop", loop.toString());
    if (module) args.push("--module", module);

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Transfer-Encoding", "chunked");

    const pythonProcess = spawn("python3", args);

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
