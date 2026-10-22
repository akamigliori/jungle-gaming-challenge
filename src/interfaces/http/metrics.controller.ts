import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '../../infrastructure/auth/public.decorator';
import { PrometheusMetrics } from '../../infrastructure/metrics/prometheus-metrics';

interface HttpResponse {
  setHeader(name: string, value: string): unknown;
}

/** Métricas desta instância no formato Prometheus: aberto, como os health checks. */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get()
  async scrape(@Res({ passthrough: true }) res: HttpResponse): Promise<string> {
    res.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.render();
  }
}
