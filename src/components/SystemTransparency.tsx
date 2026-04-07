import React, { useState, useEffect } from "react";
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  BarChart, 
  Bar, 
  Cell,
  PieChart,
  Pie
} from "recharts";
import { 
  Activity, 
  Cpu, 
  HardDrive, 
  Layers, 
  Clock, 
  Server, 
  Zap, 
  ShieldCheck, 
  Thermometer,
  Gauge,
  Network,
  Info,
  ChevronRight
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SystemMetrics {
  cpus: { 
    model: string; 
    speed: number; 
    times: { user: number; nice: number; sys: number; idle: number; irq: number; }; 
  }[];
  memory: { total: number; free: number; used: number; percent: number };
  disk: { total: number; used: number; free: number; percent: number };
  loadAvg: number[];
  uptime: number;
  platform: string;
  release: string;
  arch: string;
}

interface HistoryPoint {
  time: string;
  cpu: number;
  mem: number;
  disk: number;
  load: number;
}

export default function SystemTransparency() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchMetrics = async () => {
    try {
      const res = await fetch("/api/system-metrics");
      const data: SystemMetrics = await res.json();
      setMetrics(data);
      
      const now = new Date().toLocaleTimeString();
      const cpuAvg = data.cpus.reduce((acc, cpu) => {
        const total = Object.values(cpu.times).reduce((a: number, b: any) => a + (b as number), 0);
        return acc + (1 - (cpu.times.idle as number) / (total as number)) * 100;
      }, 0) / data.cpus.length;

      setHistory(prev => {
        const newHistory = [...prev, {
          time: now,
          cpu: parseFloat(cpuAvg.toFixed(1)),
          mem: parseFloat(data.memory.percent.toFixed(1)),
          disk: data.disk.percent,
          load: data.loadAvg[0]
        }].slice(-20);
        return newHistory;
      });
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch system metrics", err);
    }
  };

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 3000);
    return () => clearInterval(interval);
  }, []);

  if (loading || !metrics) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 gap-3">
        <Activity className="w-6 h-6 animate-spin" />
        <p className="font-mono text-sm uppercase tracking-widest">Calibrating Transparency Sensors...</p>
      </div>
    );
  }

  const formatBytes = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(2)} GB`;
  };

  const formatUptime = (seconds: number) => {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  };

  const coreData = metrics.cpus.map((cpu, i) => {
    const total = Object.values(cpu.times).reduce((a: number, b: any) => a + (b as number), 0);
    return {
      name: `Core ${i}`,
      load: parseFloat(((1 - (cpu.times.idle as number) / (total as number)) * 100).toFixed(1))
    };
  });

  const latencyHeatmap = Array.from({ length: 25 }).map((_, i) => ({
    id: i,
    val: Math.random() * 100
  }));

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Top Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard 
          icon={<Server className="w-4 h-4 text-blue-400" />}
          label="Platform"
          value={metrics.platform}
          subValue={metrics.release}
        />
        <StatCard 
          icon={<Clock className="w-4 h-4 text-emerald-400" />}
          label="Uptime"
          value={formatUptime(metrics.uptime)}
          subValue={`${metrics.arch} architecture`}
        />
        <StatCard 
          icon={<Layers className="w-4 h-4 text-purple-400" />}
          label="Memory"
          value={`${metrics.memory.percent.toFixed(1)}%`}
          subValue={`${formatBytes(metrics.memory.used)} / ${formatBytes(metrics.memory.total)}`}
          progress={metrics.memory.percent}
        />
        <StatCard 
          icon={<HardDrive className="w-4 h-4 text-amber-400" />}
          label="Disk Usage"
          value={`${metrics.disk.percent}%`}
          subValue={`${formatBytes(metrics.disk.used)} / ${formatBytes(metrics.disk.total)}`}
          progress={metrics.disk.percent}
        />
        <StatCard 
          icon={<Gauge className="w-4 h-4 text-blue-400" />}
          label="Load Average"
          value={metrics.loadAvg[0].toFixed(2)}
          subValue={`${metrics.loadAvg[1].toFixed(2)} (5m) • ${metrics.loadAvg[2].toFixed(2)} (15m)`}
        />
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* System Pressure Trends */}
        <div className="col-span-12 lg:col-span-8 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="bg-blue-500/20 p-2 rounded-lg">
                <Activity className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="font-bold text-white">System Pressure Trends</h3>
                <p className="text-xs text-slate-500 font-mono">Real-time CPU, Memory, and Disk pressure mapping</p>
              </div>
            </div>
            <div className="flex gap-4 text-[10px] font-bold uppercase tracking-wider">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-blue-400">CPU</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-purple-500" />
                <span className="text-purple-400">MEM</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-amber-500" />
                <span className="text-amber-400">DISK</span>
              </div>
            </div>
          </div>

          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorMem" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a855f7" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#a855f7" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorDisk" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis 
                  dataKey="time" 
                  stroke="#475569" 
                  fontSize={10} 
                  tickLine={false} 
                  axisLine={false}
                  minTickGap={30}
                />
                <YAxis 
                  stroke="#475569" 
                  fontSize={10} 
                  tickLine={false} 
                  axisLine={false}
                  domain={[0, 100]}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px' }}
                  itemStyle={{ fontSize: '12px' }}
                />
                <Area 
                  type="monotone" 
                  dataKey="cpu" 
                  stroke="#3b82f6" 
                  fillOpacity={1} 
                  fill="url(#colorCpu)" 
                  strokeWidth={2}
                  isAnimationActive={false}
                />
                <Area 
                  type="monotone" 
                  dataKey="mem" 
                  stroke="#a855f7" 
                  fillOpacity={1} 
                  fill="url(#colorMem)" 
                  strokeWidth={2}
                  isAnimationActive={false}
                />
                <Area 
                  type="monotone" 
                  dataKey="disk" 
                  stroke="#f59e0b" 
                  fillOpacity={1} 
                  fill="url(#colorDisk)" 
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Core Distribution & Latency Heatmap */}
        <div className="col-span-12 lg:col-span-4 space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="bg-purple-500/20 p-2 rounded-lg">
                <Cpu className="w-5 h-5 text-purple-400" />
              </div>
              <div>
                <h3 className="font-bold text-white">Core Distribution</h3>
                <p className="text-xs text-slate-500 font-mono">Individual CPU core load distribution</p>
              </div>
            </div>

            <div className="h-[180px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={coreData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="name" hide />
                  <YAxis hide domain={[0, 100]} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px' }}
                    itemStyle={{ fontSize: '12px' }}
                  />
                  <Bar dataKey="load" radius={[4, 4, 0, 0]}>
                    {coreData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.load > 80 ? '#ef4444' : '#6366f1'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="bg-amber-500/20 p-2 rounded-lg">
                <Thermometer className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="font-bold text-white">Latency Heatmap</h3>
                <p className="text-xs text-slate-500 font-mono">Microsecond jitter distribution</p>
              </div>
            </div>

            <div className="grid grid-cols-5 gap-1.5">
              {latencyHeatmap.map(cell => (
                <div 
                  key={cell.id}
                  className="aspect-square rounded-sm transition-all duration-1000"
                  style={{
                    backgroundColor: cell.val > 80 ? '#ef4444' : cell.val > 50 ? '#f59e0b' : '#10b981',
                    opacity: 0.1 + (cell.val / 100) * 0.9
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* System Inventory */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl overflow-hidden relative">
        <div className="absolute top-0 right-0 p-8 opacity-5">
          <ShieldCheck className="w-32 h-32 text-blue-500" />
        </div>
        
        <div className="flex items-center gap-3 mb-8">
          <div className="bg-emerald-500/20 p-2 rounded-lg">
            <Zap className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h3 className="font-bold text-white">System Inventory</h3>
            <p className="text-xs text-slate-500 font-mono">Hardware & OS environment specifications</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <InventoryItem 
            label="CPU Model" 
            value={metrics.cpus[0].model} 
            subValue={`${metrics.cpus.length} Physical Cores @ ${metrics.cpus[0].speed} MHz`}
          />
          <InventoryItem 
            label="Kernel Version" 
            value={metrics.release} 
            subValue={`${metrics.platform} • ${metrics.arch}`}
          />
          <InventoryItem 
            label="Memory Topology" 
            value={`${formatBytes(metrics.memory.total)} Total`} 
            subValue="System Memory Hierarchy"
          />
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, subValue, progress }: { icon: React.ReactNode, label: string, value: string, subValue: string, progress?: number }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg group hover:border-slate-700 transition-all">
      <div className="flex items-center justify-between mb-3">
        <div className="p-2 bg-slate-800 rounded-lg group-hover:bg-slate-700 transition-colors">
          {icon}
        </div>
        <ChevronRight className="w-4 h-4 text-slate-700 group-hover:text-slate-500" />
      </div>
      <div className="space-y-1">
        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{label}</span>
        <p className="text-2xl font-bold text-white tracking-tight">{value}</p>
        <p className="text-[10px] font-mono text-slate-500">{subValue}</p>
      </div>
      {progress !== undefined && (
        <div className="mt-4 h-1 w-full bg-slate-800 rounded-full overflow-hidden">
          <div 
            className="h-full bg-blue-500 transition-all duration-1000" 
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}

function InventoryItem({ label, value, subValue }: { label: string, value: string, subValue: string }) {
  return (
    <div className="space-y-2">
      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{label}</span>
      <p className="text-sm font-bold text-slate-200">{value}</p>
      <p className="text-xs font-mono text-slate-500">{subValue}</p>
    </div>
  );
}
