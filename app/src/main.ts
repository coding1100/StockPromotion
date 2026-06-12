import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerEnabled =
    process.env.SWAGGER_ENABLED === 'true' ||
    process.env.NODE_ENV !== 'production';
  if (swaggerEnabled) {
    const adminApiKey = process.env.ADMIN_API_KEY?.trim() ?? '';
    app.use('/api/docs', (req: Request, res: Response, next: NextFunction) => {
      if (!adminApiKey) {
        return next();
      }

      const provided = String(req.headers['x-api-key'] ?? '');
      const providedBuffer = Buffer.from(provided);
      const expectedBuffer = Buffer.from(adminApiKey);
      if (
        providedBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(providedBuffer, expectedBuffer)
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      return next();
    });

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Stock Promotion Automation API')
      .setDescription('Phase 1 automation APIs')
      .setVersion('1.0.0')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.get('/', (_req: Request, res: Response) => {
    res.redirect(302, '/api/manual-ui');
  });

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.LISTEN_HOST ?? '0.0.0.0';
  await app.listen(port, host);
}
void bootstrap();
