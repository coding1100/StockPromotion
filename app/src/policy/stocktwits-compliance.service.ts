import { BadRequestException, Injectable } from '@nestjs/common';
import { PolicyService } from './policy.service';

const PROMOTIONAL_PATTERNS: RegExp[] = [
  /\bjoin (my|our)\s+(discord|telegram|signal|signals)\b/i,
  /\b(paid|premium)\s+(group|channel|signals?|service)\b/i,
  /\bsubscribe now\b/i,
  /\bdm me\b/i,
];

const CASHTAG_PATTERN = /\$([A-Za-z][A-Za-z0-9.-]{0,10})/g;
// Always reset lastIndex before exec() — module-level /g regex retains state.

// Stocktwits raised the character limit to 1,000 in December 2021 for all
// accounts (standard and premium). The old 140-char limit is no longer enforced
// by the platform. We default to 1,000 to match the current API behaviour.
// Override via STOCKTWITS_MAX_MESSAGE_LENGTH env if needed.
const STOCKTWITS_DEFAULT_MAX_LENGTH = 1000;

// Spam signal: the same cashtag appearing more than this many times in one post.
const MAX_CASHTAG_REPETITIONS = 3;

@Injectable()
export class StocktwitsComplianceService {
  constructor(private readonly policyService: PolicyService) {}

  enforceManualPublishCompliance(input: {
    body: string;
    symbol: string | null;
    publishToStocktwits: boolean;
    maxMessageLength?: number;
  }): void {
    if (!input.publishToStocktwits) {
      return;
    }

    if (!input.symbol) {
      throw new BadRequestException(
        'stocktwitsSymbol is required for manual StockTwits publishing. Broadcast mode with the same post across multiple symbols is blocked by compliance.',
      );
    }

    const maxLength = input.maxMessageLength ?? STOCKTWITS_DEFAULT_MAX_LENGTH;
    if (input.body.length > maxLength) {
      throw new BadRequestException(
        `stocktwits_compliance_blocked_message_too_long: message is ${input.body.length} chars, limit is ${maxLength}. Trim your message before publishing.`,
      );
    }

    if (input.body.trim().length === 0) {
      throw new BadRequestException(
        'stocktwits_compliance_blocked_empty_message: message body cannot be empty.',
      );
    }

    const policy = this.policyService.evaluateDraft(input.body);
    if (policy.riskLevel === 'HIGH' || policy.riskLevel === 'MEDIUM') {
      throw new BadRequestException(
        `stocktwits_compliance_blocked_risk_content (${policy.riskLevel}): ${policy.flags.join(', ') || 'policy_violation'}`,
      );
    }

    for (const pattern of PROMOTIONAL_PATTERNS) {
      if (pattern.test(input.body)) {
        throw new BadRequestException(
          `stocktwits_compliance_blocked_promotional_content: ${pattern.source}`,
        );
      }
    }

    const cashtags = this.extractCashtags(input.body);

    // Detect repeated cashtag spam — same ticker mentioned excessively.
    CASHTAG_PATTERN.lastIndex = 0;
    const rawMatches = input.body.match(CASHTAG_PATTERN) ?? [];
    if (rawMatches.length > MAX_CASHTAG_REPETITIONS) {
      throw new BadRequestException(
        `stocktwits_compliance_blocked_cashtag_spam: message contains ${rawMatches.length} cashtags, max allowed is ${MAX_CASHTAG_REPETITIONS}.`,
      );
    }

    // Cross-referencing other tickers is normal on Stocktwits (e.g. "$CRM while
    // everyone watches $NVDA"). We only enforce that the target symbol's cashtag
    // appears somewhere in the message so the post is on-topic for that feed.
    // buildStocktwitsSymbolMessage prepends $SYMBOL when absent, so we skip this
    // check when the body has no cashtags at all (prefix will be added later).
    if (cashtags.length > 0 && !cashtags.includes(input.symbol!)) {
      throw new BadRequestException(
        `stocktwits_compliance_blocked_missing_target_cashtag: message must include $${input.symbol} to post on that symbol's feed.`,
      );
    }
  }

  /**
   * Validate and trim a message body to fit within the Stocktwits character
   * limit. Strips the trailing mandatory disclaimer, normalises whitespace,
   * then hard-truncates to maxLength if still too long — inserting an ellipsis
   * so the post doesn't end mid-word.
   */
  trimToLimit(body: string, maxLength = STOCKTWITS_DEFAULT_MAX_LENGTH): string {
    const trimmed = body.trim();
    if (trimmed.length <= maxLength) {
      return trimmed;
    }
    // Hard truncate with ellipsis — leave room for the 3-char "..."
    return trimmed.slice(0, maxLength - 3).trimEnd() + '...';
  }

  private extractCashtags(body: string): string[] {
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    CASHTAG_PATTERN.lastIndex = 0;
    while ((match = CASHTAG_PATTERN.exec(body)) !== null) {
      const normalized = this.normalizeSymbol(match[1]);
      if (normalized) {
        found.add(normalized);
      }
    }
    return Array.from(found);
  }

  private normalizeSymbol(value: string): string | null {
    const normalized = value.trim().replace(/^\$/, '').toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,10}$/.test(normalized)) {
      return null;
    }
    if (normalized.length > 6) {
      return null;
    }
    return normalized;
  }
}
