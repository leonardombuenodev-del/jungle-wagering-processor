import { EntityManager } from "@mikro-orm/postgresql";
import { Controller, Get, HttpStatus, Inject, Req } from "@nestjs/common";
import type { Request } from "express";
import { SqsClientService } from "../../../infrastructure/messaging/sqs-client.service";
import { MetricsService } from "../../../infrastructure/observability/metrics.service";

@Controller()
export class HealthController {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SqsClientService) private readonly sqsClient: SqsClientService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  @Get("health/live")
  live() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("health/ready")
  async ready(@Req() req: Request) {
    let postgresUp = false;
    try {
      await this.em.getKnex().raw("SELECT 1");
      postgresUp = true;
    } catch {
      postgresUp = false;
    }

    const sqsUp = await this.sqsClient.checkHealth();
    const isReady = postgresUp && sqsUp;

    req.res?.status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: isReady ? "ready" : "degraded",
      dependencies: {
        postgres: postgresUp ? "up" : "down",
        sqs: sqsUp ? "up" : "down",
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get("metrics")
  async getMetrics(@Req() req: Request) {
    const snapshot = await this.metrics.getMetricsSnapshot();
    req.res?.setHeader("Content-Type", this.metrics.registry.contentType);
    req.res?.status(HttpStatus.OK);
    return snapshot;
  }
}
