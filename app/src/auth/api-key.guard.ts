import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const adminApiKey =
      this.configService.get<string>('ADMIN_API_KEY')?.trim() ?? '';
    const nodeEnv = this.configService.get<string>('NODE_ENV') ?? 'development';

    if (!adminApiKey) {
      if (nodeEnv === 'production') {
        throw new ServiceUnavailableException(
          'ADMIN_API_KEY is required in production',
        );
      }
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const providedHeader = request.headers['x-api-key'];
    const provided =
      typeof providedHeader === 'string'
        ? providedHeader
        : Array.isArray(providedHeader)
          ? providedHeader[0]
          : '';

    if (!provided) {
      throw new UnauthorizedException('Missing x-api-key header');
    }

    if (!this.constantTimeCompare(provided, adminApiKey)) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }

  private constantTimeCompare(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
  }
}
