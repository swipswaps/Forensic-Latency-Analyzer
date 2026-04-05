import React, { useState, useEffect, useRef } from "react";
import { 
  Activity, 
  Terminal, 
  Shield, 
  Database, 
  Network, 
  Cpu, 
  AlertTriangle, 
  CheckCircle2, 
  FileText, 
  Play, 
  Settings2,
  Clock,
  HardDrive,
  Layers,
  Loader2
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface MetricState {
  cpu_pressure: number;
  memory_pressure: number;
  io_pressure: number;
  selinux_mode: string;
  selinux_denials: number;
  disk_util: number;
  core_idle: Record<string, number>;
  uptime: string;
  load_avg: string;
  open_files: number;
  tcp_conns: number;
}

interface ModuleStatus {
  name: string;
  status: "idle" | "running" | "success" | "failed";
}

interface Run {
  id: number;
  timestamp: string;
  mode: string;
  status: string;
  summary: string;
}

const MODULE_LIST = [
  "DEPS", "DOCTOR", "PSI", "CPU_CORE", "CPU_SCHED", "MEM", "NUMA", "DISK", "NET", 
  "NICSTAT", "KERNEL", "FTRACE", "CGROUP", "IRQ", "AUDITD", "SELINUX", 
  "BCC", "PERF", "BLKTRACE", "BPFTRACE", "SUMMARY", "REPORT"
];

export default function App() {
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [loop, setLoop] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeTab, setActiveTab] = useState<"live" | "history">("live");
  const [metrics, setMetrics] = useState<MetricState>({
    cpu_pressure: 0,
    memory_pressure: 0,
    io_pressure: 0,
    selinux_mode: "Unknown",
    selinux_denials: 0,
    disk_util: 0,
    core_idle: {},
    uptime: "N/A",
    load_avg: "0.00",
    open_files: 0,
    tcp_conns: 0
  });
  const [modules, setModules] = useState<Record<string, ModuleStatus["status"]>>(
    MODULE_LIST.reduce((acc, name) => ({ ...acc, [name]: "idle" }), {})
  );
  const [alerts, setAlerts] = useState<string[]>([]);
  
  const terminalRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    fetchLogs();
    fetchRuns();
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  const fetchLogs = async () => {
    try {
      const res = await fetch("/api/logs");
      const data = await res.json();
      setLogs(data);
    } catch (err) {
      console.error("Failed to fetch logs", err);
    }
  };

  const fetchRuns = async () => {
    try {
      const res = await fetch("/api/db/runs");
      const data = await res.json();
      setRuns(data);
    } catch (err) {
      console.error("Failed to fetch runs", err);
    }
  };

  const parseLine = (line: string) => {
    // Parse Modules
    const moduleMatch = line.match(/\[MODULE:(\w+)\]/);
    if (moduleMatch) {
      setModules(prev => ({ ...prev, [moduleMatch[1]]: "running" }));
      // Mark previous as success if it was running
      const currentIndex = MODULE_LIST.indexOf(moduleMatch[1]);
      if (currentIndex > 0) {
        const prevModule = MODULE_LIST[currentIndex - 1];
        setModules(prev => ({ ...prev, [prevModule]: "success" }));
      }
    }

    // Parse Metrics
    const metricMatch = line.match(/\[METRIC:(\w+)\]\s+(.*)/);
    if (metricMatch) {
      const [_, key, val] = metricMatch;
      setMetrics(prev => {
        if (key.startsWith("CPU_CORE_")) {
          const core = key.replace("CPU_CORE_", "").replace("_IDLE", "");
          return { ...prev, core_idle: { ...prev.core_idle, [core]: parseFloat(val) } };
        }
        if (key === "CPU_PRESSURE") return { ...prev, cpu_pressure: parseFloat(val) };
        if (key === "MEMORY_PRESSURE") return { ...prev, memory_pressure: parseFloat(val) };
        if (key === "IO_PRESSURE") return { ...prev, io_pressure: parseFloat(val) };
        if (key === "SELINUX_DENIALS") return { ...prev, selinux_denials: parseFloat(val) };
        if (key.startsWith("DISK_") && key.endsWith("_UTIL")) return { ...prev, disk_util: parseFloat(val) };
        if (key === "UPTIME") return { ...prev, uptime: val };
        if (key === "LOAD_AVG") return { ...prev, load_avg: val };
        if (key === "OPEN_FILES") return { ...prev, open_files: parseInt(val) };
        if (key === "TCP_CONNS") return { ...prev, tcp_conns: parseInt(val) };
        return prev;
      });
    }

    const selinuxModeMatch = line.match(/\[METRIC:SELINUX_MODE\]\s+(\w+)/);
    if (selinuxModeMatch) {
      setMetrics(prev => ({ ...prev, selinux_mode: selinuxModeMatch[1] }));
    }

    // Parse Alerts
    const alertMatch = line.match(/\[RANKED_ALERT\]\s+(.*)/);
    if (alertMatch) {
      setAlerts(prev => [...new Set([...prev, alertMatch[1]])]);
    }
  };

  const runProbe = async (moduleName?: string) => {
    setIsRunning(true);
    setOutput("");
    setAlerts([]);
    setActiveTab("live");
    if (!moduleName) {
      setMetrics({
        cpu_pressure: 0,
        memory_pressure: 0,
        io_pressure: 0,
        selinux_mode: "Unknown",
        selinux_denials: 0,
        disk_util: 0,
        core_idle: {},
        uptime: "N/A",
        load_avg: "0.00",
        open_files: 0,
        tcp_conns: 0
      });
      setModules(MODULE_LIST.reduce((acc, name) => ({ ...acc, [name]: "idle" }), {}));
    } else {
      setModules(prev => ({ ...prev, [moduleName]: "idle" }));
    }

    try {
      const response = await fetch("/api/run-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ advanced, loop, module: moduleName }),
      });

      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        setOutput(prev => prev + chunk);
        
        // Parse lines for metrics
        chunk.split("\n").forEach(parseLine);
      }
      
      // Mark final module as success
      if (moduleName) {
        setModules(prev => ({ ...prev, [moduleName]: "success" }));
      } else {
        setModules(prev => ({ ...prev, REPORT: "success" }));
      }
      fetchLogs();
      fetchRuns();
    } catch (err) {
      setOutput(prev => prev + `\n[ERROR] ${err}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg shadow-lg shadow-blue-900/20">
              <Activity className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-xl tracking-tight text-white">Forensic Latency Analyzer</h1>
              <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">v13.0.0-compliant • Robust Idempotency</p>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
              <button 
                onClick={() => setActiveTab("live")}
                className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${activeTab === "live" ? "bg-blue-600 text-white shadow-md" : "text-slate-400 hover:text-slate-200"}`}
              >
                Live Audit
              </button>
              <button 
                onClick={() => setActiveTab("history")}
                className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${activeTab === "history" ? "bg-blue-600 text-white shadow-md" : "text-slate-400 hover:text-slate-200"}`}
              >
                Audit History
              </button>
            </div>

            <div className="flex items-center gap-4 bg-slate-800/50 p-1 rounded-lg border border-slate-700">
              <label className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-slate-700/50 rounded-md transition-colors">
                <input 
                  type="checkbox" 
                  checked={advanced} 
                  onChange={(e) => setAdvanced(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm font-medium">Advanced</span>
              </label>
              <div className="h-4 w-px bg-slate-700" />
              <div className="flex items-center gap-2 px-3">
                <Clock className="w-4 h-4 text-slate-400" />
                <select 
                  value={loop} 
                  onChange={(e) => setLoop(parseInt(e.target.value))}
                  className="bg-transparent text-sm font-medium focus:outline-none cursor-pointer"
                >
                  <option value={0} className="bg-slate-900">One-shot</option>
                  <option value={60} className="bg-slate-900">1 min loop</option>
                  <option value={300} className="bg-slate-900">5 min loop</option>
                </select>
              </div>
            </div>

            <button
              onClick={() => runProbe()}
              disabled={isRunning}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-lg font-bold transition-all ${
                isRunning 
                  ? "bg-slate-800 text-slate-500 cursor-not-allowed" 
                  : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40 active:scale-95"
              }`}
            >
              {isRunning ? (
                <div className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
              ) : (
                <Play className="w-4 h-4 fill-current" />
              )}
              {isRunning ? "Analyzing..." : "Run Probe"}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto p-6 grid grid-cols-12 gap-6">
        {/* Left Column: Metrics & Compliance */}
        <div className="col-span-12 lg:col-span-4 space-y-6">
          {/* Pulse Metrics */}
          <section className="grid grid-cols-2 gap-4">
            <MetricCard 
              icon={<Cpu className="w-5 h-5" />} 
              label="CPU Pressure" 
              value={`${metrics.cpu_pressure}%`} 
              status={metrics.cpu_pressure > 5 ? "critical" : "normal"}
            />
            <MetricCard 
              icon={<Layers className="w-5 h-5" />} 
              label="Memory Pressure" 
              value={`${metrics.memory_pressure}%`} 
              status={metrics.memory_pressure > 5 ? "critical" : "normal"}
            />
            <MetricCard 
              icon={<HardDrive className="w-5 h-5" />} 
              label="Disk Util" 
              value={`${metrics.disk_util}%`} 
              status={metrics.disk_util > 80 ? "critical" : "normal"}
            />
            <MetricCard 
              icon={<Shield className="w-5 h-5" />} 
              label="SELinux Mode" 
              value={metrics.selinux_mode} 
              status={metrics.selinux_mode === "Enforcing" ? "warning" : "normal"}
            />
          </section>

          {/* Restored System Health Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="font-bold flex items-center gap-2 mb-4">
              <Activity className="w-4 h-4 text-emerald-400" />
              System Health
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 uppercase font-bold">Load Avg</span>
                <p className="text-lg font-mono font-bold text-white">{metrics.load_avg}</p>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 uppercase font-bold">TCP Conns</span>
                <p className="text-lg font-mono font-bold text-white">{metrics.tcp_conns}</p>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 uppercase font-bold">Open Files</span>
                <p className="text-lg font-mono font-bold text-white">{metrics.open_files}</p>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 uppercase font-bold">Uptime</span>
                <p className="text-[10px] font-mono text-slate-400 truncate">{metrics.uptime}</p>
              </div>
            </div>
          </div>

          {/* CPU Core Heatmap */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="font-bold flex items-center gap-2 mb-4">
              <Cpu className="w-4 h-4 text-blue-400" />
              CPU Core Load (Idle %)
            </h3>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(metrics.core_idle).map(([core, idle]) => {
                const idleVal = idle as number;
                return (
                  <div key={core} className="flex flex-col items-center gap-1">
                    <div 
                      className={`w-full h-8 rounded border transition-all duration-500 ${
                        idleVal < 5 ? "bg-red-500/40 border-red-500/60" :
                        idleVal < 20 ? "bg-amber-500/40 border-amber-500/60" :
                        "bg-emerald-500/40 border-emerald-500/60"
                      }`}
                    />
                    <span className="text-[8px] font-mono text-slate-500">#{core}</span>
                  </div>
                );
              })}
              {Object.keys(metrics.core_idle).length === 0 && (
                <div className="col-span-4 text-center py-4 text-xs text-slate-600 italic">
                  Run CPU_CORE module to see data
                </div>
              )}
            </div>
          </div>

          {/* SELinux Monitor */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 overflow-hidden relative">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold flex items-center gap-2">
                <Shield className="w-4 h-4 text-blue-400" />
                Security Auditor
              </h3>
              {metrics.selinux_denials > 0 && (
                <span className="bg-red-500/20 text-red-400 text-[10px] font-bold px-2 py-0.5 rounded uppercase animate-pulse">
                  Denials Detected
                </span>
              )}
            </div>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Recent AVC Denials</span>
                <span className={`font-mono font-bold ${metrics.selinux_denials > 0 ? "text-red-400" : "text-green-400"}`}>
                  {metrics.selinux_denials}
                </span>
              </div>
              <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                <div 
                  className={`h-full transition-all duration-500 ${metrics.selinux_denials > 0 ? "bg-red-500" : "bg-green-500"}`}
                  style={{ width: `${Math.min(metrics.selinux_denials * 10, 100)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Compliance Checklist */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="font-bold flex items-center gap-2 mb-4">
              <CheckCircle2 className="w-4 h-4 text-green-400" />
              Compliance Pipeline (Click to Run)
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {MODULE_LIST.map(name => (
                <button 
                  key={name}
                  onClick={() => !isRunning && runProbe(name)}
                  disabled={isRunning}
                  className={`text-[10px] font-mono p-1.5 rounded border transition-all duration-300 flex items-center justify-center text-center ${
                    modules[name] === "success" ? "bg-green-500/10 border-green-500/30 text-green-400" :
                    modules[name] === "running" ? "bg-blue-500/10 border-blue-500/30 text-blue-400 animate-pulse" :
                    "bg-slate-800/50 border-slate-700 text-slate-500 hover:bg-slate-700/50 hover:border-slate-600"
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          {/* Log Browser */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="font-bold flex items-center gap-2 mb-4">
              <FileText className="w-4 h-4 text-slate-400" />
              Forensic Logs
            </h3>
            <div className="space-y-2 max-h-[200px] overflow-y-auto pr-2 custom-scrollbar">
              {logs.map((log, i) => (
                <div key={i} className="group flex items-center justify-between p-2 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer border border-transparent hover:border-slate-700">
                  <span className="text-xs font-mono text-slate-400 truncate">{log}</span>
                  <Activity className="w-3 h-3 text-slate-600 group-hover:text-blue-400" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Alerts & Terminal / History */}
        <div className="col-span-12 lg:col-span-8 space-y-6">
          <AnimatePresence mode="wait">
            {activeTab === "live" ? (
              <motion.div 
                key="live"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                {/* Alert Feed */}
                {alerts.length > 0 && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5">
                    <h3 className="font-bold flex items-center gap-2 text-red-400 mb-4">
                      <AlertTriangle className="w-4 h-4" />
                      Critical Findings
                    </h3>
                    <div className="space-y-3">
                      {alerts.map((alert, i) => (
                        <div key={i} className="flex gap-3 text-sm bg-red-500/5 p-3 rounded-lg border border-red-500/10">
                          <div className="mt-0.5 h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                          <span className="text-red-200/80">{alert}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Live Terminal */}
                <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col h-[calc(100vh-12rem)] shadow-2xl">
                  <div className="bg-slate-800 px-4 py-2 flex items-center justify-between border-b border-slate-700">
                    <div className="flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-slate-400" />
                      <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Forensic Stream</span>
                    </div>
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-slate-700" />
                      <div className="w-2.5 h-2.5 rounded-full bg-slate-700" />
                      <div className="w-2.5 h-2.5 rounded-full bg-slate-700" />
                    </div>
                  </div>
                  <pre 
                    ref={terminalRef}
                    className="flex-1 p-6 font-mono text-xs overflow-auto custom-scrollbar bg-[#0a0c10]"
                  >
                    {output ? (
                      output.split("\n").map((line, i) => {
                        let color = "text-slate-400";
                        if (line.includes("[MODULE:")) color = "text-blue-400 font-bold";
                        if (line.includes("[COMMAND]")) color = "text-emerald-400";
                        if (line.includes("[STDOUT]")) color = "text-slate-300";
                        if (line.includes("[STDERR]")) color = "text-red-400";
                        if (line.includes("CRITICAL")) color = "text-red-500 font-bold";
                        if (line.includes("WARNING")) color = "text-amber-400 font-bold";
                        return <div key={i} className={`${color} py-0.5`}>{line}</div>;
                      })
                    ) : (
                      <div className="text-slate-600 italic">Waiting for probe execution...</div>
                    )}
                  </pre>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                key="history"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden h-[calc(100vh-12rem)] flex flex-col"
              >
                <div className="bg-slate-800 px-6 py-4 border-b border-slate-700">
                  <h3 className="font-bold flex items-center gap-2">
                    <Database className="w-4 h-4 text-blue-400" />
                    Audit Database History
                  </h3>
                </div>
                <div className="flex-1 overflow-auto p-6 space-y-4 custom-scrollbar">
                  {runs.length > 0 ? (
                    runs.map((run) => (
                      <div key={run.id} className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 hover:bg-slate-800 transition-all group">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <span className="bg-slate-700 text-slate-300 text-[10px] font-bold px-2 py-0.5 rounded uppercase font-mono">ID: {run.id}</span>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${run.status === "SUCCESS" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                              {run.status}
                            </span>
                            <span className="text-xs text-slate-500 font-mono">{run.timestamp}</span>
                          </div>
                          <span className="text-xs font-bold text-blue-400">{run.mode}</span>
                        </div>
                        {run.summary && (
                          <div className="text-sm text-slate-300 bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 font-mono whitespace-pre-wrap">
                            {run.summary}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-4">
                      <Database className="w-12 h-12 opacity-20" />
                      <p>No historical audits found in the database.</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #1e293b;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #334155;
        }
      `}</style>
    </div>
  );
}

function MetricCard({ icon, label, value, status }: { icon: React.ReactNode, label: string, value: string, status: "critical" | "warning" | "normal" }) {
  const statusColors = {
    critical: "text-red-400 bg-red-500/10 border-red-500/20",
    warning: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    normal: "text-slate-300 bg-slate-800/50 border-slate-700"
  };

  return (
    <div className={`p-4 rounded-xl border transition-all duration-300 ${statusColors[status]}`}>
      <div className="flex items-center gap-2 mb-2 opacity-70">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-xl font-mono font-bold">{value}</div>
    </div>
  );
}
