import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Module } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { HealthController } from '../src/health/health.controller';
import { OrchestrationController } from '../src/orchestration/orchestration.controller';
import { HealthService } from '../src/health/health.service';
import { OrchestrationService } from '../src/orchestration/orchestration.service';
import { PublishingService } from '../src/publishing/publishing.service';

@Module({
  controllers: [HealthController, OrchestrationController],
  providers: [
    {
      provide: HealthService,
      useValue: {
        getReadiness: jest.fn().mockResolvedValue({
          status: 'ok',
          checks: {
            database: 'up',
            redis: 'up',
          },
        }),
        getMetrics: jest.fn().mockReturnValue({}),
      },
    },
    {
      provide: OrchestrationService,
      useValue: {
        listTrends: jest
          .fn()
          .mockResolvedValue([{ symbol: 'AAPL', score: 10, mentionCount: 4 }]),
        listDrafts: jest.fn().mockResolvedValue([]),
        runPipeline: jest.fn().mockResolvedValue({ trigger: 'manual' }),
        enqueuePipelineRun: jest.fn().mockResolvedValue(undefined),
        approveDraft: jest.fn().mockResolvedValue(undefined),
      },
    },
    {
      provide: PublishingService,
      useValue: {
        listTelegramCandidates: jest.fn().mockResolvedValue([]),
        approveTelegramCandidate: jest.fn().mockResolvedValue(undefined),
        attemptApprovedTelegramJoins: jest.fn().mockResolvedValue(undefined),
        listPublishJobs: jest.fn().mockResolvedValue([]),
        getPublishJob: jest.fn().mockResolvedValue(null),
        retryPublishJob: jest.fn().mockResolvedValue(undefined),
      },
    },
  ],
})
class ControllerTestModule {}

describe('Controllers (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ControllerTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health/live (GET)', () => {
    return request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('/orchestration/trends (GET)', () => {
    return request(app.getHttpServer())
      .get('/orchestration/trends')
      .expect(200)
      .expect([{ symbol: 'AAPL', score: 10, mentionCount: 4 }]);
  });
});
