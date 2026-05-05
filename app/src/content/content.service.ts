import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { DraftStatus, TrendTopic } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { PolicyService } from '../policy/policy.service';
import { AuditService } from '../audit/audit.service';
import { calculateContentSimilarity } from '../common/utils/content-similarity.util';

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly llmService: LlmService,
    private readonly policyService: PolicyService,
    private readonly auditService: AuditService,
  ) {}

  async generateDraftsForTrends(
    trends: TrendTopic[],
  ): Promise<{ createdDraftIds: string[]; autoApprovedDraftIds: string[] }> {
    const createdDraftIds: string[] = [];
    const autoApprovedDraftIds: string[] = [];
    const processedSymbols = new Set<string>();
    const minAutoApprovalScore = this.configService.getOrThrow<number>(
      'AUTO_APPROVAL_MIN_SCORE',
    );
    const promptVersion = this.configService.getOrThrow<string>(
      'CONTENT_PROMPT_VERSION',
    );
    const disclosureVersion = this.configService.getOrThrow<string>(
      'CONTENT_DISCLOSURE_VERSION',
    );
    const maxVariationAttempts = this.configService.getOrThrow<number>(
      'CONTENT_VARIATION_MAX_ATTEMPTS',
    );
    const maxSimilarity = this.configService.getOrThrow<number>(
      'CONTENT_MAX_SIMILARITY',
    );

    const prioritizedTrends = [...trends].sort((a, b) => b.score - a.score);
    for (const trend of prioritizedTrends) {
      if (processedSymbols.has(trend.symbol)) {
        continue;
      }
      processedSymbols.add(trend.symbol);

      const evidenceEventIds = this.extractEvidenceIds(trend.evidence);
      const evidenceEvents = await this.prisma.sourceEvent.findMany({
        where: {
          id: {
            in: evidenceEventIds,
          },
        },
        take: 6,
      });

      const recentDraftBodies = await this.prisma.contentDraft.findMany({
        where: {
          trendTopic: {
            symbol: trend.symbol,
          },
        },
        select: {
          body: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 12,
      });

      const evidenceSummary = evidenceEvents.map(
        (event) => `${event.source}: ${event.body.slice(0, 120)}`,
      );

      let accepted:
        | {
            generated: Awaited<ReturnType<LlmService['generateDraft']>>;
            policy: ReturnType<PolicyService['evaluateDraft']>;
            contentHash: string;
          }
        | null = null;

      for (let attempt = 0; attempt < maxVariationAttempts; attempt += 1) {
        const generated = await this.llmService.generateDraft({
          symbol: trend.symbol,
          assetClass: trend.assetClass,
          score: trend.score,
          mentionCount: trend.mentionCount,
          evidenceSummary,
        });
        const policy = this.policyService.evaluateDraft(generated.body);
        const contentHash = this.hashContent(generated.title, policy.body);

        const exactDuplicate = await this.prisma.contentDraft.findUnique({
          where: { contentHash },
        });
        if (exactDuplicate) {
          continue;
        }

        const tooSimilar = recentDraftBodies.some((row) => {
          return calculateContentSimilarity(row.body, policy.body) >= maxSimilarity;
        });
        if (tooSimilar) {
          continue;
        }

        accepted = {
          generated,
          policy,
          contentHash,
        };
        break;
      }

      if (!accepted) {
        continue;
      }

      const { generated, policy, contentHash } = accepted;
      const autoApproved =
        policy.autoApproved && trend.score >= minAutoApprovalScore;

      const row = await this.prisma.contentDraft.create({
        data: {
          trendTopicId: trend.id,
          title: generated.title,
          body: policy.body,
          disclaimer: 'For informational purposes only. Not financial advice.',
          riskLevel: policy.riskLevel,
          policyFlags: policy.flags,
          provider: generated.provider,
          model: generated.model,
          promptVersion,
          disclosureVersion,
          status: autoApproved
            ? DraftStatus.AUTO_APPROVED
            : DraftStatus.FLAGGED,
          contentHash,
          approvedAt: autoApproved ? new Date() : null,
        },
      });

      createdDraftIds.push(row.id);
      if (autoApproved) {
        autoApprovedDraftIds.push(row.id);
      }

      await this.auditService.record('draft.created', 'draft', row.id, {
        symbol: trend.symbol,
        trendScore: trend.score,
        minAutoApprovalScore,
        policyAutoApproved: policy.autoApproved,
        riskLevel: row.riskLevel,
        disclosureVersion: row.disclosureVersion,
        status: row.status,
      });
    }

    return { createdDraftIds, autoApprovedDraftIds };
  }

  async listDrafts(status?: DraftStatus): Promise<
    Array<{
      id: string;
      symbol: string;
      status: DraftStatus;
      riskLevel: string;
      disclosureVersion: string;
      createdAt: Date;
      body: string;
    }>
  > {
    const rows = await this.prisma.contentDraft.findMany({
      where: status ? { status } : undefined,
      include: {
        trendTopic: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 100,
    });

    return rows.map((row) => ({
      id: row.id,
      symbol: row.trendTopic.symbol,
      status: row.status,
      riskLevel: row.riskLevel,
      disclosureVersion: row.disclosureVersion,
      createdAt: row.createdAt,
      body: row.body,
    }));
  }

  async approveDraft(draftId: string): Promise<void> {
    await this.prisma.contentDraft.update({
      where: { id: draftId },
      data: {
        status: DraftStatus.AUTO_APPROVED,
        approvedAt: new Date(),
      },
    });

    await this.auditService.record('draft.approved', 'draft', draftId, {});
  }

  private hashContent(title: string, body: string): string {
    return createHash('sha256').update(`${title}\n${body}`).digest('hex');
  }

  private extractEvidenceIds(evidence: unknown): string[] {
    if (!evidence || typeof evidence !== 'object') {
      return [];
    }
    const eventIds = (evidence as { eventIds?: string[] }).eventIds ?? [];
    return Array.isArray(eventIds) ? eventIds : [];
  }
}
