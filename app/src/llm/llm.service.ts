import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
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
      return this.fallbackDraft(input);
    }

    const preferred = providers[this.providerCursor % providers.length];
    this.providerCursor += 1;

    try {
      if (preferred === 'openai') {
        return await this.generateWithOpenAI(input);
      }
      return await this.generateWithAnthropic(input);
    } catch (error) {
      this.logger.warn(
        `Primary LLM provider failed (${preferred}), falling back. Reason: ${
          error instanceof Error ? error.message : 'unknown_error'
        }`,
      );

      const alternate = providers.find((provider) => provider !== preferred);
      if (alternate === 'openai') {
        try {
          return await this.generateWithOpenAI(input);
        } catch {
          return this.fallbackDraft(input);
        }
      }
      if (alternate === 'anthropic') {
        try {
          return await this.generateWithAnthropic(input);
        } catch {
          return this.fallbackDraft(input);
        }
      }
      return this.fallbackDraft(input);
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
            'You write educational finance content. Avoid hype and never imply guaranteed outcomes.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
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
        'Write educational, compliant finance content. Avoid investment guarantees and keep tone neutral.',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
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

    return [
      `Create one short educational post about ${input.symbol}.`,
      `Asset class: ${input.assetClass}`,
      `Trend score: ${input.score.toFixed(2)}, mentions: ${input.mentionCount}`,
      'Use neutral language and no financial advice.',
      'Return concise output with a clear title and a factual body.',
      `Evidence:\n${evidence}`,
    ].join('\n');
  }

  private fallbackDraft(input: GenerateDraftInput): GeneratedDraft {
    return {
      title: `${input.symbol} trend snapshot`,
      body: `Recent discussions around ${input.symbol} increased across monitored channels. This summary is informational only and highlights volume and sentiment shifts rather than investment advice.`,
      provider: 'fallback',
      model: 'template-v1',
    };
  }
}
