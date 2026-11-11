import Anthropic from '@anthropic-ai/sdk';
import { BadGatewayException, BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { config } from '../config';
import { Db } from '../db';
import { loadSettings } from '../profile';

export interface AiRequest {
  task: 'assess' | 'cover_letter';
  promptVersion: string;
  system: string;
  user: string;
  maxTokens: number;
}

export interface AiResult {
  text: string;
  provider: string;
  model: string;
  costUsd: number;
}

/** USD per million tokens [input, output]; used for budget tracking only. */
const ANTHROPIC_PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};
export const ANTHROPIC_MODELS = Object.keys(ANTHROPIC_PRICES);
/** Models that support server-side refusal fallbacks; a declined request is retried on a fallback model. */
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

@Injectable()
export class AiService {
  private anthropic?: Anthropic;

  constructor(private db: Db) {}

  async options() {
    let ollamaModels: string[] = [];
    let ollamaAvailable = false;
    try {
      const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        ollamaAvailable = true;
        ollamaModels = (((await res.json()) as any).models ?? []).map((m: any) => m.name);
      }
    } catch {
      // Ollama not running
    }
    return {
      ollama: { available: ollamaAvailable, models: ollamaModels },
      openai: { configured: !!config.openaiApiKey, baseUrl: config.openaiBaseUrl },
      anthropic: { configured: !!process.env.ANTHROPIC_API_KEY, models: ANTHROPIC_MODELS },
    };
  }

  async run(userId: string, req: AiRequest): Promise<AiResult> {
    const settings = await this.db.asUser(userId, (q) => loadSettings(q, userId));
    const provider: string = settings.ai_provider;
    const model: string = settings.ai_model;
    if (provider === 'none') throw new BadRequestException('No AI provider is configured. Choose one in Settings.');
    if (!model) throw new BadRequestException('Choose an AI model in Settings.');

    if (provider !== 'ollama') {
      const [{ spent }] = await this.db.asUser(userId, (q) =>
        q(`select coalesce(sum(est_cost_usd), 0)::float as spent from ai_usage where at >= date_trunc('month', now())`),
      );
      if (spent >= settings.monthly_budget_usd) {
        throw new HttpException(
          `Monthly AI budget of $${settings.monthly_budget_usd.toFixed(2)} reached. Raise it in Settings or switch to Ollama.`,
          402,
        );
      }
    }

    let out: { text: string; inputTokens: number; outputTokens: number; costUsd: number };
    try {
      out =
        provider === 'ollama'
          ? await this.ollama(model, req)
          : provider === 'openai'
            ? await this.openai(model, req)
            : await this.claude(model, req);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new BadGatewayException(`AI provider error (${provider}): ${(e as Error).message}`);
    }

    await this.db.asUser(userId, (q) =>
      q(
        `insert into ai_usage (user_id, provider, model, task, prompt_version, input_tokens, output_tokens, est_cost_usd)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, provider, model, req.task, req.promptVersion, out.inputTokens, out.outputTokens, out.costUsd],
      ),
    );
    return { text: out.text.trim(), provider, model, costUsd: out.costUsd };
  }

  private async ollama(model: string, req: AiRequest) {
    const res = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        options: { num_predict: req.maxTokens, temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as any;
    return {
      text: String(data.message?.content ?? ''),
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      costUsd: 0,
    };
  }

  /** Any OpenAI-compatible chat completions endpoint (OpenAI, Groq, OpenRouter, LM Studio, ...). */
  private async openai(model: string, req: AiRequest) {
    if (!config.openaiApiKey) throw new BadRequestException('OPENAI_API_KEY is not set on the server.');
    const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiApiKey}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: req.maxTokens,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as any;
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    return {
      text: String(data.choices?.[0]?.message?.content ?? ''),
      inputTokens,
      outputTokens,
      costUsd: (inputTokens * config.openaiPriceIn + outputTokens * config.openaiPriceOut) / 1e6,
    };
  }

  private async claude(model: string, req: AiRequest) {
    if (!process.env.ANTHROPIC_API_KEY) throw new BadRequestException('ANTHROPIC_API_KEY is not set on the server.');
    this.anthropic ??= new Anthropic();
    const params = {
      model,
      max_tokens: req.maxTokens,
      system: req.system,
      // Short, routine writing tasks: low effort keeps thinking (and cost) small.
      output_config: { effort: 'low' as const },
      messages: [{ role: 'user' as const, content: req.user }],
    };
    const msg: Anthropic.Message = FALLBACK_MODELS.has(model)
      ? ((await this.anthropic.beta.messages.create({
          ...params,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        } as any)) as unknown as Anthropic.Message)
      : await this.anthropic.messages.create(params);

    if (msg.stop_reason === 'refusal') throw new BadGatewayException('The model declined this request.');
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const [pin, pout] = ANTHROPIC_PRICES[model] ?? [4, 20];
    const inputTokens = msg.usage.input_tokens;
    const outputTokens = msg.usage.output_tokens;
    return { text, inputTokens, outputTokens, costUsd: (inputTokens * pin + outputTokens * pout) / 1e6 };
  }
}
