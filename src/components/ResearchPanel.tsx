// PATH: src/components/ResearchPanel.tsx
//
// WHAT: Displays research results from the research_results SQLite table.
//       Each result is a finding from the probe (e.g. "firefox 121% CPU")
//       paired with documentation sources and remediation steps found by
//       research_engine.py via Firefox/Google search.
//
// WHY:  The probe captures raw signals. This panel closes the loop by showing
//       the official documentation, known bugs, and verified fixes for those
//       exact conditions — without the user having to Google anything.
//
// DATA FLOW:
//   1. Probe run completes → STORM/RANKED_ALERT lines in DB
//   2. User clicks "Research" button → POST /api/research triggers research_engine.py
//   3. research_engine.py searches Google, writes to research_results table
//   4. This panel polls /api/db/research/:runId and renders results

import React, { useState, useEffect, useRef } from 'react';
import { Search, ExternalLink, BookOpen, AlertTriangle, CheckCircle, RefreshCw, X, Terminal } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface ResearchResult {
  id: number;
  finding: string;
  query: string;
  source_url: string;
  source_title: string;
  excerpt: string;
  remediation: string;
  rank: number;
  searched_at: string;
}

interface ResearchPanelProps {
  runId: number | null;
  runMode?: string;
}

// Color-code a source URL by domain authority
function sourceBadge(url: string): { label: string; color: string } {
  if (url.includes('bugzilla.mozilla.org'))  return { label: 'Mozilla Bug', color: 'bg-orange-900/60 text-orange-300' };
  if (url.includes('kernel.org'))            return { label: 'kernel.org',  color: 'bg-blue-900/60 text-blue-300' };
  if (url.includes('access.redhat.com'))     return { label: 'Red Hat KCS', color: 'bg-red-900/60 text-red-300' };
  if (url.includes('docs.redhat.com'))       return { label: 'Red Hat Docs',color: 'bg-red-900/40 text-red-200' };
  if (url.includes('wiki.archlinux.org'))    return { label: 'Arch Wiki',   color: 'bg-slate-700/60 text-slate-300' };
  if (url.includes('man7.org'))              return { label: 'man page',    color: 'bg-violet-900/60 text-violet-300' };
  if (url.includes('fedoraproject.org'))     return { label: 'Fedora',      color: 'bg-blue-900/40 text-blue-200' };
  if (url.includes('unix.stackexchange'))    return { label: 'Unix SE',     color: 'bg-emerald-900/60 text-emerald-300' };
  if (url.includes('askubuntu.com'))         return { label: 'Ask Ubuntu',  color: 'bg-amber-900/60 text-amber-300' };
  return { label: new URL(url).hostname,     color: 'bg-slate-800 text-slate-400' };
}

