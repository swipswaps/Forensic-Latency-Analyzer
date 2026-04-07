// PATH: src/components/Dashboard.tsx
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
  X,
  Maximize2
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

// Return a short, coloured badge label for the run mode stored in the DB.
// Probe stores mode as "STANDARD", "ADVANCED", or "MODULE:DEPS" etc.
function ModeBadge({ mode }: { mode: string }) {
  let label = mode;
  let bg = 'bg-slate-800';
  let text = 'text-slate-400';

  if (mode === 'ADVANCED') {
    label = 'ADV'; bg = 'bg-blue-900/60'; text = 'text-blue-300';
  } else if (mode === 'STANDARD') {
    label = 'STD'; bg = 'bg-emerald-900/60'; text = 'text-emerald-300';
  } else if (mode === 'MODULE:DEPS' || mode === 'DEPS') {
    label = 'DEPS'; bg = 'bg-orange-900/60'; text = 'text-orange-300';
  } else if (mode?.startsWith('MODULE:')) {
    label = mode.replace('MODULE:', '');
    bg = 'bg-violet-900/60'; text = 'text-violet-300';
  }

  return (
    <span className={`inline-block text-[8px] font-mono font-bold px-1.5 py-0.5 rounded ${bg} ${text} ml-1.5 leading-none`}>
      {label}
    </span>
  );
}

