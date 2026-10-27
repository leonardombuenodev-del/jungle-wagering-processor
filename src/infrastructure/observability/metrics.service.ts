import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

@Injectable()
export class MetricsService {
  public readonly registry: Registry;

  public readonly transactionsTotal: Counter<string>;
  public readonly duplicatesDetectedTotal: Counter<string>;
  public readonly retriesTotal: Counter<string>;
  public readonly dlqMessagesTotal: Counter<string>;
  public readonly lockConflictsTotal: Counter<string>;
  public readonly reconciliationDivergencesTotal: Counter<string>;
  public readonly outboxLagSeconds: Gauge<string>;
  public readonly processingLatencyMs: Histogram<string>;

  constructor() {
    this.registry = new Registry();

    this.transactionsTotal = new Counter({
      name: "wagering_transactions_total",
      help: "Total wagering transactions by kind and status",
      labelNames: ["kind", "status", "failure_code"],
      registers: [this.registry],
    });

    this.duplicatesDetectedTotal = new Counter({
      name: "wagering_duplicates_detected_total",
      help: "Total duplicate requests/messages detected via idempotency or inbox",
      labelNames: ["source"],
      registers: [this.registry],
    });

    this.retriesTotal = new Counter({
      name: "wagering_retries_total",
      help: "Total retry attempts by component",
      labelNames: ["component"],
      registers: [this.registry],
    });

    this.dlqMessagesTotal = new Counter({
      name: "wagering_dlq_messages_total",
      help: "Total messages routed to or observed in DLQ",
      labelNames: ["reason"],
      registers: [this.registry],
    });

    this.lockConflictsTotal = new Counter({
      name: "wagering_lock_conflicts_total",
      help: "Total database lock/unique conflicts handled",
      labelNames: ["operation"],
      registers: [this.registry],
    });

    this.reconciliationDivergencesTotal = new Counter({
      name: "wagering_reconciliation_divergences_total",
      help: "Total wallet reconciliation divergences detected",
      registers: [this.registry],
    });

    this.outboxLagSeconds = new Gauge({
      name: "wagering_outbox_lag_seconds",
      help: "Age in seconds of the oldest unpublished outbox message",
      registers: [this.registry],
    });

    this.processingLatencyMs = new Histogram({
      name: "wagering_processing_latency_ms",
      help: "Transaction processing latency in milliseconds",
      labelNames: ["operation"],
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
      registers: [this.registry],
    });
  }

  async getMetricsSnapshot(): Promise<string> {
    return this.registry.metrics();
  }
}
