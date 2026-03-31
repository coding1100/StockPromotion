import { Injectable } from '@nestjs/common';
import {
  HIGH_RISK_PATTERNS,
  MANDATORY_DISCLAIMER,
  MEDIUM_RISK_PATTERNS,
} from '../common/constants/policy.constants';
import { RiskLevel } from '@prisma/client';

export type PolicyResult = {
  body: string;
  riskLevel: RiskLevel;
  flags: string[];
  autoApproved: boolean;
};

@Injectable()
export class PolicyService {
  evaluateDraft(body: string): PolicyResult {
    const flags: string[] = [];
    let riskLevel: RiskLevel = RiskLevel.LOW;

    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(body)) {
        flags.push(`high:${pattern.source}`);
        riskLevel = RiskLevel.HIGH;
      }
    }

    if (riskLevel !== RiskLevel.HIGH) {
      for (const pattern of MEDIUM_RISK_PATTERNS) {
        if (pattern.test(body)) {
          flags.push(`medium:${pattern.source}`);
          riskLevel = RiskLevel.MEDIUM;
        }
      }
    }

    const withDisclaimer = body.includes(MANDATORY_DISCLAIMER)
      ? body
      : `${body}\n\n${MANDATORY_DISCLAIMER}`;

    return {
      body: withDisclaimer,
      riskLevel,
      flags,
      autoApproved: riskLevel === RiskLevel.LOW,
    };
  }
}
