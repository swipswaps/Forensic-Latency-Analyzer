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

export default function DoctorReport() {
  const [results, setResults] = useState<DoctorResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [networkRaw, setNetworkRaw] = useState("");

  const fetchDoctor = async () => {
    setLoading(true);
    try {
      const [doctorRes, networkRes] = await Promise.all([
        fetch("/api/doctor"),
        fetch("/api/network")
      ]);
      const doctorData = await doctorRes.json();
      const networkData = await networkRes.json();
      setResults(doctorData);
      setNetworkRaw(networkData.raw);
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

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="grid grid-cols-12 gap-6">
        {/* Tool Availability */}
        <div className="col-span-12 lg:col-span-5 space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
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
              <button 
                onClick={fetchDoctor}
                className="p-2 hover:bg-slate-800 rounded-lg transition-colors text-slate-500 hover:text-blue-400"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              {Object.entries(results).map(([tool, res]: [string, any]) => (
                <div key={tool} className="flex items-center justify-between p-3 bg-slate-800/30 border border-slate-800 rounded-lg group hover:border-slate-700 transition-all">
                  <div className="flex items-center gap-3">
                    {res.status === "OK" ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-400" />
                    )}
                    <span className="text-sm font-mono font-bold text-slate-300">{tool}</span>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                    res.status === "OK" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                  }`}>
                    {res.status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Security Summary */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="bg-blue-500/20 p-2 rounded-lg">
                <Activity className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="font-bold text-white">Health Summary</h3>
                <p className="text-xs text-slate-500 font-mono">System integrity assessment</p>
              </div>
            </div>
            
            <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl border-l-4 border-l-blue-500">
              <p className="text-sm text-slate-300 leading-relaxed">
                The forensic toolchain is {(Object.values(results) as any[]).every(r => r.status === "OK") ? "fully operational" : "partially degraded"}. 
                {results.perf && results.perf.status === "MISSING" && " Performance profiling (perf) is unavailable. "}
                {results.bpftrace && results.bpftrace.status === "MISSING" && " BPF tracing capabilities are restricted. "}
                Ensure the host has the required kernel headers and tracing utilities installed for full transparency.
              </p>
            </div>
          </div>
        </div>

        {/* Network Connections */}
        <div className="col-span-12 lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl flex flex-col h-[calc(100vh-18rem)]">
          <div className="flex items-center gap-3 mb-6">
            <div className="bg-purple-500/20 p-2 rounded-lg">
              <Zap className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <h3 className="font-bold text-white">Network Forensic Table</h3>
              <p className="text-xs text-slate-500 font-mono">Active sockets & connection states</p>
            </div>
          </div>

          <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
            <div className="bg-slate-800 px-4 py-2 flex items-center gap-2 border-b border-slate-700">
              <Terminal className="w-3 h-3 text-slate-400" />
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">ss -tunap output</span>
            </div>
            <pre className="flex-1 p-4 font-mono text-[10px] text-slate-400 overflow-auto custom-scrollbar whitespace-pre leading-tight">
              {networkRaw || "No network data available."}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
