import { Module } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { StocktwitsComplianceService } from './stocktwits-compliance.service';
import { PostingPolicyService } from './posting-policy.service';

@Module({
  providers: [PolicyService, StocktwitsComplianceService, PostingPolicyService],
  exports: [PolicyService, StocktwitsComplianceService, PostingPolicyService],
})
export class PolicyModule {}
