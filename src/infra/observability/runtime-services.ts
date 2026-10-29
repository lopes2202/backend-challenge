import { randomUUID } from 'node:crypto';
import type {
  ClockPort,
  IdGeneratorPort,
  LoggerPort,
  MetricsPort,
} from '../../application/ports';

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

export class CryptoIdGenerator implements IdGeneratorPort {
  next(): string {
    return randomUUID();
  }
}

// só estes campos entram no log; o resto é descartado para não vazar payload financeiro
const SAFE_KEYS = new Set([
  'correlationId',
  'messageId',
  'transactionId',
  'walletId',
  'providerId',
  'queue',
  'attempt',
  'reason',
  'status',
  'type',
  'count',
  'durationMs',
  'error',
  // diagnóstico de reconciliação (saldos da própria carteira)
  'storedBalance',
  'calculatedBalance',
  'difference',
]);

export class StructuredJsonLogger implements LoggerPort {
  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  private write(level: string, msg: string, meta?: Record<string, unknown>): void {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta ?? {})) {
      if (SAFE_KEYS.has(key)) safe[key] = value;
    }
    const line = JSON.stringify({ level, msg, timestamp: new Date().toISOString(), ...safe });
    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
}

export class InMemoryMetrics implements MetricsPort {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramSnapshot>();

  increment(name: string, value = 1, tags?: Record<string, string>): void {
    const key = this.key(name, tags);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: string, value: number, tags?: Record<string, string>): void {
    const key = this.key(name, tags);
    const h = this.histograms.get(key);
    if (!h) {
      this.histograms.set(key, { count: 1, sum: value, min: value, max: value });
      return;
    }
    h.count += 1;
    h.sum += value;
    h.min = Math.min(h.min, value);
    h.max = Math.max(h.max, value);
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries(
        [...this.histograms].map(([k, h]) => [k, { ...h }]),
      ),
    };
  }

  // chave no estilo name{a=1,b=2}, com tags ordenadas
  private key(name: string, tags?: Record<string, string>): string {
    if (!tags || Object.keys(tags).length === 0) return name;
    const parts = Object.keys(tags)
      .sort()
      .map((k) => `${k}=${tags[k]}`);
    return `${name}{${parts.join(',')}}`;
  }
}

