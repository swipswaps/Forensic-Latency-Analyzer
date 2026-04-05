import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fs from "fs";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  const LOG_DIR = path.join(process.cwd(), "forensic_logs");
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
  }

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/run-probe", (req, res) => {
    const { advanced, loop } = req.body;
    const args = ["forensic_latency_probe_v8.py"];
    if (advanced) args.push("--advanced");
    if (loop) args.push("--loop", loop.toString());

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

  app.get("/api/logs", (req, res) => {
    fs.readdir(LOG_DIR, (err, files) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(files.sort().reverse());
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