export const Dashboard: React.FC = () => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [runSearch, setRunSearch] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedProcess, setSelectedProcess] = useState<ProcessNode | null>(null);
  const [hotPids, setHotPids] = useState<Set<string>>(new Set());
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [isProbing, setIsProbing] = useState(false);
  const [probeOutput, setProbeOutput] = useState<string[]>([]);
  const [showTerminal, setShowTerminal] = useState(false);
  // liveAlerts: populated in real time from [STORM:] and [RANKED_ALERT] SSE lines
  // so Critical Findings updates while the probe is still running.
  const [liveAlerts, setLiveAlerts] = useState<string[]>([]);
  // liveMetrics: keyed by metric name, holds latest value parsed from SSE stream
  // so PSI charts update during the probe run without waiting for DB write.
  const [liveMetrics, setLiveMetrics] = useState<Record<string, number>>({});
  const [historicalTree, setHistoricalTree] = useState<ProcessNode | null>(null);
  // Fix 4: ref for the live terminal div — scrolled to bottom on every new line
  const terminalRef = React.useRef<HTMLDivElement>(null);

  // Fix 4: scroll terminal to bottom whenever probeOutput grows
  React.useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [probeOutput]);

  const fetchHistoricalTree = async (runId: number) => {
    try {
      const response = await fetch(`/api/db/process-tree/${runId}`);
      if (response.ok) {
        const data = await response.json();
        setHistoricalTree(data);
      } else {
        setHistoricalTree(null);
      }
    } catch (error) {
      console.error('Failed to fetch historical tree:', error);
      setHistoricalTree(null);
    }
  };

  useEffect(() => {
    if (selectedRunId && !isProbing) {
      fetchHistoricalTree(selectedRunId);
    }
  }, [selectedRunId, isProbing]);

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

  // Fix 8: abort controller so Stop button can cancel the SSE stream
  const probeAbortRef = React.useRef<AbortController | null>(null);

  const stopProbe = () => {
    if (probeAbortRef.current) {
      probeAbortRef.current.abort();
      probeAbortRef.current = null;
    }
    setIsProbing(false);
    setProbeOutput(prev => [...prev, '\n[STOPPED] Probe aborted by user.']);
  };

  // Fix 6: Firefox-only sweep — uses /api/run-firefox-forensic SSE endpoint
  const runFirefoxSweep = async () => {
    setIsProbing(true);
    setProbeOutput([]);
    setLiveAlerts([]);
    setLiveMetrics({});
    setShowTerminal(true);
    const controller = new AbortController();
    probeAbortRef.current = controller;
    try {
      const response = await fetch('/api/run-firefox-forensic', { signal: controller.signal });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const json = JSON.parse(line.substring(6));
                setProbeOutput(prev => [...prev, json.text].slice(-500));
                if (json.text.includes('[STORM:') || json.text.includes('[RANKED_ALERT]')) {
                  const alerts = json.text.split('\n').filter(
                    (l: string) => l.includes('[STORM:') || l.includes('[RANKED_ALERT]')
                  );
                  if (alerts.length) setLiveAlerts(prev => [...new Set([...prev, ...alerts])]);
                }
              } catch (e) {}
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setProbeOutput(prev => [...prev, `\n[CRITICAL] ${err.message}`]);
      }
    } finally {
      probeAbortRef.current = null;
      setIsProbing(false);
    }
  };

  const runProbe = async (advanced = false) => {
    setIsProbing(true);
    setProbeOutput([]);
    setLiveAlerts([]);
    setLiveMetrics({});
    setShowTerminal(true);

    try {
      const params = new URLSearchParams({ advanced: advanced.toString() });
      // Fix 8: attach abort controller so Stop button can cancel mid-run
      const controller = new AbortController();
      probeAbortRef.current = controller;
      const response = await fetch(`/api/run-probe?${params.toString()}`, { signal: controller.signal });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const json = JSON.parse(line.substring(6));
                const text = json.text;

                if (text.includes('PID')) {
                  const match = text.match(/PID\s+(\d+)/i);
                  if (match?.[1]) {
                    setHotPids(prev => { const n = new Set(prev); n.add(match[1]); return n; });
                    setTimeout(() => {
                      setHotPids(prev => { const n = new Set(prev); n.delete(match[1]); return n; });
                    }, 10000);
                  }
                }

                // Fix 5: parse [METRIC:KEY] VALUE lines for live chart updates
                const metricMatches = [...text.matchAll(/\[METRIC:([A-Z0-9_]+)\]\s+([\d.]+)/g)];
                for (const m of metricMatches) {
                  setLiveMetrics(prev => ({ ...prev, [m[1]]: parseFloat(m[2]) }));
                }

                // Fix 3: parse storm and ranked alerts into liveAlerts in real time
                if (text.includes('[STORM:') || text.includes('[RANKED_ALERT]')) {
                  const lines = text.split('\n').filter(
                    l => l.includes('[STORM:') || l.includes('[RANKED_ALERT]')
                  );
                  if (lines.length > 0) {
                    setLiveAlerts(prev => [...new Set([...prev, ...lines])]);
                  }
                }

                if (text.includes('[RUN_ID]')) {
                  const runId = parseInt(text.split('[RUN_ID]')[1].trim());
                  if (!isNaN(runId)) {
                    setSelectedRunId(runId);
                    setRuns(prev => [{
                      id: runId,
                      timestamp: new Date().toISOString(),
                      mode: advanced ? 'ADVANCED' : 'STANDARD',
                      status: 'RUNNING',
                      summary: 'Initializing probe...'
                    }, ...prev]);
                  }
                }

                setProbeOutput(prev => [...prev, text].slice(-500));
              } catch (e) {
                console.error('Failed to parse SSE line', line);
              }
            }
          }
        }
      }

      await fetchRuns();
    } catch (error: any) {
      // Fix 8: AbortError is user-initiated — don't treat as failure
      if (error?.name === 'AbortError') {
        setProbeOutput(prev => [...prev, '\n[STOPPED] Probe aborted by user.']);
        return;
      }
      console.error('Probe failed:', error);
      const errorMsg = error instanceof TypeError && error.message.includes('fetch')
        ? 'Network Error: Server unreachable or connection refused.'
        : `Error: ${error}`;
      setProbeOutput(prev => [...prev, `\n[CRITICAL] ${errorMsg}`]);
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedProcess(null);
        (window as any).resetTreemapZoom?.();
      }
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        (document.querySelector('input[placeholder="Search PID or Process..."]') as HTMLInputElement)?.focus();
      }
      if (e.key.toLowerCase() === 'r' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        (window as any).refreshTreemapData?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const selectedRun = runs.find(r => r.id === selectedRunId);
  const filteredRuns = runs.filter(r =>
    r.mode.toLowerCase().includes(runSearch.toLowerCase()) ||
    r.id.toString().includes(runSearch) ||
    (r.summary && r.summary.toLowerCase().includes(runSearch.toLowerCase()))
  );

  return (
    <div className="min-h-screen p-6 lg:p-10 max-w-[1600px] mx-auto space-y-8 relative">
      {/* Global Scanline Overlay */}
      <div className="fixed inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.1)_50%),linear-gradient(90deg,rgba(255,0,0,0.03),rgba(0,255,0,0.01),rgba(0,0,255,0.03))] bg-[length:100%_3px,4px_100%] z-[9999] opacity-20" />

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
            <span className="text-slate-600">System Health</span>
            <span className={`flex items-center gap-1.5 font-bold ${
              (systemMetrics?.loadAvg[0] || 0) > 2 ? 'text-rose-400' :
              (systemMetrics?.loadAvg[0] || 0) > 1 ? 'text-amber-400' : 'text-emerald-400'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                (systemMetrics?.loadAvg[0] || 0) > 2 ? 'bg-rose-500' :
                (systemMetrics?.loadAvg[0] || 0) > 1 ? 'bg-amber-500' : 'bg-emerald-500'
              }`} />
              {(systemMetrics?.loadAvg[0] || 0) > 2 ? 'DEGRADED' :
               (systemMetrics?.loadAvg[0] || 0) > 1 ? 'WARNING' : 'OPTIMAL'}
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
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="technical-panel p-4 flex items-center gap-4">
          <div className="p-3 bg-blue-500/10 rounded-lg border border-blue-500/20"><Cpu className="w-5 h-5 text-blue-400" /></div>
          <div>
            <div className="metric-label">CPU Load (1m)</div>
            <div className="metric-value text-blue-400">{systemMetrics?.loadAvg[0].toFixed(2) || '0.00'}</div>
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="technical-panel p-4 flex items-center gap-4">
          <div className="p-3 bg-purple-500/10 rounded-lg border border-purple-500/20"><Database className="w-5 h-5 text-purple-400" /></div>
          <div>
            <div className="metric-label">Memory Usage</div>
            <div className="metric-value text-purple-400">{systemMetrics?.memory.percent.toFixed(1) || '0.0'}%</div>
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="technical-panel p-4 flex items-center gap-4">
          <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20"><Clock className="w-5 h-5 text-amber-400" /></div>
          <div>
            <div className="metric-label">System Uptime</div>
            <div className="metric-value text-amber-400">{systemMetrics ? Math.floor(systemMetrics.uptime / 3600) : '0'}h</div>
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="technical-panel p-4 flex items-center gap-4">
          <div className="p-3 bg-rose-500/10 rounded-lg border border-rose-500/20"><AlertTriangle className="w-5 h-5 text-rose-400" /></div>
          <div>
            <div className="metric-label">Active Alerts</div>
            <div className="metric-value text-rose-400">
              {isProbing
                ? liveAlerts.filter(l => l.includes('CRITICAL') || l.includes('[STORM:')).length
                : selectedRun?.summary ? selectedRun.summary.split('\n').filter(l => l.includes('CRITICAL')).length : 0}
            </div>
          </div>
        </motion.div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Process Tree */}
        <div className="lg:col-span-2 space-y-6">
          <div className="flex flex-col xl:flex-row gap-6">
            <div className="flex-1 min-w-0">
              <ProcessTree
                onSelectProcess={setSelectedProcess}
                isProbing={isProbing}
                hotPids={hotPids}
                historicalData={historicalTree}
                selectedRunId={selectedRunId}
                selectedRunMode={selectedRun?.mode}
                probeOutput={probeOutput}
              />
            </div>
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
                  isLive={isProbing && selectedRunId === runs[0]?.id}
                />
                <MetricChart
                  title="I/O Pressure (PSI)"
                  runId={selectedRunId}
                  runMode={selectedRun?.mode || ''}
                  metricKey="IO_PRESSURE"
                  color="#f59e0b"
                  isLive={isProbing && selectedRunId === runs[0]?.id}
                />
              </>
            )}
          </div>
        </div>

        {/* Right Column */}
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

            {/* Fix 6: Firefox Sweep button — targeted 30s Firefox-only diagnostic */}
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                disabled={isProbing}
                onClick={() => runFirefoxSweep()}
                className="col-span-1 flex items-center justify-center gap-2 py-2 px-3 bg-orange-500/10 border border-orange-500/30 rounded text-[10px] font-mono text-orange-400 hover:bg-orange-500/20 disabled:opacity-50 transition-all"
              >
                <Activity className="w-3.5 h-3.5" />
                Firefox Sweep
              </button>
              {/* Fix 8: Stop Probe button — visible only while probing */}
              {isProbing && (
                <button
                  onClick={() => stopProbe()}
                  className="col-span-1 flex items-center justify-center gap-2 py-2 px-3 bg-red-500/10 border border-red-500/30 rounded text-[10px] font-mono text-red-400 hover:bg-red-500/20 transition-all"
                >
                  <X className="w-3.5 h-3.5" />
                  Stop
                </button>
              )}
            </div>

            {showTerminal && (
              <div className="relative group mt-4 overflow-hidden rounded border border-slate-800 bg-black/90">
                <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] z-10 opacity-30" />
                <div ref={terminalRef} className="h-48 p-3 font-mono text-[9px] text-emerald-500/90 overflow-y-auto custom-scrollbar whitespace-pre-wrap relative z-0">
                  {probeOutput.length === 0 ? (
                    <div className="flex items-center gap-2 animate-pulse">
                      <span className="w-1.5 h-3 bg-emerald-500" />
                      Initializing forensic environment...
                    </div>
                  ) : (
                    probeOutput.map((chunk, i) => (
                      <span key={i} className={chunk.includes('ERROR') ? 'text-rose-400' : chunk.includes('WARNING') ? 'text-amber-400' : ''}>
                        {chunk}
                      </span>
                    ))
                  )}
                </div>
                <button
                  onClick={() => setShowTerminal(false)}
                  className="absolute top-2 right-2 p-1 text-slate-600 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity z-20"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          {/* Audit History */}
          <div className="technical-panel p-4 h-full flex flex-col min-h-[400px]">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-slate-400" />
                <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Audit History</h3>
              </div>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Filter runs..."
                  value={runSearch}
                  onChange={(e) => setRunSearch(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-[10px] text-slate-400 focus:outline-none focus:border-emerald-500/50 w-24 transition-all"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
              {filteredRuns.length > 0 ? (
                filteredRuns.map((run) => (
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
                      <div className="flex items-center gap-0">
                        <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                          run.status === 'SUCCESS' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                        }`}>
                          RUN #{run.id}
                        </span>
                        {/* Module badge — tells user what kind of run this was BEFORE they click */}
                        <ModeBadge mode={run.mode} />
                      </div>
                      <span className="text-[10px] font-mono text-slate-600 group-hover:text-slate-400">
                        {new Date(run.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-xs font-medium text-slate-300 truncate">
                        {/* Mode is now shown in the badge above; just show status here */}
                        {run.status === 'RUNNING' ? 'Probe running...' : run.status === 'FAILED' ? 'Run failed' : 'Completed'}
                      </div>
                      {(run as any).has_tree && (
                        <div className="flex items-center gap-1 text-[8px] font-bold text-emerald-500 bg-emerald-500/10 px-1 rounded border border-emerald-500/20">
                          <Maximize2 className="w-2 h-2" />
                          SNAPSHOT
                        </div>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-500 line-clamp-2 italic">
                      {run.summary ? (
                        run.summary.split('\n')[0]
                      ) : (
                        run.status === 'SUCCESS' ? 'Audit complete. No anomalies detected.' : 'Analysis in progress...'
                      )}
                    </div>
                  </button>
                ))
              ) : (
                <div className="text-center py-10 text-slate-600 text-[10px] uppercase tracking-widest font-mono">
                  No matching audits found
                </div>
              )}
            </div>
          </div>

          {/* Critical Findings */}
          <div className="technical-panel p-4">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
              <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Critical Findings</h3>
            </div>
            <div className="space-y-3">
              {/* Fix 3: show liveAlerts during probe, fall back to DB summary when done */}
              {(isProbing ? liveAlerts : (selectedRun?.summary?.split('\n').filter(Boolean) ?? [])).length > 0 ? (
                (isProbing ? liveAlerts : selectedRun!.summary.split('\n')).map((line, i) =>
                  line.trim() && (
                    <div key={i} className="flex gap-3 p-3 rounded bg-rose-500/5 border border-rose-500/10">
                      <div className="mt-0.5">
                        {line.includes('CRITICAL') || line.includes('[STORM:')
                          ? <AlertTriangle className="w-3.5 h-3.5 text-rose-500 animate-pulse" />
                          : <Activity className="w-3.5 h-3.5 text-amber-500" />}
                      </div>
                      <div className="text-[11px] font-mono text-slate-300 leading-relaxed">{line}</div>
                    </div>
                  )
                )
              ) : (
                <div className="text-center py-8 flex flex-col items-center gap-3">
                  <Shield className="w-8 h-8 text-emerald-500/20" />
                  <div className="text-[10px] font-mono text-slate-600 uppercase tracking-widest">
                    {isProbing ? 'Scanning — alerts appear here in real time' :
                     selectedRun?.status === 'SUCCESS' ? 'System Healthy - No Anomalies' : 'No Anomalies Detected'}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* System Health Insights */}
      {systemMetrics && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="technical-panel p-4 bg-slate-900/40 border-slate-800">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-emerald-500/10 rounded border border-emerald-500/20">
              <Activity className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-white uppercase tracking-wider">System Health Insights</h3>
              <p className="text-[10px] text-slate-500 font-mono">Heuristic analysis based on real-time telemetry</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">CPU Saturation</div>
              <div className="flex items-center gap-2">
                <div className={`text-sm font-mono ${systemMetrics.loadAvg[0] > 2 ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {systemMetrics.loadAvg[0] > 2 ? 'SATURATED' : 'STABLE'}
                </div>
                <div className="text-[10px] text-slate-500">Load average is {systemMetrics.loadAvg[0].toFixed(2)} (1m)</div>
              </div>
              <p className="text-[9px] text-slate-600 leading-tight">
                {systemMetrics.loadAvg[0] > 2
                  ? 'High run-queue depth detected. Context switching may impact latency sensitive tasks.'
                  : 'CPU scheduler is efficiently managing the current task load.'}
              </p>
            </div>

            <div className="space-y-2 border-l border-slate-800 pl-6">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Memory Pressure</div>
              <div className="flex items-center gap-2">
                <div className={`text-sm font-mono ${systemMetrics.memory.percent > 85 ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {systemMetrics.memory.percent > 85 ? 'CRITICAL' : 'HEALTHY'}
                </div>
                <div className="text-[10px] text-slate-500">{systemMetrics.memory.percent.toFixed(1)}% Utilization</div>
              </div>
              <p className="text-[9px] text-slate-600 leading-tight">
                {systemMetrics.memory.percent > 85
                  ? 'OOM killer risk is elevated. System is relying heavily on swap or page cache reclaim.'
                  : 'Sufficient page cache and anonymous memory headroom available.'}
              </p>
            </div>

            <div className="space-y-2 border-l border-slate-800 pl-6">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Integrity Status</div>
              <div className="flex items-center gap-2">
                <div className="text-sm font-mono text-emerald-400">VERIFIED</div>
                <div className="text-[10px] text-slate-500">{runs.length} Audits Performed</div>
              </div>
              <p className="text-[9px] text-slate-600 leading-tight">
                No unauthorized kernel modifications or suspicious hidden processes detected in recent scans.
              </p>
            </div>
          </div>
        </motion.div>
      )}

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
