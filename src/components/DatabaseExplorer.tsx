import React, { useState, useEffect } from "react";
import { 
  Database, 
  Search, 
  Filter, 
  Download, 
  Trash2, 
  ChevronRight, 
  ChevronDown,
  AlertCircle,
  CheckCircle2,
  Clock,
  Activity,
  FileJson
} from "lucide-react";

interface Run {
  id: number;
  timestamp: string;
  mode: string;
  status: string;
  summary: string;
}

interface Metric {
  id: number;
  run_id: number;
  key: string;
  value: number;
  timestamp: string;
}

interface Alert {
  id: number;
  run_id: number;
  severity: string;
  message: string;
}

export default function DatabaseExplorer() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    fetchRuns();
  }, []);

  const fetchRuns = async () => {
    try {
      const res = await fetch("/api/db/runs");
      const data = await res.json();
      setRuns(data);
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch runs", err);
    }
  };

  const fetchRunDetails = async (runId: number) => {
    try {
      const [metricsRes, alertsRes] = await Promise.all([
        fetch(`/api/db/metrics/${runId}`),
        fetch(`/api/db/alerts/${runId}`)
      ]);
      const metricsData = await metricsRes.json();
      const alertsData = await alertsRes.json();
      setMetrics(metricsData);
      setAlerts(alertsData);
      setSelectedRun(runId);
    } catch (err) {
      console.error("Failed to fetch run details", err);
    }
  };

  const filteredRuns = runs.filter(run => 
    run.mode.toLowerCase().includes(searchTerm.toLowerCase()) ||
    run.status.toLowerCase().includes(searchTerm.toLowerCase()) ||
    run.summary?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="grid grid-cols-12 gap-6 h-[calc(100vh-12rem)] animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Runs List */}
      <div className="col-span-12 lg:col-span-4 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-xl">
        <div className="p-4 border-b border-slate-800 bg-slate-800/50">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input 
              type="text" 
              placeholder="Search audits..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
            />
          </div>
        </div>

        <div className="flex-1 overflow-auto custom-scrollbar p-2 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center h-full text-slate-500 gap-2">
              <Activity className="w-4 h-4 animate-spin" />
              <span className="text-xs font-mono uppercase">Querying Database...</span>
            </div>
          ) : filteredRuns.length > 0 ? (
            filteredRuns.map((run) => (
              <button
                key={run.id}
                onClick={() => fetchRunDetails(run.id)}
                className={`w-full text-left p-4 rounded-xl border transition-all group ${
                  selectedRun === run.id 
                    ? "bg-blue-600/10 border-blue-500/50 shadow-lg shadow-blue-900/10" 
                    : "bg-slate-800/30 border-slate-800 hover:bg-slate-800 hover:border-slate-700"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold font-mono text-slate-500 uppercase">Audit #{run.id}</span>
                  <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                    run.status === "SUCCESS" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
                  }`}>
                    {run.status === "SUCCESS" ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                    {run.status}
                  </div>
                </div>
                <h4 className="font-bold text-white mb-1">{run.mode}</h4>
                <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono">
                  <Clock className="w-3 h-3" />
                  {new Date(run.timestamp).toLocaleString()}
                </div>
              </button>
            ))
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-3 opacity-50">
              <Database className="w-12 h-12" />
              <p className="text-sm italic">No matching records found</p>
            </div>
          )}
        </div>
      </div>

      {/* Run Details */}
      <div className="col-span-12 lg:col-span-8 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-xl">
        {selectedRun ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="p-6 border-b border-slate-800 bg-slate-800/30">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4">
                  <div className="bg-blue-500/20 p-3 rounded-xl">
                    <Database className="w-6 h-6 text-blue-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">Audit Details</h2>
                    <p className="text-xs text-slate-500 font-mono uppercase tracking-widest">Run ID: {selectedRun}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="p-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-400 transition-colors">
                    <Download className="w-4 h-4" />
                  </button>
                  <button className="p-2 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-400 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto custom-scrollbar p-6 space-y-8">
              {/* Summary Section */}
              <section>
                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <FileJson className="w-3 h-3" />
                  Executive Summary
                </h3>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-sm text-slate-300 whitespace-pre-wrap leading-relaxed shadow-inner">
                  {runs.find(r => r.id === selectedRun)?.summary || "No summary available for this run."}
                </div>
              </section>

              {/* Alerts Section */}
              {alerts.length > 0 && (
                <section>
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                    <AlertCircle className="w-3 h-3 text-red-400" />
                    Security & Performance Alerts
                  </h3>
                  <div className="grid grid-cols-1 gap-3">
                    {alerts.map((alert) => (
                      <div key={alert.id} className="flex gap-4 p-4 bg-red-500/5 border border-red-500/20 rounded-xl group hover:border-red-500/40 transition-all">
                        <div className={`mt-1 h-2 w-2 rounded-full shrink-0 ${alert.severity === "CRITICAL" ? "bg-red-500 animate-pulse" : "bg-amber-500"}`} />
                        <div>
                          <p className="text-sm text-slate-200 leading-relaxed">{alert.message}</p>
                          <span className="text-[10px] font-bold text-red-400/60 uppercase mt-2 block">{alert.severity}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Metrics Section */}
              <section>
                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <Activity className="w-3 h-3 text-blue-400" />
                  Captured Metrics
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {metrics.map((metric) => (
                    <div key={metric.id} className="bg-slate-800/30 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all">
                      <p className="text-[10px] font-bold text-slate-500 uppercase mb-1 truncate">{metric.key.replace(/_/g, " ")}</p>
                      <p className="text-lg font-bold text-white font-mono">{metric.value}</p>
                      <p className="text-[8px] text-slate-600 font-mono mt-1">{new Date(metric.timestamp).toLocaleTimeString()}</p>
                    </div>
                  ))}
                  {metrics.length === 0 && (
                    <div className="col-span-full py-8 text-center text-slate-600 italic text-sm border border-dashed border-slate-800 rounded-xl">
                      No metrics recorded for this run.
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-600 gap-4 opacity-50">
            <div className="bg-slate-800 p-6 rounded-full">
              <Database className="w-12 h-12" />
            </div>
            <div className="text-center">
              <p className="font-bold text-lg">No Audit Selected</p>
              <p className="text-sm">Select a record from the list to view forensic details</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
