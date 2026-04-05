import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { Loader2, RefreshCw } from "lucide-react";

interface SunburstNode {
  name: string;
  children?: SunburstNode[];
  value?: number;
}

export default function SunburstChart() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/process-tree");
      const data = await res.json();
      renderSunburst(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const renderSunburst = (data: SunburstNode) => {
    if (!svgRef.current) return;

    const width = 600;
    const radius = width / 6;

    const partition = (data: any) => {
      const root = d3.hierarchy(data)
        .sum(d => d.value || 0)
        .sort((a, b) => (b.value || 0) - (a.value || 0));
      return d3.partition()
        .size([2 * Math.PI, root.height + 1])(root);
    };

    const color = d3.scaleOrdinal(d3.quantize(d3.interpolateRainbow, data.children?.length || 10));

    const arc = d3.arc<any>()
      .startAngle(d => d.x0)
      .endAngle(d => d.x1)
      .padAngle(d => Math.min((d.x1 - d.x0) / 2, 0.005))
      .padRadius(radius * 1.5)
      .innerRadius(d => d.y0 * radius)
      .outerRadius(d => Math.max(d.y0 * radius, d.y1 * radius - 1));

    const root = partition(data);
    root.each((d: any) => d.current = d);

    const svg = d3.select(svgRef.current)
      .attr("viewBox", [0, 0, width, width])
      .style("font", "10px sans-serif");

    svg.selectAll("*").remove();

    const g = svg.append("g")
      .attr("transform", `translate(${width / 2},${width / 2})`);

    const path = g.append("g")
      .selectAll("path")
      .data(root.descendants().slice(1))
      .join("path")
      .attr("fill", (d: any) => { while (d.depth > 1) d = d.parent; return color(d.data.name); })
      .attr("fill-opacity", (d: any) => arcVisible(d.current) ? (d.children ? 0.6 : 0.4) : 0)
      .attr("pointer-events", (d: any) => arcVisible(d.current) ? "auto" : "none")
      .attr("d", (d: any) => arc(d.current));

    path.filter((d: any) => d.children)
      .style("cursor", "pointer")
      .on("click", clicked);

    path.append("title")
      .text((d: any) => `${d.ancestors().map((d: any) => d.data.name).reverse().join("/")}\n${d.value}`);

    const label = g.append("g")
      .attr("pointer-events", "none")
      .attr("text-anchor", "middle")
      .style("user-select", "none")
      .selectAll("text")
      .data(root.descendants().slice(1))
      .join("text")
      .attr("dy", "0.35em")
      .attr("fill-opacity", (d: any) => labelVisible(d.current) ? 1 : 0)
      .attr("transform", (d: any) => labelTransform(d.current))
      .attr("fill", "white")
      .text((d: any) => d.data.name.split(" ")[0]);

    const parent = g.append("circle")
      .datum(root)
      .attr("r", radius)
      .attr("fill", "none")
      .attr("pointer-events", "all")
      .on("click", clicked);

    function clicked(event: any, p: any) {
      parent.datum(p.parent || root);

      root.each((d: any) => d.target = {
        x0: Math.max(0, Math.min(1, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
        x1: Math.max(0, Math.min(1, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
        y0: Math.max(0, d.y0 - p.depth),
        y1: Math.max(0, d.y1 - p.depth)
      });

      const t = g.transition().duration(750);

      path.transition(t)
        .tween("data", d => {
          const i = d3.interpolate((d as any).current, (d as any).target);
          return t => (d as any).current = i(t);
        })
        .filter(function(d: any) {
          return !!(+(this as any).getAttribute("fill-opacity") || arcVisible(d.target));
        })
        .attr("fill-opacity", (d: any) => arcVisible(d.target) ? (d.children ? 0.6 : 0.4) : 0)
        .attr("pointer-events", (d: any) => arcVisible(d.target) ? "auto" : "none")
        .attrTween("d", d => () => arc((d as any).current));

      label.filter(function(d: any) {
        return !!(+(this as any).getAttribute("fill-opacity") || labelVisible(d.target));
      }).transition(t)
        .attr("fill-opacity", (d: any) => labelVisible(d.target) ? 1 : 0)
        .attrTween("transform", d => () => labelTransform((d as any).current));
    }

    function arcVisible(d: any) {
      return d.y1 <= 3 && d.y0 >= 1 && d.x1 > d.x0;
    }

    function labelVisible(d: any) {
      return d.y1 <= 3 && d.y0 >= 1 && (d.y1 - d.y0) * (d.x1 - d.x0) > 0.03;
    }

    function labelTransform(d: any) {
      const x = (d.x0 + d.x1) / 2 * 180 / Math.PI;
      const y = (d.y0 + d.y1) / 2 * radius;
      return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`;
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="font-bold text-white flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-blue-400" />
            Process Hierarchy Sunburst
          </h3>
          <p className="text-xs text-slate-500">Interactive zoomable process tree visualization</p>
        </div>
        <button 
          onClick={fetchData}
          disabled={loading}
          className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex-1 flex items-center justify-center relative min-h-[400px]">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm z-10">
            <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
          </div>
        )}
        {error && (
          <div className="text-red-400 text-sm bg-red-500/10 p-4 rounded-lg border border-red-500/20">
            Error: {error}
          </div>
        )}
        <svg ref={svgRef} className="w-full max-w-[600px] h-auto" />
      </div>
    </div>
  );
}
