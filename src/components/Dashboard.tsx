import React, { useState, useEffect } from 'react';
import { ProcessTree } from './ProcessTree';
import { MetricChart } from './MetricChart';
import { 
  Shield, 
  Cpu, 
  Database, 
  Network, 
  AlertTriangle, 
  Terminal,
  Activity,
  Clock,
  HardDrive,
  Info,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Run {
  id: number;
  timestamp: string;
  mode: string;
  status: string;
  summary: string;
}

interface ProcessNode {
  name: string;
  value?: number;
  children?: ProcessNode[];
}

interface SystemMetrics {
  loadAvg: number[];
  memory: {
    percent: number;
    used: number;
    total: number;
  };
  uptime: number;
}

export const Dashboard: React.FC = () => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedProcess, setSelectedProcess] = useState<ProcessNode | null>(null);
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [isProbing, setIsProbing] = useState(false);
  const [probeOutput, setProbeOutput] = useState<string[]>([]);
  const [showTerminal, setShowTerminal] = useState(false);

  const fetchRuns = async () => {
    try {
      const response = await fetch('/api/db/runs');
      const data = await response.json();
      setRuns(data);
      if (data.length > 0 && !selectedRunId) {
        setSelectedRunId(data[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch runs:', error);
    }
  };

  const runProbe = async (advanced = false) => {
    setIsProbing(true);
    setProbeOutput([]);
    setShowTerminal(true);
    
    try {
      const response = await fetch('/api/run-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ advanced })
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          setProbeOutput(prev => [...prev, chunk].slice(-100));
        }
      }
      
      // Refresh runs after completion
      await fetchRuns();
    } catch (error) {
      setProbeOutput(prev => [...prev, `\n[ERROR] Failed to trigger probe: ${error}`]);
    } finally {
      setIsProbing(false);
    }
  };

  const fetchSystemMetrics = async () => {
    try {
      const response = await fetch('/api/system-metrics');
      const data = await response.json();
      setSystemMetrics(data);
    } catch (error) {
      console.error('Failed to fetch system metrics:', error);
    }
  };

  useEffect(() => {
    fetchRuns();
    fetchSystemMetrics();
    const interval = setInterval(fetchSystemMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (runs.length > 0) setLoading(false);
  }, [runs]);

  const selectedRun = runs.find(r => r.id === selectedRunId);

  return (
    <div className="min-h-screen p-6 lg:p-10 max-w-[1600px] mx-auto space-y-8">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-800 pb-8">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <Shield className="w-6 h-6 text-emerald-400" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white font-mono uppercase">
              Forensic Latency Analyzer <span className="text-emerald-500">v13.2.6</span>
            </h1>
          </div>
          <p className="text-slate-400 font-mono text-sm uppercase tracking-widest pl-12">
            Canonical Probe & System Integrity Dashboard
          </p>
        </div>
        
        <div className="flex items-center gap-6 font-mono text-[10px] uppercase tracking-widest text-slate-500">
          <div className="flex flex-col items-end">
            <span className="text-slate-600">Status</span>
            <span className="text-emerald-400 flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Operational
            </span>
          </div>
          <div className="flex flex-col items-end border-l border-slate-800 pl-6">
            <span className="text-slate-600">Environment</span>
            <span className="text-slate-300">Fedora Linux 6.19.9</span>
          </div>
        </div>
      </header>

      {/* Real-time Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="technical-panel p-4 flex items-center gap-4"
        >
          <div className="p-3 bg-blue-500/10 rounded-lg border border-blue-500/20">
            <Cpu className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <div className="metric-label">CPU Load (1m)</div>
            <div className="metric-value text-blue-400">
              {systemMetrics?.loadAvg[0].toFixed(2) || '0.00'}
            </div>
          </div>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="technical-panel p-4 flex items-center gap-4"
        >
          <div className="p-3 bg-purple-500/10 rounded-lg border border-purple-500/20">
            <Database className="w-5 h-5 text-purple-400" />
          </div>
          <div>
            <div className="metric-label">Memory Usage</div>
            <div className="metric-value text-purple-400">
              {systemMetrics?.memory.percent.toFixed(1) || '0.0'}%
            </div>
          </div>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="technical-panel p-4 flex items-center gap-4"
        >
          <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20">
            <Clock className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <div className="metric-label">System Uptime</div>
            <div className="metric-value text-amber-400">
              {systemMetrics ? Math.floor(systemMetrics.uptime / 3600) : '0'}h
            </div>
          </div>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="technical-panel p-4 flex items-center gap-4"
        >
          <div className="p-3 bg-rose-500/10 rounded-lg border border-rose-500/20">
            <AlertTriangle className="w-5 h-5 text-rose-400" />
          </div>
          <div>
            <div className="metric-label">Active Alerts</div>
            <div className="metric-value text-rose-400">
              {selectedRun?.summary ? selectedRun.summary.split('\n').filter(l => l.includes('CRITICAL')).length : '0'}
            </div>
          </div>
        </motion.div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Process Tree (2/3 width) */}
        <div className="lg:col-span-2 space-y-6">
          <div className="relative">
            <ProcessTree onSelectProcess={setSelectedProcess} />
            
            <AnimatePresence>
              {selectedProcess && (
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="absolute top-4 right-4 w-64 bg-slate-900/95 border border-slate-700 rounded-lg shadow-2xl p-4 backdrop-blur-md z-10"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Info className="w-4 h-4 text-emerald-400" />
                      <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Process Inspector</span>
                    </div>
                    <button onClick={() => setSelectedProcess(null)} className="text-slate-500 hover:text-white">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <div className="text-[9px] text-slate-600 uppercase mb-1">Command</div>
                      <div className="text-xs font-mono text-emerald-400 break-all">{selectedProcess.name}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-[9px] text-slate-600 uppercase mb-1">Weight</div>
                        <div className="text-xs font-mono text-slate-300">{selectedProcess.value || 1}</div>
                      </div>
                      <div>
                        <div className="text-[9px] text-slate-600 uppercase mb-1">Children</div>
                        <div className="text-xs font-mono text-slate-300">{selectedProcess.children?.length || 0}</div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {selectedRunId && (
              <>
                <MetricChart 
                  title="CPU Pressure (PSI)" 
                  runId={selectedRunId} 
                  runMode={selectedRun?.mode || ''}
                  metricKey="CPU_PRESSURE" 
                  color="#3b82f6"
                />
                <MetricChart 
                  title="I/O Pressure (PSI)" 
                  runId={selectedRunId} 
                  runMode={selectedRun?.mode || ''}
                  metricKey="IO_PRESSURE" 
                  color="#f59e0b"
                />
              </>
            )}
          </div>
        </div>

        {/* Right Column: Run History & Alerts */}
        <div className="space-y-6">
          {/* Live Control Panel */}
          <div className="technical-panel p-4 border-emerald-500/20 bg-emerald-500/5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <h3 className="text-sm font-semibold uppercase tracking-wider text-emerald-400">Live Control</h3>
              </div>
              {isProbing && (
                <div className="flex items-center gap-2 text-[10px] font-mono text-emerald-500 animate-pulse">
                  <Activity className="w-3 h-3" />
                  PROBE ACTIVE
                </div>
              )}
            </div>
            
            <div className="grid grid-cols-2 gap-2 mb-4">
              <button
                disabled={isProbing}
                onClick={() => runProbe(false)}
                className="flex items-center justify-center gap-2 py-2 px-3 bg-emerald-500/10 border border-emerald-500/30 rounded text-[10px] font-mono text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50 transition-all"
              >
                <Activity className="w-3.5 h-3.5" />
                Standard
              </button>
              <button
                disabled={isProbing}
                onClick={() => runProbe(true)}
                className="flex items-center justify-center gap-2 py-2 px-3 bg-blue-500/10 border border-blue-500/30 rounded text-[10px] font-mono text-blue-400 hover:bg-blue-500/20 disabled:opacity-50 transition-all"
              >
                <Shield className="w-3.5 h-3.5" />
                Advanced
              </button>
            </div>

            {showTerminal && (
              <div className="relative group">
                <div className="h-32 bg-black/80 rounded border border-slate-800 p-2 font-mono text-[9px] text-emerald-500/80 overflow-y-auto custom-scrollbar whitespace-pre-wrap">
                  {probeOutput.length === 0 ? '> Initializing forensic environment...' : probeOutput.join('')}
                </div>
                <button 
                  onClick={() => setShowTerminal(false)}
                  className="absolute top-1 right-1 p-1 text-slate-600 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          <div className="technical-panel p-4 h-full flex flex-col">
            <div className="flex items-center gap-2 mb-4">
              <Terminal className="w-4 h-4 text-slate-400" />
              <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Audit History</h3>
            </div>
            
            <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
              {runs.map((run) => (
                <button
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id)}
                  className={`w-full text-left p-3 rounded-md border transition-all duration-200 group relative ${
                    selectedRunId === run.id 
                      ? 'bg-emerald-500/10 border-emerald-500/30 ring-1 ring-emerald-500/20' 
                      : 'bg-slate-900/30 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  {selectedRunId === run.id && (
                    <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-md ${
                      run.status === 'SUCCESS' ? 'bg-emerald-500' : 'bg-rose-500'
                    }`} />
                  )}
                  <div className="flex justify-between items-start mb-1">
                    <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                      run.status === 'SUCCESS' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                    }`}>
                      RUN #{run.id}
                    </span>
                    <span className="text-[10px] font-mono text-slate-600 group-hover:text-slate-400">
                      {new Date(run.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-slate-300 truncate mb-1">
                    Mode: {run.mode}
                  </div>
                  <div className="text-[10px] text-slate-500 line-clamp-2 italic">
                    {run.summary ? (
                      run.summary.split('\n')[0]
                    ) : (
                      run.status === 'SUCCESS' ? 'System Integrity Verified (Baseline)' : 'No summary recorded.'
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="technical-panel p-4">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
              <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Critical Findings</h3>
            </div>
            <div className="space-y-3">
              {selectedRun?.summary ? (
                selectedRun.summary.split('\n').map((line, i) => (
                  line.trim() && (
                    <div key={i} className="flex gap-3 p-3 rounded bg-rose-500/5 border border-rose-500/10">
                      <div className="mt-0.5">
                        {line.includes('CRITICAL') ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
                        ) : (
                          <Activity className="w-3.5 h-3.5 text-amber-500" />
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-slate-300 leading-relaxed">
                        {line}
                      </div>
                    </div>
                  )
                ))
              ) : (
                <div className="text-center py-8 flex flex-col items-center gap-3">
                  <Shield className="w-8 h-8 text-emerald-500/20" />
                  <div className="text-[10px] font-mono text-slate-600 uppercase tracking-widest">
                    {selectedRun?.status === 'SUCCESS' ? 'System Healthy - No Anomalies' : 'No Anomalies Detected'}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="pt-8 border-t border-slate-900 flex flex-col md:flex-row justify-between items-center gap-4 text-[10px] font-mono text-slate-600 uppercase tracking-widest">
        <div className="flex items-center gap-4">
          <span>System ID: {(systemMetrics as any)?.arch?.toUpperCase() || 'X86_64'}-{Math.random().toString(36).substring(7).toUpperCase()}</span>
          <span className="w-1 h-1 rounded-full bg-slate-800" />
          <span>Kernel: {(systemMetrics as any)?.release || 'Detecting...'}</span>
        </div>
        <div className="flex items-center gap-6">
          <a href="#" className="hover:text-emerald-400 transition-colors">Documentation</a>
          <a href="#" className="hover:text-emerald-400 transition-colors">API Reference</a>
          <span className="text-slate-800">|</span>
          <span>© 2026 Forensic Labs</span>
        </div>
      </footer>
    </div>
  );
};
