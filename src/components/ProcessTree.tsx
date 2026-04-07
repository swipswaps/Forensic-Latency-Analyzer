import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import { motion } from 'motion/react';

interface ProcessNode {
  name: string;
  value?: number;
  children?: ProcessNode[];
  cpu?: number;
  mem?: number;
  pid?: string;
}

interface ProcessTreeProps {
  onSelectProcess?: (process: ProcessNode) => void;
  isProbing?: boolean;
  hotPids?: Set<string>;
}

export const ProcessTree: React.FC<ProcessTreeProps> = ({ onSelectProcess, isProbing, hotPids }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ProcessNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredProcess, setHoveredProcess] = useState<ProcessNode | null>(null);
  const [zoomStack, setZoomStack] = useState<d3.HierarchyRectangularNode<ProcessNode>[]>([]);

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch('/api/process-tree');
      const json = await response.json();
      setData(json);
    } catch (error) {
      console.error('Failed to fetch process tree:', error);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (isProbing) {
      const interval = setInterval(() => fetchData(true), 10000);
      return () => clearInterval(interval);
    }
  }, [isProbing]);

  useEffect(() => {
    if (!data || !svgRef.current || !containerRef.current) return;

    const updateTreemap = (isResize = false) => {
      if (!containerRef.current || !svgRef.current) return;
      const width = containerRef.current.clientWidth;
      const height = 500;

      const svg = d3.select(svgRef.current);
      
      // If it's just a resize and we have a zoom stack, we might want to preserve the zoom
      // But for simplicity, we'll rebuild and re-apply zoom if needed
      svg.selectAll('*').remove();

      const root = d3.hierarchy(data)
        .sum(d => d.value || 0.1)
        .sort((a, b) => (b.value || 0) - (a.value || 0));

      const treemap = d3.treemap<ProcessNode>()
        .size([width, height])
        .paddingOuter(4)
        .paddingTop(22)
        .paddingInner(2)
        .round(true);

      treemap(root);

      const color = d3.scaleThreshold<number, string>()
        .domain([1, 5, 10, 25, 50])
        .range(['#1e293b', '#334155', '#475569', '#3b82f6', '#8b5cf6', '#ef4444']);

      // Add gradients
      const defs = svg.append('defs');
      
      root.descendants().forEach((d, i) => {
        const gradientId = `gradient-${i}`;
        const cpu = d.data.cpu || 0;
        const baseColor = d.children ? '#0f172a' : color(cpu);
        
        const gradient = defs.append('linearGradient')
          .attr('id', gradientId)
          .attr('x1', '0%')
          .attr('y1', '0%')
          .attr('x2', '100%')
          .attr('y2', '100%');

        gradient.append('stop')
          .attr('offset', '0%')
          .attr('stop-color', baseColor)
          .attr('stop-opacity', 0.9);

        gradient.append('stop')
          .attr('offset', '100%')
          .attr('stop-color', d3.color(baseColor)?.darker(1.5).toString() || baseColor)
          .attr('stop-opacity', 1);
      });

      const cell = svg.selectAll<SVGGElement, d3.HierarchyRectangularNode<ProcessNode>>('g')
        .data(root.descendants() as d3.HierarchyRectangularNode<ProcessNode>[])
        .enter().append('g')
        .attr('transform', d => `translate(${d.x0},${d.y0})`)
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
          if (d.children) {
            setZoomStack(prev => [...prev, d as d3.HierarchyRectangularNode<ProcessNode>]);
            zoom(d as d3.HierarchyRectangularNode<ProcessNode>);
          }
        });

      cell.append('rect')
        .attr('id', d => `rect-${d.data.name.replace(/[^\w]/g, '-')}`)
        .attr('width', d => d.x1 - d.x0)
        .attr('height', d => d.y1 - d.y0)
        .attr('fill', (d, i) => `url(#gradient-${i})`)
        .attr('stroke', d => {
          if (hotPids?.has(d.data.pid || '')) return '#ef4444';
          return d.children ? '#334155' : '#0f172a';
        })
        .attr('stroke-width', d => hotPids?.has(d.data.pid || '') ? 3 : 1)
        .attr('class', d => {
          let classes = 'transition-all duration-300 hover:brightness-125';
          if (hotPids?.has(d.data.pid || '')) classes += ' animate-pulse';
          return classes;
        })
        .style('transition', 'fill 0.3s, stroke 0.3s');

      cell.append('text')
        .attr('class', 'pointer-events-none fill-white/90 text-[10px] font-mono font-bold')
        .attr('opacity', d => (d.x1 - d.x0 > 60 && d.y1 - d.y0 > 25) ? 1 : 0)
        .selectAll('tspan')
        .data(d => {
          const name = d.data.name.split(' (')[0];
          const cpu = d.data.cpu ? `${d.data.cpu}%` : '';
          return [name, cpu];
        })
        .enter().append('tspan')
        .attr('x', 8)
        .attr('y', (d, i) => 18 + i * 12)
        .text(d => String(d));

      function zoom(d: d3.HierarchyRectangularNode<ProcessNode>, duration = 750) {
        const kx = width / (d.x1 - d.x0);
        const ky = height / (d.y1 - d.y0);
        const x = d.x0;
        const y = d.y0;

        const t = svg.transition().duration(duration).ease(d3.easeCubicInOut);

        svg.selectAll('g').transition(t)
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
        // We need to find the equivalent node in the NEW root hierarchy
        const targetNode = root.descendants().find(n => n.data.name === lastZoom.data.name);
        if (targetNode) {
          zoom(targetNode as d3.HierarchyRectangularNode<ProcessNode>, 0);
        }
      }

      (window as any).zoomTreemapToNode = (nodeName: string) => {
        const targetNode = root.descendants().find(n => n.data.name === nodeName);
        if (targetNode) {
          zoom(targetNode as d3.HierarchyRectangularNode<ProcessNode>);
        }
      };

      (window as any).resetTreemapZoom = () => {
        setZoomStack([]);
        const t = svg.transition().duration(750).ease(d3.easeCubicInOut);
        svg.selectAll('g').transition(t).attr('transform', d => `translate(${(d as any).x0},${(d as any).y0})`);
        svg.selectAll('rect').transition(t).attr('width', d => (d as any).x1 - (d as any).x0).attr('height', d => (d as any).y1 - (d as any).y0);
        svg.selectAll('text').transition(t).attr('opacity', d => ((d as any).x1 - (d as any).x0 > 60 && (d as any).y1 - (d as any).y0 > 25) ? 1 : 0);
      };
    };

    updateTreemap();

    let timeout: NodeJS.Timeout;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(() => updateTreemap(true), 100);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      clearTimeout(timeout);
    };
  }, [data, hotPids]);

  return (
    <div className="technical-panel p-4" ref={containerRef} id="process-tree-container">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Maximize2 className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Process Hierarchy Treemap</h3>
          {isProbing && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[8px] font-bold text-emerald-400 animate-pulse ml-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              LIVE DATA STREAM
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 min-h-[32px]">
          {hoveredProcess && (
            <motion.div 
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              className="hidden md:flex items-center gap-3 px-3 py-1 bg-slate-900/80 border border-emerald-500/20 rounded-lg text-[10px] font-mono shadow-lg shadow-emerald-500/5"
            >
              <span className="text-slate-500 uppercase tracking-widest text-[8px]">Inspecting:</span>
              <span className="text-emerald-400 font-bold">{hoveredProcess.name.split(' (')[0]}</span>
              <div className="flex items-center gap-2 border-l border-slate-700 pl-3">
                <span className="text-blue-400">{hoveredProcess.cpu}% CPU</span>
                <span className="text-purple-400">{hoveredProcess.mem}% MEM</span>
              </div>
            </motion.div>
          )}
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
      
      <div className="relative overflow-hidden rounded bg-slate-950/50 border border-slate-800">
        {loading && !data ? (
          <div className="h-[500px] flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <RefreshCw className="w-8 h-8 text-emerald-500 animate-spin" />
              <span className="text-xs font-mono text-slate-500 uppercase animate-pulse">Scanning Process Tree...</span>
            </div>
          </div>
        ) : (
          <svg 
            ref={svgRef} 
            width="100%" 
            height="500" 
            className="w-full h-full"
            viewBox={`0 0 ${containerRef.current?.clientWidth || 800} 500`}
          />
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
