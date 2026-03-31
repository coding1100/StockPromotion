import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthService } from './health.service';
import { Public } from '../auth/public.decorator';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @SkipThrottle()
  @Get('live')
  getLiveness(): Record<string, string> {
    return { status: 'ok' };
  }

  @Public()
  @SkipThrottle()
  @Get('ready')
  async getReadiness(): Promise<Record<string, unknown>> {
    const readiness = await this.healthService.getReadiness();
    if (readiness.status !== 'ok') {
      throw new ServiceUnavailableException(readiness);
    }
    return readiness;
  }

  @Get('metrics')
  getMetrics(): Record<string, number> {
    return this.healthService.getMetrics();
  }
}
