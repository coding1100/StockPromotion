import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AccountPlatform } from '@prisma/client';
import { AccountsService } from './accounts.service';

@Controller('accounts')
@ApiTags('accounts')
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get()
  async listAccounts(@Query('platform') platform?: string) {
    return this.accountsService.listAccountsDashboard(parsePlatform(platform));
  }

  @Patch(':id/quarantine')
  async quarantineAccount(
    @Param('id') accountId: string,
    @Body() body: { reason?: string },
  ): Promise<{ quarantined: boolean }> {
    await this.accountsService.quarantineAccount(
      accountId,
      body.reason?.trim() || 'Manual quarantine requested',
    );
    return { quarantined: true };
  }

  @Post(':id/replacement-request')
  async requestReplacement(
    @Param('id') accountId: string,
    @Body() body: { notes?: string },
  ): Promise<{ requested: boolean }> {
    await this.accountsService.requestReplacement(accountId, body.notes);
    return { requested: true };
  }

  @Post('replacement')
  async activateReplacement(
    @Body()
    body: {
      platform: AccountPlatform;
      accountHandle: string;
      secretRef: string;
      username?: string;
    },
  ): Promise<{ activated: boolean }> {
    await this.accountsService.activateReplacement(body);
    return { activated: true };
  }
}

function parsePlatform(value?: string): AccountPlatform | undefined {
  if (!value) {
    return undefined;
  }
  return value.toUpperCase() === AccountPlatform.TELEGRAM
    ? AccountPlatform.TELEGRAM
    : value.toUpperCase() === AccountPlatform.STOCKTWITS
      ? AccountPlatform.STOCKTWITS
      : undefined;
}
