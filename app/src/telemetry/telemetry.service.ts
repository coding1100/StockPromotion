import { Injectable } from '@nestjs/common';

@Injectable()
export class TelemetryService {
  private readonly counters = new Map<string, number>();

  increment(metricName: string, value = 1): void {
    const current = this.counters.get(metricName) ?? 0;
    this.counters.set(metricName, current + value);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters.entries());
  }
}
