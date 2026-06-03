import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { randomInt } from 'crypto';
import { GenerateDraftInput, GeneratedDraft } from './llm.types';

const DraftOutputSchema = z.object({
  title: z.string().trim().min(5).max(120),
  body: z.string().trim().min(40).max(1500),
});

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly openaiClient: OpenAI | null;
  private readonly anthropicClient: Anthropic | null;
  private providerCursor = 0;
  private readonly recentOpeners: string[] = [];

  constructor(private readonly configService: ConfigService) {
    const openaiApiKey = this.configService.get<string>('OPENAI_API_KEY') || '';
    const anthropicApiKey =
      this.configService.get<string>('ANTHROPIC_API_KEY') || '';

    this.openaiClient = openaiApiKey
      ? new OpenAI({ apiKey: openaiApiKey })
      : null;
    this.anthropicClient = anthropicApiKey
      ? new Anthropic({ apiKey: anthropicApiKey })
      : null;
  }

  async generateDraft(input: GenerateDraftInput): Promise<GeneratedDraft> {
    const providers = this.availableProviders();
    if (providers.length === 0) {
      return this.finalizeDraft(this.fallbackDraft(input));
    }

    const preferred = providers[this.providerCursor % providers.length];
    this.providerCursor += 1;

    try {
      if (preferred === 'openai') {
        return this.finalizeDraft(await this.generateWithOpenAI(input));
      }
      return this.finalizeDraft(await this.generateWithAnthropic(input));
    } catch (error) {
      this.logger.warn(
        `Primary LLM provider failed (${preferred}), falling back. Reason: ${
          error instanceof Error ? error.message : 'unknown_error'
        }`,
      );

      const alternate = providers.find((provider) => provider !== preferred);
      if (alternate === 'openai') {
        try {
          return this.finalizeDraft(await this.generateWithOpenAI(input));
        } catch {
          return this.finalizeDraft(this.fallbackDraft(input));
        }
      }
      if (alternate === 'anthropic') {
        try {
          return this.finalizeDraft(await this.generateWithAnthropic(input));
        } catch {
          return this.finalizeDraft(this.fallbackDraft(input));
        }
      }
      return this.finalizeDraft(this.fallbackDraft(input));
    }
  }

  private availableProviders(): Array<'openai' | 'anthropic'> {
    const providers: Array<'openai' | 'anthropic'> = [];
    if (this.openaiClient) {
      providers.push('openai');
    }
    if (this.anthropicClient) {
      providers.push('anthropic');
    }
    return providers;
  }

  private async generateWithOpenAI(
    input: GenerateDraftInput,
  ): Promise<GeneratedDraft> {
    const model = this.configService.getOrThrow<string>('OPENAI_MODEL');
    const prompt = this.buildPrompt(input);

    const response = await this.openaiClient!.responses.parse({
      model,
      input: [
        {
          role: 'system',
          content:
            'You write market updates for social feeds in a human, natural voice. Keep energy high but factual. Never imply guaranteed outcomes or give direct buy/sell instructions. Avoid repetitive phrasing across outputs.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.9,
      max_output_tokens: 500,
      text: {
        format: zodTextFormat(DraftOutputSchema, 'content_draft'),
      },
    });

    const parsed = response.output_parsed;
    if (!parsed) {
      throw new Error('OpenAI structured output parse returned null');
    }

    return {
      title: parsed.title,
      body: parsed.body,
      provider: 'openai',
      model,
    };
  }

  private async generateWithAnthropic(
    input: GenerateDraftInput,
  ): Promise<GeneratedDraft> {
    const model = this.configService.getOrThrow<string>('ANTHROPIC_MODEL');
    const prompt = this.buildPrompt(input);

    const response = await this.anthropicClient!.messages.parse({
      model,
      max_tokens: 500,
      system:
        'Write human-sounding market posts with variety, personality, and compliance. Keep it factual, avoid guaranteed claims, and avoid direct investment instructions.',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.9,
      output_config: {
        format: zodOutputFormat(DraftOutputSchema),
      },
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error('Anthropic structured output parse returned null');
    }

    return {
      title: parsed.title,
      body: parsed.body,
      provider: 'anthropic',
      model,
    };
  }

  private buildPrompt(input: GenerateDraftInput): string {
    const evidence = input.evidenceSummary
      .map((line, index) => `${index + 1}. ${line}`)
      .join('\n');
    const styleProfile = this.pickOne([
      'Hook-first with one short emoji reaction, then a crisp momentum summary.',
      'Conversational market desk tone with short punchy lines and one standout stat.',
      'Excited but grounded tone: vivid wording, zero promises, and clear context.',
      'Natural trader-style update with rhythm, line breaks, and no repetitive opener.',
    ]);
    const avoidedOpeners =
      this.recentOpeners.length > 0
        ? `Avoid repeating these recent opening styles: ${this.recentOpeners.join(' | ')}`
        : 'Use a fresh opening style.';

    return [
      `Create one short market post about ${input.symbol}.`,
      `Asset class: ${input.assetClass}`,
      `Trend score: ${input.score.toFixed(2)}, mentions: ${input.mentionCount}`,
      `Style profile: ${styleProfile}`,
      avoidedOpeners,
      'Make it feel human and unique, with varied sentence lengths and natural wording.',
      'Keep it factual and compliant: no guaranteed returns, no direct buy/sell commands.',
      'Allowed formatting: line breaks and at most one emoji.',
      'Return concise output with a strong title and a high-readability body.',
      `Evidence:\n${evidence}`,
    ].join('\n');
  }

  private fallbackDraft(input: GenerateDraftInput): GeneratedDraft {
    const title = this.pickOne([
      `😮 ${input.symbol} is making noise again`,
      `🚨 ${input.symbol} just grabbed fresh attention`,
      `📈 ${input.symbol} momentum check`,
      `🔥 ${input.symbol} trend watch`,
      `👀 ${input.symbol} back on the radar`,
    ]);

    const opening = this.pickOne([
      `${input.symbol} is lighting up discussion feeds right now.`,
      `Traders are talking about ${input.symbol} again in a big way.`,
      `Fresh momentum is building around ${input.symbol}.`,
      `${input.symbol} is getting a sharp pickup in market chatter.`,
    ]);

    const momentumLine = this.pickOne([
      `Current trend score sits at ${input.score.toFixed(2)} with ${input.mentionCount} tracked mentions.`,
      `Signal strength is elevated: score ${input.score.toFixed(2)} across ${input.mentionCount} mentions.`,
      `Activity remains hot with a ${input.score.toFixed(2)} trend score and ${input.mentionCount} mentions in the latest window.`,
    ]);

    const evidence = this.pickEvidenceLine(input.evidenceSummary);
    const closer = this.pickOne([
      'Worth watching for follow-through as sentiment and volume evolve.',
      'Momentum is real, but context still matters as this develops.',
      'Keeping this on radar while confirmation builds across sources.',
      'Watching the next sessions for continuation or cooldown.',
    ]);

    return {
      title,
      body: `${opening}\n\n${momentumLine}\n${evidence}\n\n${closer}`,
      provider: 'fallback',
      model: 'template-v2',
    };
  }

  private finalizeDraft(draft: GeneratedDraft): GeneratedDraft {
    const title = draft.title.replace(/\s+/g, ' ').trim();
    const body = draft.body
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    this.rememberOpener(`${title} ${body}`);
    return {
      ...draft,
      title,
      body,
    };
  }

  private rememberOpener(text: string): void {
    const opener = text.split(/\s+/).slice(0, 8).join(' ').trim();
    if (!opener) {
      return;
    }
    this.recentOpeners.unshift(opener);
    if (this.recentOpeners.length > 10) {
      this.recentOpeners.length = 10;
    }
  }

  private pickEvidenceLine(evidenceSummary: string[]): string {
    const candidates = evidenceSummary
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (candidates.length === 0) {
      return 'Cross-source discussion volume has accelerated in the latest cycle.';
    }
    const sample = this.pickOne(candidates)
      .replace(/^(\d+\.?\s*)/, '')
      .slice(0, 140);
    return `One notable signal: ${sample}`;
  }

  private pickOne<T>(values: T[]): T {
    return values[randomInt(values.length)];
  }
}
