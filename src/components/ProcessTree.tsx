import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Maximize2, Minimize2, RefreshCw, Info, Activity, X, Terminal, Clock, Shield } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface ProcessNode {
  name: string;
  value?: number;
  children?: ProcessNode[];
  cpu?: number;
  mem?: number;
  pid?: string;
}

interface ProcessTreeProps {
  onSelectProcess?: (process: ProcessNode | null) => void;
  isProbing?: boolean;
  hotPids?: Set<string>;
  historicalData?: ProcessNode | null;
  selectedRunId?: number | null;
  selectedRunMode?: string;
  probeOutput?: string[];
}

export const ProcessTree: React.FC<ProcessTreeProps> = ({ onSelectProcess, isProbing, hotPids, historicalData, selectedRunId, selectedRunMode, probeOutput }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ProcessNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredProcess, setHoveredProcess] = useState<ProcessNode | null>(null);
  const [selectedProcess, setSelectedProcess] = useState<ProcessNode | null>(null);
  const [zoomStack, setZoomStack] = useState<d3.HierarchyRectangularNode<ProcessNode>[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<d3.HierarchyNode<ProcessNode>[]>([]);
  
  const valueCache = useRef<Map<string, number>>(new Map());
  const searchIndex = useRef<Map<string, d3.HierarchyNode<ProcessNode>>>(new Map());
  
  const [selectedProcessLogs, setSelectedProcessLogs] = useState<string[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [runLogs, setRunLogs] = useState<string[]>([]);

  const fetchRunLogs = async (runId: number) => {
    setLoadingLogs(true);
    try {
      const response = await fetch(`/api/db/logs/${runId}`);
      const data = await response.json();
      setRunLogs(data.logs || []);
    } catch (error) {
      console.error('Failed to fetch run logs:', error);
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    if (selectedRunId) {
      fetchRunLogs(selectedRunId);
    }
  }, [selectedRunId]);

  const [showFullLog, setShowFullLog] = useState(false);

  const fetchProcessLogs = async (processName: string, pid?: string) => {
    if (isProbing) return; 
    
    setLoadingLogs(true);
    try {
      const cleanName = processName.replace(/^\[self\]\s+/, '').split(' (')[0].toLowerCase();
      const cleanPid = pid?.replace(/-self$/, '');

      if (runLogs.length > 0) {
        const filtered = runLogs.filter(line => {
          const lowerLine = line.toLowerCase();
          const matchesName = lowerLine.includes(cleanName);
          const matchesPid = cleanPid && lowerLine.includes(cleanPid);
          return matchesName || matchesPid;
        });
        setSelectedProcessLogs(filtered);
        return;
      }

      const url = `/api/process-logs/${encodeURIComponent(cleanName)}${cleanPid ? `?pid=${cleanPid}` : ''}`;
      const response = await fetch(url);
      const data = await response.json();
      setSelectedProcessLogs(data.logs || []);
    } catch (error) {
      console.error('Failed to fetch process logs:', error);
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    if (selectedProcess) {
      const name = selectedProcess.name;
      const pid = (selectedProcess as any).pid;
      fetchProcessLogs(name, pid);
    }
  }, [selectedProcess, runLogs, isProbing]);

  // Live log filtering
  useEffect(() => {
    if (isProbing && selectedProcess && probeOutput && probeOutput.length > 0) {
      const processName = selectedProcess.name.replace(/^\[self\]\s+/, '').split(' (')[0].toLowerCase();
      const pid = (selectedProcess as any).pid?.replace(/-self$/, '');
      
      // Hardened Regex: Matches boundary PID or common formats like pid=123, pid: 123
      const pidRegex = pid ? new RegExp(`(\\b${pid}\\b|pid[=:]\\s*${pid})`, 'i') : null;

      // When selectedProcess changes, we might want to scan the entire history
      // But for performance, we usually just append new lines.
      // To fix "no traces" on selection, we scan the whole probeOutput once.
      
      const filterLines = (chunks: string[]) => {
        const allLines = chunks.flatMap(chunk => chunk.split('\n'));
        return allLines.filter(line => {
          if (!line.trim()) return false;
          const lowerLine = line.toLowerCase();
          const matchesName = lowerLine.includes(processName);
          const matchesPid = pidRegex ? pidRegex.test(line) : false;
          return matchesName || matchesPid;
        });
      };

      // If this is the first time we're filtering for this process, scan everything
      setSelectedProcessLogs(filterLines(probeOutput).slice(-100));
    } else if (!selectedProcess) {
      setSelectedProcessLogs([]);
    }
  }, [probeOutput, isProbing, selectedProcess]);

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch('/api/process-tree');
      const json = await response.json();
      
      // Compliance FIX: Metric Smoothing
      const smooth = (node: ProcessNode) => {
        const key = node.pid || node.name;
        const prevValue = valueCache.current.get(key) || node.value || 0.1;
        const newValue = node.value || 0.1;
        const smoothedValue = (prevValue * 0.7) + (newValue * 0.3);
        node.value = Math.max(0.1, smoothedValue);
        valueCache.current.set(key, node.value);
        if (node.children) node.children.forEach(smooth);
      };
      smooth(json);
      
      setData(json);
      
      // Compliance FIX: Global Search Index
      const root = d3.hierarchy(json);
      const index = new Map();
      root.descendants().forEach(d => {
        if (d.data.pid) index.set(d.data.pid.toString(), d);
        index.set(d.data.name.toLowerCase(), d);
      });
      searchIndex.current = index;
    } catch (error) {
      console.error('Failed to fetch process tree:', error);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (historicalData) {
      setData(historicalData);
      setLoading(false);
      
      // Index historical data too
      const root = d3.hierarchy(historicalData);
      const index = new Map();
      root.descendants().forEach(d => {
        if (d.data.pid) index.set(d.data.pid.toString(), d);
        index.set(d.data.name.toLowerCase(), d);
      });
      searchIndex.current = index;
    } else {
      fetchData();
    }
  }, [historicalData]);

  useEffect(() => {
    if (isProbing && !historicalData) {
      const interval = setInterval(() => fetchData(true), 10000);
      return () => clearInterval(interval);
    }
  }, [isProbing, historicalData]);

  useEffect(() => {
    if (!data || !svgRef.current || !containerRef.current) return;

    // Data-level LOD: Prune tiny nodes before layout to save compute
    const pruneTree = (node: ProcessNode, isRoot = false): ProcessNode | null => {
      // If it's a leaf, check value
      if (!node.children || node.children.length === 0) {
        return (isRoot || (node.value || 0) > 0.05) ? node : null;
      }
      
      // If it's a parent, prune children first
      const prunedChildren = node.children
        .map(c => pruneTree(c, false))
        .filter((child): child is ProcessNode => child !== null);
        
      // Keep if it's the root, has children, or is a leaf with enough value
      if (isRoot || prunedChildren.length > 0) {
        return { ...node, children: prunedChildren };
      }
      
      return (node.value || 0) > 0.05 ? { ...node, children: [] } : null;
    };

    const processedData = pruneTree(data, true);
    if (!processedData) return;

    if (processedData.children?.length === 0) {
      console.warn("[FORENSIC:VISUAL] Process tree has no children after pruning.", processedData);
    }

    const updateTreemap = () => {
      try {
        if (!containerRef.current || !svgRef.current) return;
        const width = containerRef.current.clientWidth;
        const height = 500;
        
        if (width === 0) {
          console.warn("[FORENSIC:VISUAL] Container width is 0, skipping render.");
          return;
        }

        const svg = d3.select(svgRef.current);

        const root = d3.hierarchy(processedData)
          .sum(d => Math.max(0.1, d.value || 0))
          .sort((a, b) => (b.value || 0) - (a.value || 0));

        const treemap = d3.treemap<ProcessNode>()
          .size([width, height])
          .paddingOuter(4)
          .paddingTop(22)
          .paddingInner(2)
          .round(true);

        treemap(root);

        // Re-index on every render to ensure nodes match current hierarchy
        const index = new Map();
        root.descendants().forEach(d => {
          if (d.data.pid) index.set(d.data.pid.toString(), d);
          index.set(d.data.name.toLowerCase(), d);
        });
        searchIndex.current = index;

        const color = d3.scaleThreshold<number, string>()
          .domain([1, 5, 10, 25, 50])
          .range(['#1e293b', '#334155', '#475569', '#3b82f6', '#8b5cf6', '#ef4444']);

        // Manage gradients
        let defs = svg.select('defs');
        if (defs.empty()) defs = svg.append('defs');
        
        const gradientData = root.descendants().filter(d => {
          const dx = (d as any).x1 - (d as any).x0;
          const dy = (d as any).y1 - (d as any).y0;
          return dx > 0.5 && dy > 0.5;
        });
        const gradients = defs.selectAll('linearGradient')
          .data(gradientData, (d: any) => d.data.pid || d.data.name);

        gradients.exit().remove();

        const gradientsEnter = gradients.enter().append('linearGradient')
          .attr('id', (d, i) => `gradient-${d.data.pid || i}`)
          .attr('x1', '0%')
          .attr('y1', '0%')
          .attr('x2', '100%')
          .attr('y2', '100%');

        gradientsEnter.append('stop').attr('offset', '0%').attr('stop-opacity', 0.9);
        gradientsEnter.append('stop').attr('offset', '100%').attr('stop-opacity', 1);

        gradients.merge(gradientsEnter as any).each(function(d) {
          const cpu = d.data.cpu || 0;
          const isParent = d.children && d.children.length > 0;
          const baseColor = isParent ? '#0f172a' : color(cpu);
          const g = d3.select(this);
          g.select('stop:first-child').attr('stop-color', baseColor);
          g.select('stop:last-child').attr('stop-color', d3.color(baseColor)?.darker(1.5).toString() || baseColor);
        });

        // Manage cells
        const cellData = root.descendants().filter(d => {
          const dx = (d as any).x1 - (d as any).x0;
          const dy = (d as any).y1 - (d as any).y0;
          return dx > 0.5 && dy > 0.5;
        }) as d3.HierarchyRectangularNode<ProcessNode>[];
        const cells = svg.selectAll<SVGGElement, d3.HierarchyRectangularNode<ProcessNode>>('g.process-node-group')
          .data(cellData, (d: any) => d.data.pid || d.data.name);

        cells.exit().remove();

        const cellsEnter = cells.enter().append('g')
          .attr('class', 'process-node-group cursor-pointer')
          .on('mouseenter', (event, d) => {
            setHoveredProcess(d.data);
          })
          .on('mouseleave', () => {
            setHoveredProcess(null);
          })
          .on('click', (event, d) => {
            event.stopPropagation();
            if (onSelectProcess) onSelectProcess(d.data);
            setSelectedProcess(d.data);
            if (d.children) {
              setZoomStack(prev => [...prev, d as d3.HierarchyRectangularNode<ProcessNode>]);
              zoom(d as d3.HierarchyRectangularNode<ProcessNode>);
            }
          });

        cellsEnter.append('rect')
          .attr('id', d => `rect-${d.data.name.replace(/[^\w]/g, '-')}`)
          .style('transition', 'fill 0.3s, stroke 0.3s');

        cellsEnter.append('text')
          .attr('class', 'pointer-events-none fill-white/90 text-[10px] font-mono font-bold');

        const cellsMerged = cells.merge(cellsEnter as any);

        cellsMerged.transition().duration(500)
          .attr('transform', d => `translate(${d.x0},${d.y0})`);

        cellsMerged.select('rect')
          .attr('width', d => d.x1 - d.x0)
          .attr('height', d => d.y1 - d.y0)
          .attr('fill', (d, i) => `url(#gradient-${d.data.pid || i})`)
          .attr('stroke', d => (d.children && d.children.length > 0) ? '#334155' : '#0f172a')
          .attr('stroke-width', 1);

        cellsMerged.select('text')
          .attr('opacity', d => (d.x1 - d.x0 > 60 && d.y1 - d.y0 > 25) ? 1 : 0)
          .each(function(d) {
            const t = d3.select(this);
            const name = d.data.name.split(' (')[0];
            const cpu = d.data.cpu ? `${d.data.cpu}%` : '';
            const lines = [name, cpu];
            
            const tspans = t.selectAll('tspan').data(lines);
            tspans.exit().remove();
            tspans.enter().append('tspan')
              .attr('x', 8)
              .merge(tspans as any)
              .attr('y', (d, i) => 18 + i * 12)
              .text(d => String(d));
          });

        function zoom(d: d3.HierarchyRectangularNode<ProcessNode>, duration = 750) {
          const kx = width / (d.x1 - d.x0);
          const ky = height / (d.y1 - d.y0);
          const x = d.x0;
          const y = d.y0;

          const t = svg.transition().duration(duration).ease(d3.easeCubicInOut);

          svg.selectAll('g.process-node-group').transition(t)
            .attr('transform', (node: any) => `translate(${(node.x0 - x) * kx},${(node.y0 - y) * ky})`);

          svg.selectAll('rect').transition(t)
            .attr('width', (node: any) => (node.x1 - node.x0) * kx)
            .attr('height', (node: any) => (node.y1 - node.y0) * ky);

          svg.selectAll('text').transition(t)
            .attr('opacity', (node: any) => {
              const w = (node.x1 - node.x0) * kx;
              const h = (node.y1 - node.y0) * ky;
              const isVisible = node.x0 >= d.x0 && node.x1 <= d.x1 && node.y0 >= d.y0 && node.y1 <= d.y1;
              return (isVisible && w > 60 && h > 25) ? 1 : 0;
            });
        }

        // If we were zoomed in, re-apply zoom immediately without transition
        if (zoomStack.length > 0) {
          const lastZoom = zoomStack[zoomStack.length - 1];
          const targetNode = root.descendants().find(n => n.data.name === lastZoom.data.name);
          if (targetNode) {
            zoom(targetNode as d3.HierarchyRectangularNode<ProcessNode>, 0);
          }
        }

        (window as any).resetTreemapZoom = () => {
          setZoomStack([]);
          const t = svg.transition().duration(750).ease(d3.easeCubicInOut);
          svg.selectAll('g.process-node-group').transition(t).attr('transform', d => `translate(${(d as any).x0},${(d as any).y0})`);
          svg.selectAll('rect').transition(t).attr('width', d => (d as any).x1 - (d as any).x0).attr('height', d => (d as any).y1 - (d as any).y0);
          svg.selectAll('text').transition(t).attr('opacity', d => ((d as any).x1 - (d as any).x0 > 60 && (d as any).y1 - (d as any).y0 > 25) ? 1 : 0);
        };
      } catch (err) {
        console.error("[FORENSIC:RENDER_ERROR]", err);
      }
    };

    updateTreemap();

    let timeout: NodeJS.Timeout;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(() => updateTreemap(), 200);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      clearTimeout(timeout);
    };
  }, [data]);

  // Separate effect for hotPids to avoid layout jittering
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    
    svg.selectAll<SVGGElement, d3.HierarchyRectangularNode<ProcessNode>>('g.process-node-group')
      .select('rect')
      .attr('stroke', d => {
        if (hotPids?.has(d.data.pid || '')) return '#ef4444';
        return d.children ? '#334155' : '#0f172a';
      })
      .attr('stroke-width', d => hotPids?.has(d.data.pid || '') ? 3 : 1)
      .attr('class', d => {
        let classes = 'transition-all duration-300 hover:brightness-125';
        if (hotPids?.has(d.data.pid || '')) classes += ' animate-pulse-fast shadow-[0_0_15px_rgba(239,68,68,0.5)]';
        if ((d.data as any).isSelf) classes += ' opacity-80';
        return classes;
      });
  }, [hotPids]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (!query.trim() || !data) {
      setSearchResults([]);
      return;
    }

    // Compliance FIX: Search using global index
    const results: d3.HierarchyNode<ProcessNode>[] = [];
    const lowerQuery = query.toLowerCase();
    
    searchIndex.current.forEach((node, key) => {
      if (key.includes(lowerQuery) && !results.includes(node)) {
        results.push(node);
      }
    });
    
    setSearchResults(results.slice(0, 10));
  };

  const jumpToNode = (node: d3.HierarchyNode<ProcessNode>) => {
    // Compliance FIX: Reconstruct zoom stack to "drill down"
    const ancestors = node.ancestors().reverse();
    const stack = ancestors.slice(1, -1) as d3.HierarchyRectangularNode<ProcessNode>[];
    setZoomStack(stack);
    
    setSearchQuery('');
    setSearchResults([]);
    
    if (onSelectProcess) onSelectProcess(node.data);
    setSelectedProcess(node.data);
  };

  return (
    <div className="technical-panel p-4 relative overflow-hidden" ref={containerRef} id="process-tree-container">
      <div className="flex items-center justify-between mb-4 relative h-8 z-10">
        <div className="flex items-center gap-2">
          <Maximize2 className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
            {historicalData ? 'Historical Process Snapshot' : 'Process Hierarchy Treemap'}
          </h3>
          {isProbing && !historicalData && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[8px] font-bold text-emerald-400 animate-pulse ml-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              LIVE DATA STREAM
            </div>
          )}
          {historicalData && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-[8px] font-bold text-blue-400 ml-2">
              HISTORICAL VIEW
            </div>
          )}
        </div>
        
        <div className="flex items-center gap-2">
          <div className="relative">
            <input
              type="text"
              placeholder="Search PID or Process..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded px-3 py-1 text-xs text-slate-300 focus:outline-none focus:border-emerald-500/50 w-48 transition-all"
            />
            <AnimatePresence>
              {searchResults.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="absolute top-full left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded shadow-2xl z-[100] max-h-64 overflow-y-auto custom-scrollbar"
                >
                  {searchResults.map((result, i) => (
                    <button
                      key={`${result.data.pid}-${i}`}
                      onClick={() => jumpToNode(result)}
                      className="w-full text-left px-3 py-2 hover:bg-slate-800 border-b border-slate-800 last:border-0 flex flex-col gap-0.5"
                    >
                      <div className="text-[10px] font-mono text-emerald-400">PID: {result.data.pid}</div>
                      <div className="text-[10px] text-slate-300 truncate">{result.data.name}</div>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {!historicalData && (
            <button 
              onClick={() => fetchData()} 
              className="p-1.5 hover:bg-slate-800 rounded text-slate-500 hover:text-emerald-400 transition-colors"
              title="Refresh Process Tree"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          )}
          <AnimatePresence>
            {hoveredProcess && (
              <motion.div 
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="hidden md:flex items-center gap-3 px-3 py-1 bg-slate-900/90 border border-emerald-500/20 rounded-lg text-[10px] font-mono shadow-xl shadow-black/50 backdrop-blur-sm absolute right-24 top-0 z-20"
              >
                <span className="text-slate-500 uppercase tracking-widest text-[8px]">Inspecting:</span>
                <span className="text-emerald-400 font-bold truncate max-w-[120px]">{hoveredProcess.name.split(' (')[0]}</span>
                <div className="flex items-center gap-2 border-l border-slate-700 pl-3">
                  <span className="text-blue-400">{hoveredProcess.cpu}%</span>
                  <span className="text-purple-400">{hoveredProcess.mem}%</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => {
                if ((window as any).resetTreemapZoom) {
                  (window as any).resetTreemapZoom();
                }
              }}
              className="p-1.5 hover:bg-slate-800 rounded-md transition-colors text-slate-400 hover:text-emerald-400"
              title="Reset Zoom"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
            <button 
              onClick={() => fetchData()}
              className="p-1.5 hover:bg-slate-800 rounded-md transition-colors text-slate-400 hover:text-emerald-400"
              title="Refresh Data"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>
      
      <div className="relative overflow-hidden rounded bg-slate-950/50 border border-slate-800">
        {loading && !data ? (
          <div className="h-[500px] flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <RefreshCw className="w-8 h-8 text-emerald-500 animate-spin" />
              <span className="text-xs font-mono text-slate-500 uppercase animate-pulse">Scanning Process Tree...</span>
            </div>
          </div>
        ) : (
          <div className="relative h-[500px]">
            <svg 
              ref={svgRef} 
              width="100%" 
              height="500" 
              className="w-full h-full"
              viewBox={`0 0 ${containerRef.current?.clientWidth || 800} 500`}
            />
            
            <AnimatePresence>
              {selectedProcess && (
                <motion.div
                  initial={{ opacity: 0, x: 100 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 100 }}
                  className="absolute top-0 right-0 bottom-0 w-80 bg-slate-900/95 border-l border-slate-800 backdrop-blur-md z-20 shadow-2xl flex flex-col"
                >
                  <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-emerald-500/5">
                    <div className="flex items-center gap-2">
                      <Info className="w-4 h-4 text-emerald-400" />
                      <span className="text-[10px] font-mono text-slate-300 uppercase tracking-widest">Inspector</span>
                    </div>
                    <button 
                      onClick={() => {
                        setSelectedProcess(null);
                        if (onSelectProcess) onSelectProcess(null);
                      }} 
                      className="p-1 hover:bg-slate-800 rounded text-slate-500 hover:text-white transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
                    <div className="p-3 bg-black/40 rounded border border-slate-800">
                      <div className="text-[9px] text-slate-600 uppercase mb-1 font-bold">Command</div>
                      <div className="text-xs font-mono text-emerald-400 break-all leading-relaxed">
                        {selectedProcess.name}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-2 bg-slate-900/50 rounded border border-slate-800">
                        <div className="text-[9px] text-slate-600 uppercase mb-1">CPU</div>
                        <div className="text-sm font-mono text-blue-400 font-bold">{(selectedProcess as any).cpu || 0}%</div>
                      </div>
                      <div className="p-2 bg-slate-900/50 rounded border border-slate-800">
                        <div className="text-[9px] text-slate-600 uppercase mb-1">MEM</div>
                        <div className="text-sm font-mono text-purple-400 font-bold">{(selectedProcess as any).mem || 0}%</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-2 bg-slate-900/50 rounded border border-slate-800">
                        <div className="text-[9px] text-slate-600 uppercase mb-1">State</div>
                        <div className="text-[10px] font-mono text-amber-400">{(selectedProcess as any).stat || 'N/A'}</div>
                      </div>
                      <div className="p-2 bg-slate-900/50 rounded border border-slate-800">
                        <div className="text-[9px] text-slate-600 uppercase mb-1">PPID</div>
                        <div className="text-[10px] font-mono text-slate-400">{(selectedProcess as any).ppid || 'N/A'}</div>
                      </div>
                    </div>

                    <div className="p-2 bg-slate-900/50 rounded border border-slate-800">
                      <div className="text-[9px] text-slate-600 uppercase mb-1">Start Time</div>
                      <div className="text-[10px] font-mono text-slate-400">{(selectedProcess as any).startTime || 'N/A'}</div>
                    </div>

                    <div className="flex-1 flex flex-col min-h-0">
                      <div className="text-[9px] text-slate-600 uppercase mb-2 flex items-center justify-between">
                        <span className="flex items-center gap-1">
                          <Terminal className="w-2.5 h-2.5" />
                          {showFullLog ? 'Full Audit Log' : 'Forensic Trace'}
                        </span>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => setShowFullLog(!showFullLog)}
                            className={`px-1.5 py-0.5 rounded text-[8px] border transition-colors ${showFullLog ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'}`}
                          >
                            {showFullLog ? 'Show Filtered' : 'Show Full'}
                          </button>
                          {loadingLogs && <RefreshCw className="w-2.5 h-2.5 animate-spin text-emerald-500" />}
                        </div>
                      </div>
                      <div className="flex-1 bg-black/60 rounded border border-slate-800/50 p-2 overflow-y-auto custom-scrollbar font-mono text-[9px] leading-tight min-h-[200px]">
                        {showFullLog ? (
                          (isProbing ? probeOutput.flatMap(c => c.split('\n')) : runLogs).map((log, i) => (
                            <div key={i} className="mb-1 text-slate-500 hover:text-slate-300 transition-colors">
                              {log}
                            </div>
                          ))
                        ) : selectedProcessLogs.length > 0 ? (
                          selectedProcessLogs.map((log, i) => (
                            <div key={i} className="mb-1.5 border-l-2 border-slate-800 pl-2 py-1 text-slate-400">
                              {log}
                            </div>
                          ))
                        ) : (
                          <div className="text-slate-700 italic flex flex-col items-center justify-center h-full gap-2 py-10 px-4 text-center">
                            <Activity className="w-4 h-4 opacity-10" />
                            <span className="text-[8px] uppercase tracking-widest">No traces recorded</span>
                            {selectedRunMode === 'MODULE:DEPS' && (
                              <p className="text-[8px] text-slate-500 mt-2 normal-case leading-relaxed">
                                Run mode <span className="text-emerald-500">DEPS</span> only verifies tool availability. 
                                Switch to <span className="text-blue-500">Standard</span> or <span className="text-purple-500">Advanced</span> mode to capture process traces.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
      
      <div className="mt-3 flex items-center gap-4 text-[10px] font-mono text-slate-500">
        <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar whitespace-nowrap max-w-[50%]">
          <span className="text-slate-600">PATH:</span>
          <span className="text-emerald-500/50 cursor-pointer hover:text-emerald-400" onClick={() => (window as any).resetTreemapZoom?.()}>root</span>
          {zoomStack.map((node, i) => (
            <React.Fragment key={i}>
              <span className="text-slate-800">/</span>
              <span className="text-emerald-500/50 cursor-pointer hover:text-emerald-400" onClick={() => {
                const newStack = zoomStack.slice(0, i + 1);
                setZoomStack(newStack);
                if ((window as any).zoomTreemapToNode) {
                  (window as any).zoomTreemapToNode(node.data.name);
                }
              }}>
                {node.data.name.split(' (')[0]}
              </span>
            </React.Fragment>
          ))}
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          <div className="w-2 h-2 rounded-full bg-slate-700" />
          <span>Idle</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <span>Active</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-red-500" />
          <span>Hot</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Minimize2 className="w-3 h-3" />
          <span>Click to Zoom / Select</span>
        </div>
      </div>
    </div>
  );
};
