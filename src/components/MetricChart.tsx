import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Activity, ZoomIn, RefreshCw } from 'lucide-react';

interface MetricData {
  timestamp: string;
  value: number;
}

interface MetricChartProps {
  title: string;
  runId: number;
  runMode: string;
  metricKey: string;
  color?: string;
  isLive?: boolean;
}

export const MetricChart: React.FC<MetricChartProps> = ({ title, runId, runMode, metricKey, color = '#10b981', isLive = false }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<MetricData[]>([]);
  const [loading, setLoading] = useState(true);

  const isPressureMetric = metricKey.includes('PRESSURE');
  const isMemModule = runMode.includes('MEM');
  const isSkipped = isPressureMetric && isMemModule;

  const fetchData = async (showLoading = true) => {
    if (isSkipped) {
      setData([]);
      setLoading(false);
      return;
    }
    if (showLoading) setLoading(true);
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
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(true);
  }, [runId, metricKey, isSkipped]);

  useEffect(() => {
    if (isLive) {
      const interval = setInterval(() => fetchData(false), 3000);
      return () => clearInterval(interval);
    }
  }, [isLive, runId, metricKey]);

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
      .attr('class', `area-${metricKey}`)
      .attr('fill', `url(#${gradientId})`)
      .attr('d', area);

    g.append('path')
      .datum(data)
      .attr('class', `line-${metricKey}`)
      .attr('fill', 'none')
      .attr('stroke', color)
      .attr('stroke-width', 2)
      .attr('d', line);

    // Axes
    const xAxis = g.append('g')
      .attr('transform', `translate(0,${height})`)
      .attr('class', 'x-axis text-slate-500 font-mono text-[10px]')
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
        xAxis.call(d3.axisBottom(newX).ticks(5).tickFormat(d3.timeFormat('%H:%M:%S') as any) as any);
        
        const updatedLine = d3.line<MetricData>()
          .x(d => newX(new Date(d.timestamp)))
          .y(d => y(d.value))
          .curve(d3.curveMonotoneX);

        const updatedArea = d3.area<MetricData>()
          .x(d => newX(new Date(d.timestamp)))
          .y0(height)
          .y1(d => y(d.value))
          .curve(d3.curveMonotoneX);

        g.select(`.line-${metricKey}`).attr('d', updatedLine(data));
        g.select(`.area-${metricKey}`).attr('d', updatedArea(data));
      });

    svg.call(zoom as any);

  }, [data, color, metricKey]);

  return (
    <div className="technical-panel p-4" ref={containerRef} id={`chart-${metricKey}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-slate-400" style={{ color }} />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => {
              if (svgRef.current) {
                d3.select(svgRef.current).transition().duration(750).call(d3.zoom().transform as any, d3.zoomIdentity);
              }
            }}
            className="p-1 hover:bg-slate-800 rounded transition-colors text-slate-500 hover:text-emerald-400"
            title="Reset Zoom"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button 
            onClick={() => fetchData(true)}
            className="p-1 hover:bg-slate-800 rounded transition-colors text-slate-500 hover:text-emerald-400"
            title="Refresh Data"
          >
            <Activity className={`w-3 h-3 ${loading ? 'animate-pulse' : ''}`} />
          </button>
          <div className="flex items-center gap-1 text-[10px] font-mono text-slate-600">
            <ZoomIn className="w-3 h-3" />
            <span>Metric: {metricKey}</span>
          </div>
        </div>
      </div>
      
      <div className="relative h-[200px] w-full">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : isSkipped ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
            <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
              Metric Not Captured
            </div>
            <div className="text-[9px] font-mono text-slate-600 italic">
              PSI diagnostics are bypassed in {runMode} module to optimize forensic throughput.
            </div>
          </div>
        ) : data.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
            <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
              No Data Points Recorded
            </div>
            <div className="text-[9px] font-mono text-slate-600 italic">
              {runId === 0 ? "Real-time metrics are streaming to the database." : "The probe did not record pressure stalls during this audit window."}
            </div>
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