export const ResearchPanel: React.FC<ResearchPanelProps> = ({ runId, runMode }) => {
  const [results, setResults] = useState<ResearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [researching, setResearching] = useState(false);
  const [researchLog, setResearchLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll research log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [researchLog]);

  const fetchResults = async () => {
    if (!runId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/db/research/${runId}`);
      const data = await res.json();
      setResults(data || []);
    } catch (e) {
      console.error('Failed to fetch research results', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchResults();
  }, [runId]);

  const startResearch = async () => {
    if (!runId) return;
    setResearching(true);
    setResearchLog([]);
    setShowLog(true);
    setError(null);

    try {
      // SSE stream from /api/research — research_engine.py output
      const res = await fetch(`/api/research?runId=${runId}`);
      const reader = res.body?.getReader();
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
                setResearchLog(prev => [...prev, json.text].slice(-200));
              } catch {}
            }
          }
        }
      }

      // Refresh results after research completes
      await fetchResults();
    } catch (e: any) {
      setError(`Research failed: ${e.message}`);
    } finally {
      setResearching(false);
    }
  };

  // Group results by finding
  const byFinding: Record<string, ResearchResult[]> = {};
  for (const r of results) {
    const key = r.finding.slice(0, 80);
    if (!byFinding[key]) byFinding[key] = [];
    byFinding[key].push(r);
  }

  const isDepsModeRun = runMode?.includes('DEPS');

  return (
    <div className="technical-panel p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-violet-400" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Research Panel</h3>
          {results.length > 0 && (
            <span className="text-[9px] font-mono bg-violet-900/40 text-violet-300 px-1.5 py-0.5 rounded">
              {results.length} sources
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {results.length > 0 && (
            <button
              onClick={fetchResults}
              disabled={loading}
              className="p-1 text-slate-600 hover:text-slate-300 transition-colors"
              title="Refresh results"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          )}
          <button
            onClick={startResearch}
            disabled={researching || !runId || isDepsModeRun}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-mono font-bold border transition-all ${
              researching
                ? 'bg-violet-900/40 border-violet-700/50 text-violet-300 cursor-wait'
                : isDepsModeRun
                ? 'opacity-30 cursor-not-allowed border-slate-800 text-slate-600'
                : 'bg-violet-500/10 border-violet-500/40 text-violet-400 hover:bg-violet-500/20'
            }`}
            title={isDepsModeRun ? 'DEPS mode runs have no findings to research. Run Standard first.' : 'Search documentation for fixes'}
          >
            {researching ? (
              <><RefreshCw className="w-3 h-3 animate-spin" />Searching...</>
            ) : (
              <><Search className="w-3 h-3" />Research Fixes</>
            )}
          </button>
        </div>
      </div>

      {/* Context */}
      {!runId && (
        <p className="text-[10px] text-slate-600 font-mono">Select a run from Audit History to research its findings.</p>
      )}
      {isDepsModeRun && (
        <p className="text-[10px] text-amber-600 font-mono">DEPS runs have no forensic findings. Select a Standard or Advanced run.</p>
      )}

      {/* Research log stream */}
      <AnimatePresence>
        {showLog && researchLog.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="relative rounded border border-violet-900/50 bg-black/80">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-violet-900/30">
                <div className="flex items-center gap-1.5">
                  <Terminal className="w-3 h-3 text-violet-400" />
                  <span className="text-[9px] font-mono text-violet-400 uppercase tracking-widest">Research Log</span>
                  {researching && <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />}
                </div>
                <button onClick={() => setShowLog(false)} className="text-slate-700 hover:text-slate-400">
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div ref={logRef} className="h-36 overflow-y-auto p-2 font-mono text-[9px] text-violet-300/80 leading-relaxed custom-scrollbar">
                {researchLog.map((line, i) => (
                  <div key={i} className={
                    line.includes('[RESEARCH:RESULT]') ? 'text-emerald-400' :
                    line.includes('[RESEARCH:ERROR]') ? 'text-red-400' :
                    line.includes('[RESEARCH:QUERY]') ? 'text-violet-300 font-bold' :
                    line.includes('[RESEARCH:FETCH]') ? 'text-blue-400' :
                    line.includes('[RESEARCH:SAVED]') ? 'text-emerald-300' :
                    'text-slate-500'
                  }>{line}</div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error */}
      {error && (
        <div className="p-3 rounded border border-red-900/50 bg-red-900/10 text-[10px] font-mono text-red-400">
          {error}
        </div>
      )}

      {/* Results — grouped by finding */}
      {Object.keys(byFinding).length > 0 ? (
        <div className="space-y-4">
          {Object.entries(byFinding).map(([finding, items]) => (
            <div key={finding} className="space-y-2">
              {/* Finding label */}
              <div className="flex items-start gap-2 px-2 py-1.5 rounded bg-slate-900/60 border border-slate-800">
                <AlertTriangle className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                <p className="text-[9px] font-mono text-amber-300/80 leading-relaxed break-all">{finding}</p>
              </div>

              {/* Sources for this finding */}
              {items.sort((a, b) => a.rank - b.rank).map(result => {
                const badge = sourceBadge(result.source_url);
                const isExpanded = expandedId === result.id;
                return (
                  <div key={result.id} className="ml-3 border border-slate-800/60 rounded overflow-hidden">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : result.id)}
                      className="w-full text-left px-3 py-2 hover:bg-slate-800/40 transition-colors"
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-[8px] font-mono text-slate-600 mt-0.5 shrink-0">#{result.rank}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded ${badge.color}`}>
                              {badge.label}
                            </span>
                            <span className="text-[10px] font-medium text-slate-300 truncate">
                              {result.source_title}
                            </span>
                          </div>
                          <p className="text-[9px] text-slate-500 line-clamp-2 leading-relaxed">
                            {result.excerpt}
                          </p>
                        </div>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-slate-800/60 p-3 space-y-3 bg-slate-950/40">
                        {/* Excerpt */}
                        {result.excerpt && (
                          <div>
                            <p className="text-[9px] text-slate-600 uppercase mb-1 font-bold">Excerpt</p>
                            <p className="text-[10px] text-slate-400 leading-relaxed">{result.excerpt}</p>
                          </div>
                        )}

                        {/* Remediation steps */}
                        {result.remediation && (
                          <div>
                            <div className="flex items-center gap-1.5 mb-2">
                              <CheckCircle className="w-3 h-3 text-emerald-500" />
                              <p className="text-[9px] text-emerald-400 uppercase font-bold">Remediation steps</p>
                            </div>
                            <pre className="text-[9px] font-mono text-emerald-300/80 leading-relaxed whitespace-pre-wrap bg-black/40 rounded p-2 border border-emerald-900/30">
                              {result.remediation}
                            </pre>
                          </div>
                        )}

                        {/* Source link */}
                        <div className="flex items-center gap-2">
                          <a
                            href={result.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 text-[9px] font-mono text-blue-400 hover:text-blue-300 transition-colors"
                          >
                            <ExternalLink className="w-3 h-3" />
                            {result.source_url.slice(0, 70)}
                          </a>
                        </div>

                        {/* Search query used */}
                        <p className="text-[8px] text-slate-700 font-mono">
                          Query: {result.query}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : !researching && runId && !isDepsModeRun && (
        <div className="text-center py-8 flex flex-col items-center gap-3">
          <Search className="w-8 h-8 text-violet-500/20" />
          <div className="text-[10px] font-mono text-slate-600 uppercase tracking-widest">
            No research results yet
          </div>
          <p className="text-[9px] text-slate-700 max-w-[200px] text-center leading-relaxed">
            Click "Research Fixes" to search official docs for solutions to this run's findings
          </p>
        </div>
      )}
    </div>
  );
};
