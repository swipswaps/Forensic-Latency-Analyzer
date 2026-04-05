import React, { useState, useEffect } from 'react';
import { Activity, Terminal, FileText, Shield, Play, Loader2, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export default function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string>('');
  const [advancedMode, setAdvancedMode] = useState(false);
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [lastProbeOutput, setLastProbeOutput] = useState('');

  useEffect(() => {
    fetchLogs();
  }, []);

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      const data = await res.json();
      setLogs(data);
    } catch (err) {
      console.error('Failed to fetch logs', err);
    }
  };

  const runProbe = async () => {
    setIsRunning(true);
    setStatus('running');
    setLastProbeOutput('');
    try {
      const res = await fetch('/api/run-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ advanced: advancedMode }),
      });
      const data = await res.json();
      setLastProbeOutput(data.output);
      if (data.code === 0) {
        setStatus('success');
      } else {
        setStatus('error');
      }
      fetchLogs();
    } catch (err) {
      setStatus('error');
      console.error('Failed to run probe', err);
    } finally {
      setIsRunning(false);
    }
  };

  const viewLog = async (name: string) => {
    setSelectedLog(name);
    try {
      const res = await fetch(`/api/log/${name}`);
      const text = await res.text();
      setLogContent(text);
    } catch (err) {
      console.error('Failed to fetch log content', err);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600 rounded-lg shadow-lg shadow-blue-900/20">
              <Activity className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-xl tracking-tight">Forensic Latency Analyzer</h1>
              <p className="text-xs text-slate-500 font-mono">v5.0.0-compliant</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-full border border-slate-700">
              <div className={`w-2 h-2 rounded-full ${status === 'idle' ? 'bg-slate-500' : status === 'running' ? 'bg-yellow-500 animate-pulse' : status === 'success' ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs font-medium capitalize">{status}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Controls Panel */}
        <div className="lg:col-span-4 space-y-6">
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-6 flex items-center gap-2">
              <Shield className="w-4 h-4" />
              Probe Controls
            </h2>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                <div>
                  <p className="text-sm font-medium">Advanced Mode</p>
                  <p className="text-xs text-slate-500">Enables blktrace & ftrace</p>
                </div>
                <button 
                  onClick={() => setAdvancedMode(!advancedMode)}
                  className={`w-12 h-6 rounded-full transition-colors relative ${advancedMode ? 'bg-blue-600' : 'bg-slate-700'}`}
                >
                  <motion.div 
                    animate={{ x: advancedMode ? 26 : 4 }}
                    className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm"
                  />
                </button>
              </div>

              <button
                onClick={runProbe}
                disabled={isRunning}
                className="w-full py-4 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 rounded-xl font-bold flex items-center justify-center gap-3 transition-all active:scale-[0.98] shadow-lg shadow-blue-900/20"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Executing Forensic Probe...
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5" />
                    Start Latency Probe
                  </>
                )}
              </button>
            </div>

            {status !== 'idle' && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`mt-6 p-4 rounded-lg border flex items-start gap-3 ${status === 'success' ? 'bg-green-500/10 border-green-500/20 text-green-400' : status === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400'}`}
              >
                {status === 'success' ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : status === 'error' ? <AlertCircle className="w-5 h-5 shrink-0" /> : <Loader2 className="w-5 h-5 shrink-0 animate-spin" />}
                <div>
                  <p className="text-sm font-semibold">
                    {status === 'success' ? 'Probe Completed Successfully' : status === 'error' ? 'Probe Execution Failed' : 'Probe in Progress'}
                  </p>
                  <p className="text-xs opacity-80 mt-1">
                    {status === 'success' ? 'System signals captured and analyzed.' : status === 'error' ? 'Check terminal logs for stack trace.' : 'Collecting PSI, scheduler, and process metrics...'}
                  </p>
                </div>
              </motion.div>
            )}
          </section>

          <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Recent Logs
            </h2>
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
              {logs.map((log) => (
                <button
                  key={log}
                  onClick={() => viewLog(log)}
                  className={`w-full text-left p-3 rounded-lg text-xs font-mono transition-colors border ${selectedLog === log ? 'bg-blue-600/10 border-blue-600/50 text-blue-400' : 'bg-slate-800/50 border-slate-700 hover:bg-slate-800 text-slate-400'}`}
                >
                  {log}
                </button>
              ))}
              {logs.length === 0 && <p className="text-xs text-slate-600 text-center py-8 italic">No logs generated yet.</p>}
            </div>
          </section>
        </div>

        {/* Output Panel */}
        <div className="lg:col-span-8 space-y-6">
          <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl flex flex-col h-[800px]">
            <div className="px-6 py-4 border-b border-slate-800 bg-slate-900/80 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Terminal className="w-5 h-5 text-blue-500" />
                <h2 className="text-sm font-semibold tracking-wide">
                  {selectedLog ? `Log: ${selectedLog}` : 'Live Output'}
                </h2>
              </div>
              {selectedLog && (
                <button 
                  onClick={() => { setSelectedLog(null); setLogContent(''); }}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Clear View
                </button>
              )}
            </div>
            
            <div className="flex-1 overflow-auto p-6 bg-black/40 font-mono text-sm leading-relaxed custom-scrollbar">
              <AnimatePresence mode="wait">
                {selectedLog ? (
                  <motion.pre 
                    key="log-content"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="whitespace-pre-wrap text-blue-100/90"
                  >
                    {logContent}
                  </motion.pre>
                ) : isRunning ? (
                  <motion.div 
                    key="running-output"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="space-y-1"
                  >
                    <p className="text-blue-400 animate-pulse">Initializing forensic environment...</p>
                    <p className="text-slate-500">Checking dependencies...</p>
                  </motion.div>
                ) : lastProbeOutput ? (
                  <motion.pre 
                    key="last-output"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="whitespace-pre-wrap text-slate-300"
                  >
                    {lastProbeOutput}
                  </motion.pre>
                ) : (
                  <div key="empty" className="h-full flex flex-col items-center justify-center text-slate-600 space-y-4">
                    <FileText className="w-12 h-12 opacity-20" />
                    <p className="text-sm italic">Select a log or start a new probe to view forensic data.</p>
                  </div>
                )}
              </AnimatePresence>
            </div>
          </section>
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
