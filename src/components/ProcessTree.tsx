import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Maximize2, Minimize2, RefreshCw } from 'lucide-react';

interface ProcessNode {
  name: string;
  value?: number;
  children?: ProcessNode[];
}

interface ProcessTreeProps {
  onSelectProcess?: (process: ProcessNode) => void;
  isProbing?: boolean;
}

export const ProcessTree: React.FC<ProcessTreeProps> = ({ onSelectProcess, isProbing }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ProcessNode | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/process-tree');
      const json = await response.json();
      setData(json);
    } catch (error) {
      console.error('Failed to fetch process tree:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!data || !svgRef.current || !containerRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = 500;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const root = d3.hierarchy(data)
      .sum(d => d.value || 1)
      .sort((a, b) => (b.value || 0) - (a.value || 0));

    const treemap = d3.treemap<ProcessNode>()
      .size([width, height])
      .paddingOuter(3)
      .paddingTop(19)
      .paddingInner(1)
      .round(true);

    treemap(root);

    const color = d3.scaleOrdinal<string>()
      .range(['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']);

    // Add gradients
    const defs = svg.append('defs');
    
    root.descendants().forEach((d, i) => {
      const gradientId = `gradient-${i}`;
      const baseColor = d.children ? '#1e293b' : color(d.parent?.data.name || 'root');
      
      const gradient = defs.append('linearGradient')
        .attr('id', gradientId)
        .attr('x1', '0%')
        .attr('y1', '0%')
        .attr('x2', '100%')
        .attr('y2', '100%');

      gradient.append('stop')
        .attr('offset', '0%')
        .attr('stop-color', baseColor)
        .attr('stop-opacity', 0.8);

      gradient.append('stop')
        .attr('offset', '100%')
        .attr('stop-color', d3.color(baseColor)?.darker(1).toString() || baseColor)
        .attr('stop-opacity', 1);
    });

    const cell = svg.selectAll<SVGGElement, d3.HierarchyRectangularNode<ProcessNode>>('g')
      .data(root.descendants() as d3.HierarchyRectangularNode<ProcessNode>[])
      .enter().append('g')
      .attr('transform', d => `translate(${d.x0},${d.y0})`);

    cell.append('rect')
      .attr('id', d => `rect-${d.data.name.replace(/\s+/g, '-')}`)
      .attr('width', d => d.x1 - d.x0)
      .attr('height', d => d.y1 - d.y0)
      .attr('fill', (d, i) => `url(#gradient-${i})`)
      .attr('stroke', '#0f172a')
      .attr('stroke-width', 1)
      .attr('class', 'cursor-pointer hover:brightness-125 transition-all duration-300')
      .on('click', (event, d) => {
        if (onSelectProcess) onSelectProcess(d.data);
        zoom(d as d3.HierarchyRectangularNode<ProcessNode>);
        
        // Highlight selection
        svg.selectAll('rect').attr('stroke', '#0f172a').attr('stroke-width', 1);
        d3.select(event.currentTarget).attr('stroke', '#10b981').attr('stroke-width', 2);
      });

    cell.append('text')
      .attr('class', 'pointer-events-none fill-white/80 text-[9px] font-mono font-bold')
      .attr('opacity', d => (d.x1 - d.x0 > 60 && d.y1 - d.y0 > 30) ? 1 : 0)
      .selectAll('tspan')
      .data(d => {
        const name = d.data.name.split(' (')[0];
        const pid = d.data.name.match(/\((\d+)\)/)?.[1] || '';
        return [name, pid ? `PID: ${pid}` : ''];
      })
      .enter().append('tspan')
      .attr('x', 6)
      .attr('y', (d, i) => 15 + i * 11)
      .text(d => String(d));

    cell.append('title')
      .text(d => `${d.ancestors().map(d => d.data.name).reverse().join('/')}\nValue: ${d.value}`);

    function zoom(d: d3.HierarchyRectangularNode<ProcessNode>) {
      const kx = width / (d.x1 - d.x0);
      const ky = height / (d.y1 - d.y0);
      const x = d.x0;
      const y = d.y0;

      const t = svg.transition().duration(750);

      svg.selectAll('g').transition(t)
        .attr('transform', (node: any) => `translate(${(node.x0 - x) * kx},${(node.y0 - y) * ky})`);

      svg.selectAll('rect').transition(t)
        .attr('width', (node: any) => (node.x1 - node.x0) * kx)
        .attr('height', (node: any) => (node.y1 - node.y0) * ky);
    }

  }, [data]);

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
        <div className="flex items-center gap-2">
          <button 
            onClick={() => {
              if (data && svgRef.current) {
                // To reset zoom, we just zoom to the root
                const root = d3.hierarchy(data).sum(d => d.value || 1);
                const width = containerRef.current?.clientWidth || 800;
                const height = 500;
                const treemap = d3.treemap<ProcessNode>().size([width, height]);
                treemap(root);
                // This is a bit hacky since zoom() is internal, 
                // but we can trigger a re-render or expose it.
                // For now, let's just re-fetch or re-render.
                fetchData();
              }
            }}
            className="p-1.5 hover:bg-slate-800 rounded-md transition-colors text-slate-400 hover:text-emerald-400"
            title="Reset Zoom"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
          <button 
            onClick={fetchData}
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
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-emerald-500" />
          <span>Leaf Process</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-slate-700" />
          <span>Parent Group</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Minimize2 className="w-3 h-3" />
          <span>Click to Zoom</span>
        </div>
      </div>
    </div>
  );
};
