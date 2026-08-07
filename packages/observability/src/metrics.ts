export type MetricLabels = Record<string, string>;

type MetricSample = { labels: MetricLabels; value: number };

function serializeLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return '';
  return entries.map(([key, value]) => `${key}="${value}"`).join(',');
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, MetricSample>>();
  private readonly gauges = new Map<string, Map<string, MetricSample>>();
  private readonly histograms = new Map<string, { count: number; sum: number }>();

  incrementCounter(name: string, labels: MetricLabels = {}, amount = 1): void {
    const key = serializeLabels(labels);
    const byLabel = this.counters.get(name) ?? new Map<string, MetricSample>();
    const current = byLabel.get(key) ?? { labels, value: 0 };
    current.value += amount;
    byLabel.set(key, current);
    this.counters.set(name, byLabel);
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const key = serializeLabels(labels);
    const byLabel = this.gauges.get(name) ?? new Map<string, MetricSample>();
    byLabel.set(key, { labels, value });
    this.gauges.set(name, byLabel);
  }

  observeDuration(name: string, milliseconds: number): void {
    const current = this.histograms.get(name) ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += milliseconds;
    this.histograms.set(name, current);
  }

  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, byLabel] of this.counters) {
      result[name] = Object.fromEntries([...byLabel].map(([key, s]) => [key || 'total', s.value]));
    }
    for (const [name, byLabel] of this.gauges) {
      result[name] = Object.fromEntries([...byLabel].map(([key, s]) => [key || 'total', s.value]));
    }
    for (const [name, histogram] of this.histograms) {
      result[name] = {
        count: histogram.count,
        averageMs: histogram.count === 0 ? 0 : histogram.sum / histogram.count,
      };
    }
    return result;
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    const render = (source: Map<string, Map<string, MetricSample>>, kind: string) => {
      for (const [name, byLabel] of source) {
        lines.push(`# TYPE ${name} ${kind}`);
        for (const sample of byLabel.values()) {
          const labels = serializeLabels(sample.labels);
          lines.push(`${name}${labels ? `{${labels}}` : ''} ${sample.value}`);
        }
      }
    };
    render(this.counters, 'counter');
    render(this.gauges, 'gauge');
    for (const [name, histogram] of this.histograms) {
      lines.push(`# TYPE ${name} summary`);
      lines.push(`${name}_count ${histogram.count}`);
      lines.push(`${name}_sum ${histogram.sum}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export const METRIC_NAMES = {
  connectedClients: 'sorema_connected_clients',
  localAgentsOnline: 'sorema_local_agents_online',
  realtimeSessionsActive: 'sorema_realtime_sessions_active',
  functionCallsReceived: 'sorema_function_calls_received_total',
  toolLatency: 'sorema_tool_latency_ms',
  jobsActive: 'sorema_jobs_active',
  jobsCompleted: 'sorema_jobs_completed_total',
  jobsFailed: 'sorema_jobs_failed_total',
  outboxPending: 'sorema_outbox_pending',
  tunnelReconnections: 'sorema_tunnel_reconnections_total',
  realtimeAudioTokens: 'sorema_realtime_audio_tokens_total',
  realtimeCachedInputTokens: 'sorema_realtime_cached_input_tokens_total',
  realtimeEstimatedCostUsd: 'sorema_realtime_estimated_cost_usd_total',
} as const;
