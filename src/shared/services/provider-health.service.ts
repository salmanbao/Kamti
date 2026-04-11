import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from './winston-logger.service';

export type ProviderOperation =
  | 'quote'
  | 'price'
  | 'buildTx'
  | 'routes'
  | 'execute'
  | 'status';

type LatencySample = number;

type ErrorBucket = {
  type: string;
  count: number;
};

type ProviderOpMetrics = {
  operation: ProviderOperation;
  total: number;
  success: number;
  failure: number;
  lastError?: string;
  latencies: LatencySample[]; // capped ring buffer
};

type ProviderMetrics = {
  name: string;
  ops: Map<ProviderOperation, ProviderOpMetrics>;
  lastUpdated: number;
};

@Injectable()
export class ProviderHealthService {
  private readonly logger: WinstonLoggerService;
  private readonly store = new Map<string, ProviderMetrics>();
  private readonly maxLatencySamples = 200; // cap memory per op

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(ProviderHealthService.name);
  }

  private getOrCreate(name: string): ProviderMetrics {
    let entry = this.store.get(name);
    if (!entry) {
      entry = {
        name,
        ops: new Map<ProviderOperation, ProviderOpMetrics>(),
        lastUpdated: Date.now(),
      };
      this.store.set(name, entry);
    }
    return entry;
  }

  private getOrCreateOp(
    entry: ProviderMetrics,
    op: ProviderOperation,
  ): ProviderOpMetrics {
    let m = entry.ops.get(op);
    if (!m) {
      m = { operation: op, total: 0, success: 0, failure: 0, latencies: [] };
      entry.ops.set(op, m);
    }
    return m;
  }

  recordSuccess(provider: string, op: ProviderOperation, durationMs: number) {
    const entry = this.getOrCreate(provider);
    const m = this.getOrCreateOp(entry, op);
    m.total += 1;
    m.success += 1;
    this.pushLatency(m.latencies, durationMs);
    entry.lastUpdated = Date.now();
  }

  recordFailure(
    provider: string,
    op: ProviderOperation,
    durationMs: number | undefined,
    errorType?: string,
  ) {
    const entry = this.getOrCreate(provider);
    const m = this.getOrCreateOp(entry, op);
    m.total += 1;
    m.failure += 1;
    if (durationMs != null) this.pushLatency(m.latencies, durationMs);
    if (errorType) m.lastError = errorType;
    entry.lastUpdated = Date.now();
  }

  private pushLatency(buf: number[], v: number) {
    buf.push(v);
    if (buf.length > this.maxLatencySamples) buf.shift();
  }

  private pct(nums: number[], p: number): number | undefined {
    if (!nums.length) return undefined;
    const sorted = [...nums].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor((p / 100) * sorted.length)),
    );
    return sorted[idx];
  }

  getProviderSummary(name: string) {
    const entry = this.store.get(name);
    if (!entry) return null;

    const aggregate = Array.from(entry.ops.values()).reduce(
      (acc, m) => {
        acc.total += m.total;
        acc.success += m.success;
        acc.failure += m.failure;
        acc.latencies.push(...m.latencies);
        acc.lastError = acc.lastError || m.lastError;
        return acc;
      },
      {
        total: 0,
        success: 0,
        failure: 0,
        latencies: [] as number[],
        lastError: undefined as string | undefined,
      },
    );

    const successRate =
      aggregate.total > 0 ? aggregate.success / aggregate.total : 0;
    const avgLatency = aggregate.latencies.length
      ? aggregate.latencies.reduce((a, b) => a + b, 0) /
        aggregate.latencies.length
      : undefined;

    const p50 = this.pct(aggregate.latencies, 50);
    const p95 = this.pct(aggregate.latencies, 95);

    const status =
      successRate >= 0.9
        ? 'healthy'
        : successRate >= 0.7
          ? 'degraded'
          : 'unhealthy';

    return {
      name,
      status,
      successRate,
      totalRequests: aggregate.total,
      successes: aggregate.success,
      failures: aggregate.failure,
      latency: avgLatency,
      p50Latency: p50,
      p95Latency: p95,
      lastError: aggregate.lastError,
      lastCheck: new Date(entry.lastUpdated),
      errorRate: aggregate.total ? aggregate.failure / aggregate.total : 0,
    };
  }

  getAllSummaries() {
    return Array.from(this.store.keys()).map((k) => this.getProviderSummary(k));
  }
}
