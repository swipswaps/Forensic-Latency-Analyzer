import React, { useState, useEffect } from "react";
import { 
  ShieldCheck, 
  ShieldAlert, 
  Activity, 
  Terminal, 
  Search, 
  Cpu, 
  Zap, 
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCw
} from "lucide-react";

interface DoctorResult {
  [key: string]: {
    status: "OK" | "MISSING";
    path: string | null;
  };
}

interface SystemMetrics {
  cpus: any[];
  memory: {
    total: number;
    free: number;
    used: number;
    percent: number;
  };
  loadAvg: number[];
  uptime: number;
  platform: string;
  release: string;
  arch: string;
}

interface SystemDiagnostics {
  oomd?: string;
  dbus?: string;
  entropy?: string;
  interrupts?: string;
  error?: string;
}

export default function DoctorReport() {
  const [results, setResults] = useState<DoctorResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [networkRaw, setNetworkRaw] = useState("");

  const fetchDoctor = async () => {
    setLoading(true);
    try {
      const [doctorRes, networkRes, diagRes, metricsRes] = await Promise.all([
        fetch("/api/doctor"),
        fetch("/api/network"),
        fetch("/api/system-diagnostics"),
        fetch("/api/system-metrics")
      ]);
      const doctorData = await doctorRes.json();
      const networkData = await networkRes.json();
      const diagData = await diagRes.json();
      const metricsData = await metricsRes.json();
      
      setResults(doctorData);
      setNetworkRaw(networkData.raw);
      setDiagnostics(diagData);
      setSystemMetrics(metricsData);
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch doctor report", err);
    }
  };

  useEffect(() => {
    fetchDoctor();
  }, []);

  if (loading || !results) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 gap-3">
        <RefreshCw className="w-6 h-6 animate-spin" />
        <p className="font-mono text-sm uppercase tracking-widest">Running Environment Diagnostics...</p>
      </div>
    );
  }

  const okCount = (Object.values(results) as any[]).filter(r => r.status === "OK").length;
  const totalCount = Object.values(results).length;
  const integrityScore = Math.round((okCount / totalCount) * 100);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="grid grid-cols-12 gap-6">
        {/* Tool Availability */}
        <div className="col-span-12 lg:col-span-5 space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <ShieldCheck className="w-24 h-24" />
            </div>
            
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="bg-emerald-500/20 p-2 rounded-lg">
                  <ShieldCheck className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <h3 className="font-bold text-white">Forensic Toolchain</h3>
                  <p className="text-xs text-slate-500 font-mono">Binary availability audit</p>
                </div>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-mono text-slate-500 uppercase">Integrity Score</span>
                <span className={`text-xl font-bold font-mono ${integrityScore > 80 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {integrityScore}%
                </span>
              </div>
            </div>

            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
              {Object.entries(results).map(([tool, res]: [string, any]) => (
                <div key={tool} className="flex items-center justify-between p-2.5 bg-slate-800/30 border border-slate-800 rounded-lg group hover:border-slate-700 transition-all">
                  <div className="flex items-center gap-3">
                    {res.status === "OK" ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-red-400" />
                    )}
                    <span className="text-xs font-mono font-bold text-slate-300">{tool}</span>
                  </div>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                    res.status === "OK" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                  }`}>
                    {res.status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* System Environment */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="bg-blue-500/20 p-2 rounded-lg">
                <Cpu className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="font-bold text-white">System Environment</h3>
                <p className="text-xs text-slate-500 font-mono">Kernel & Hardware Specs</p>
              </div>
            </div>
            
            <div className="space-y-4">
              {systemMetrics && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                    <p className="text-[9px] text-slate-500 font-bold uppercase mb-1">Kernel Release</p>
                    <p className="text-xs font-mono text-slate-300 truncate">{systemMetrics.release}</p>
                  </div>
                  <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                    <p className="text-[9px] text-slate-500 font-bold uppercase mb-1">Architecture</p>
                    <p className="text-xs font-mono text-slate-300">{systemMetrics.arch.toUpperCase()}</p>
                  </div>
                  <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                    <p className="text-[9px] text-slate-500 font-bold uppercase mb-1">CPU Topology</p>
                    <p className="text-xs font-mono text-slate-300">{systemMetrics.cpus.length} Cores</p>
                  </div>
                  <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                    <p className="text-[9px] text-slate-500 font-bold uppercase mb-1">Uptime</p>
                    <p className="text-xs font-mono text-slate-300">{Math.floor(systemMetrics.uptime / 3600)}h {Math.floor((systemMetrics.uptime % 3600) / 60)}m</p>
                  </div>
                </div>
              )}

              <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl border-l-4 border-l-blue-500">
                <p className="text-xs text-slate-300 leading-relaxed">
                  The forensic toolchain is {integrityScore === 100 ? "fully operational" : integrityScore > 70 ? "partially degraded" : "severely restricted"}. 
                  {results.perf && results.perf.status === "MISSING" && " Performance profiling (perf) is unavailable. "}
                  {results.bpftrace && results.bpftrace.status === "MISSING" && " BPF tracing capabilities are restricted. "}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Network & Diagnostics */}
        <div className="col-span-12 lg:col-span-7 space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl flex flex-col h-[calc(100vh-18rem)]">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="bg-purple-500/20 p-2 rounded-lg">
                  <Zap className="w-5 h-5 text-purple-400" />
                </div>
                <div>
                  <h3 className="font-bold text-white">Network Forensic Table</h3>
                  <p className="text-xs text-slate-500 font-mono">Active sockets & connection states</p>
                </div>
              </div>
              <button 
                onClick={fetchDoctor}
                className="p-2 hover:bg-slate-800 rounded-lg transition-colors text-slate-500 hover:text-purple-400"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-hidden flex flex-col mb-4">
              <div className="bg-slate-800 px-4 py-2 flex items-center gap-2 border-b border-slate-700">
                <Terminal className="w-3 h-3 text-slate-400" />
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">ss -tunap output</span>
              </div>
              <pre className="flex-1 p-4 font-mono text-[9px] text-slate-400 overflow-auto custom-scrollbar whitespace-pre leading-tight">
                {networkRaw || "No network data available."}
              </pre>
            </div>

            {diagnostics?.interrupts && (
              <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
                <div className="bg-slate-800 px-4 py-2 flex items-center gap-2 border-b border-slate-700">
                  <Terminal className="w-3 h-3 text-slate-400" />
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Interrupt Distribution (Top 20)</span>
                </div>
                <pre className="flex-1 p-4 font-mono text-[9px] text-slate-400 overflow-auto custom-scrollbar whitespace-pre leading-tight">
                  {diagnostics.interrupts}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
