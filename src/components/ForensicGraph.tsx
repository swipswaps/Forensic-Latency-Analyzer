import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { Activity, Cpu, Zap, Network, ShieldCheck } from "lucide-react";
import SunburstChart from "./SunburstChart";

interface ProcessNode extends d3.SimulationNodeDatum {
  id: string;
  name: string;
  cpu: number;
  mem: number;
  type: "process" | "system" | "network";
}

interface ProcessLink extends d3.SimulationLinkDatum<ProcessNode> {
  source: string;
  target: string;
}

export default function ForensicGraph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<{ nodes: ProcessNode[], links: ProcessLink[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch("/api/processes");
        const processes = await res.json();
        
        const nodes: ProcessNode[] = [
          { id: "root", name: "System Kernel", cpu: 0, mem: 0, type: "system" }
        ];
        const links: ProcessLink[] = [];

        processes.forEach((p: any, i: number) => {
          const id = `p-${p.PID}`;
          nodes.push({
            id,
            name: p.COMMAND.split(" ")[0],
            cpu: parseFloat(p["%CPU"]),
            mem: parseFloat(p["%MEM"]),
            type: "process"
          });
          links.push({ source: "root", target: id });
        });

        setData({ nodes, links });
        setLoading(false);
      } catch (err) {
        console.error("Failed to fetch process data for graph", err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!svgRef.current || data.nodes.length === 0) return;

    const width = svgRef.current.clientWidth;
    const height = 400;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const simulation = d3.forceSimulation<ProcessNode>(data.nodes)
      .force("link", d3.forceLink<ProcessNode, ProcessLink>(data.links).id(d => d.id).distance(80))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(d => (d as any).cpu * 2 + 20));

    const link = svg.append("g")
      .attr("stroke", "#1e293b")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(data.links)
      .join("line")
      .attr("stroke-width", 1);

    const node = svg.append("g")
      .selectAll("g")
      .data(data.nodes)
      .join("g")
      .call(d3.drag<SVGGElement, ProcessNode>()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended) as any);

    node.append("circle")
      .attr("r", (d: any) => d.type === "system" ? 15 : Math.max(5, d.cpu * 2 + 8))
      .attr("fill", (d: any) => d.type === "system" ? "#3b82f6" : d.cpu > 10 ? "#ef4444" : "#60a5fa")
      .attr("stroke", "#0f172a")
      .attr("stroke-width", 2);

    node.append("text")
      .text((d: any) => d.name)
      .attr("x", 12)
      .attr("y", 4)
      .attr("fill", "#94a3b8")
      .style("font-size", "10px")
      .style("font-family", "monospace")
      .style("pointer-events", "none");

    simulation.on("tick", () => {
      link
        .attr("x1", (d: any) => (d.source as any).x)
        .attr("y1", (d: any) => (d.source as any).y)
        .attr("x2", (d: any) => (d.target as any).x)
        .attr("y2", (d: any) => (d.target as any).y);

      node
        .attr("transform", (d: any) => `translate(${d.x},${d.y})`);
    });

    function dragstarted(event: any) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }

    function dragged(event: any) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }

    function dragended(event: any) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }

    return () => simulation.stop();
  }, [data]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl relative overflow-hidden">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="bg-blue-500/20 p-2 rounded-lg">
              <Zap className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h3 className="font-bold text-white">Process Topology (D3)</h3>
              <p className="text-xs text-slate-500 font-mono">Force-directed kernel process mapping</p>
            </div>
          </div>
          <div className="flex gap-4 text-[10px] font-bold uppercase tracking-wider">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-blue-500" />
              <span className="text-blue-400">Kernel</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-red-400">High CPU</span>
            </div>
          </div>
        </div>

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm z-10">
            <Activity className="w-6 h-6 text-blue-500 animate-spin" />
          </div>
        )}

        <svg ref={svgRef} className="w-full h-[400px] cursor-grab active:cursor-grabbing" />
        
        <div className="mt-4 grid grid-cols-3 gap-4 border-t border-slate-800 pt-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span className="text-[10px] font-mono text-slate-400">Isolation: Active</span>
          </div>
          <div className="flex items-center gap-2">
            <Network className="w-4 h-4 text-blue-400" />
            <span className="text-[10px] font-mono text-slate-400">Nodes: {data.nodes.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-purple-400" />
            <span className="text-[10px] font-mono text-slate-400">Audit: Real-time</span>
          </div>
        </div>
      </div>

      <SunburstChart />
    </div>
  );
}
