import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Activity, ZoomIn } from 'lucide-react';

interface MetricData {
  timestamp: string;
  value: number;
}

interface MetricChartProps {
  title: string;
  runId: number;
  metricKey: string;
  color?: string;
}

export const MetricChart: React.FC<MetricChartProps> = ({ title, runId, metricKey, color = '#10b981' }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<MetricData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/db/metrics/${runId}`);
        const json = await response.json();
        const filtered = json
          .filter((m: any) => m.key === metricKey)
          .map((m: any) => ({
            timestamp: m.timestamp,
            value: m.value
          }));
        setData(filtered);
      } catch (error) {
        console.error(`Failed to fetch metric ${metricKey}:`, error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [runId, metricKey]);

  useEffect(() => {
    if (data.length === 0 || !svgRef.current || !containerRef.current) return;

    const margin = { top: 20, right: 20, bottom: 30, left: 40 };
    const width = containerRef.current.clientWidth - margin.left - margin.right;
    const height = 200 - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const x = d3.scaleTime()
      .domain(d3.extent(data, (d: MetricData) => new Date(d.timestamp)) as [Date, Date])
      .range([0, width]);

    const y = d3.scaleLinear()
      .domain([0, d3.max(data, (d: MetricData) => d.value) as number || 100])
      .nice()
      .range([height, 0]);

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Add gradient
    const gradientId = `gradient-${metricKey}`;
    const gradient = svg.append('defs')
      .append('linearGradient')
      .attr('id', gradientId)
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%');

    gradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', color)
      .attr('stop-opacity', 0.3);

    gradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', color)
      .attr('stop-opacity', 0);

    const area = d3.area<MetricData>()
      .x(d => x(new Date(d.timestamp)))
      .y0(height)
      .y1(d => y(d.value))
      .curve(d3.curveMonotoneX);

    const line = d3.line<MetricData>()
      .x(d => x(new Date(d.timestamp)))
      .y(d => y(d.value))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(data)
      .attr('fill', `url(#${gradientId})`)
      .attr('d', area);

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', color)
      .attr('stroke-width', 2)
      .attr('d', line);

    // Axes
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .attr('class', 'text-slate-500 font-mono text-[10px]')
      .call(d3.axisBottom(x).ticks(5).tickFormat(d3.timeFormat('%H:%M:%S') as any));

    g.append('g')
      .attr('class', 'text-slate-500 font-mono text-[10px]')
      .call(d3.axisLeft(y).ticks(5));

    // Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 10])
      .extent([[0, 0], [width, height]])
      .on('zoom', (event) => {
        const newX = event.transform.rescaleX(x);
        g.select('.x-axis').call(d3.axisBottom(newX) as any);
        g.selectAll('path').attr('transform', event.transform);
      });

    // svg.call(zoom as any);

  }, [data, color, metricKey]);

  return (
    <div className="technical-panel p-4" ref={containerRef} id={`chart-${metricKey}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-slate-400" style={{ color }} />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
        </div>
        <div className="flex items-center gap-1 text-[10px] font-mono text-slate-600">
          <ZoomIn className="w-3 h-3" />
          <span>Metric: {metricKey}</span>
        </div>
      </div>
      
      <div className="relative h-[200px] w-full">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : data.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-slate-600 uppercase">
            No Data Points Recorded
          </div>
        ) : (
          <svg 
            ref={svgRef} 
            width="100%" 
            height="200" 
            className="w-full h-full overflow-visible"
          />
        )}
      </div>
    </div>
  );
};
