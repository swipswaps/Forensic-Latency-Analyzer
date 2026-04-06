import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Maximize2, Minimize2, RefreshCw } from 'lucide-react';

interface ProcessNode {
  name: string;
  value?: number;
  children?: ProcessNode[];
}

export const ProcessTree: React.FC = () => {
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

    const color = d3.scaleOrdinal(d3.schemeTableau10);

    const cell = svg.selectAll<SVGGElement, d3.HierarchyRectangularNode<ProcessNode>>('g')
      .data(root.descendants() as d3.HierarchyRectangularNode<ProcessNode>[])
      .enter().append('g')
      .attr('transform', d => `translate(${d.x0},${d.y0})`);

    cell.append('rect')
      .attr('id', d => `rect-${d.data.name.replace(/\s+/g, '-')}`)
      .attr('width', d => d.x1 - d.x0)
      .attr('height', d => d.y1 - d.y0)
      .attr('fill', d => d.children ? '#1e293b' : color(d.parent?.data.name || 'root'))
      .attr('class', 'cursor-pointer hover:opacity-80 transition-opacity duration-200')
      .on('click', (event, d) => {
        zoom(d as d3.HierarchyRectangularNode<ProcessNode>);
      });

    cell.append('text')
      .attr('class', 'pointer-events-none fill-slate-300 text-[10px] font-mono')
      .selectAll('tspan')
      .data(d => d.data.name.split(/(?=[A-Z][^A-Z])/g).concat(d.value ? d.value.toString() : ''))
      .enter().append('tspan')
      .attr('x', 4)
      .attr('y', (d, i) => 13 + i * 10)
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
        </div>
        <button 
          onClick={fetchData}
          className="p-1.5 hover:bg-slate-800 rounded-md transition-colors text-slate-400 hover:text-emerald-400"
          title="Refresh Data"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
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
