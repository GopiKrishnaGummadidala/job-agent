import Anthropic from '@anthropic-ai/sdk';
import { BadGatewayException, BadRequestException, ConflictException, HttpException, Injectable } from '@nestjs/common';
import { config } from '../config';
import { Db } from '../db';
import { loadSettings } from '../profile';

export interface AiRequest {
  task: 'assess' | 'cover_letter';
  promptVersion: string;
  system: string;
  user: string;
  maxTokens: number;
  expectedModel?: { provider: string; model: string };
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
      paidEnabled: config.paidAiEnabled,
      openai: { configured: !!config.openaiApiKey, baseUrl: config.openaiBaseUrl },
      anthropic: { configured: !!process.env.ANTHROPIC_API_KEY, models: ANTHROPIC_MODELS },
    };
  }

  async run(userId: string, req: AiRequest): Promise<AiResult> {
    const settings = await this.db.asUser(userId, (q) => loadSettings(q, userId));
    const provider: string = settings.ai_provider;
    const model: string = settings.ai_model;
    if (req.expectedModel && (provider !== req.expectedModel.provider || model !== req.expectedModel.model)) {
      throw new ConflictException('AI settings changed. Run the assessment again.');
    }
    if (provider === 'none') throw new BadRequestException('No AI provider is configured. Choose one in Settings.');
    if (!model) throw new BadRequestException('Choose an AI model in Settings.');

    const reservation = provider === 'ollama' ? null : await this.reserveBudget(userId, provider, model, req);

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

    await this.db.asUser(userId, async (q) => {
      if (reservation) await q('select pg_advisory_xact_lock(hashtextextended($1, 131))', [userId]);
      await q(
        `insert into ai_usage (user_id, provider, model, task, prompt_version, input_tokens, output_tokens, est_cost_usd)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, provider, model, req.task, req.promptVersion, out.inputTokens, out.outputTokens, out.costUsd],
      );
      if (reservation) await q('delete from ai_budget_reservations where id = $1', [reservation]);
    });
    return { text: out.text.trim(), provider, model, costUsd: out.costUsd };
  }

  private async reserveBudget(userId: string, provider: string, model: string, req: AiRequest) {
    if (!config.paidAiEnabled) throw new BadRequestException('Paid AI calls are disabled on this server.');
    const prices = provider === 'openai' ? [config.openaiPriceIn, config.openaiPriceOut] : ANTHROPIC_PRICES[model];
    if (!prices?.every((price) => Number.isFinite(price) && price > 0)) {
      throw new BadRequestException('Configure AI usage prices before using this paid model.');
    }
    // Use UTF-8 byte length as a conservative input estimate and reserve the full output limit.
    const estimated = ((Buffer.byteLength(req.system + req.user) + 128) * prices[0] + req.maxTokens * prices[1]) / 1_000_000;
    return this.db.asUser(userId, async (q) => {
      await q('select pg_advisory_xact_lock(hashtextextended($1, 131))', [userId]);
      const settings = await loadSettings(q, userId);
      if (settings.ai_provider !== provider || settings.ai_model !== model) throw new ConflictException('AI settings changed. Try again.');
      await q('delete from ai_budget_reservations where expires_at <= now()');
      const [usage] = await q(
        `with boundaries as (
           select date_trunc('day', now(), 'Europe/Berlin') as today,
                  date_trunc('month', now(), 'Europe/Berlin') as month
         )
         select coalesce(sum(est_cost_usd) filter (where at >= today), 0)::float as daily,
                coalesce(sum(est_cost_usd), 0)::float as monthly,
                (select coalesce(sum(estimated_usd), 0)::float from ai_budget_reservations) as reserved
         from ai_usage cross join boundaries where at >= month`,
      );
      if (usage.daily + usage.reserved + estimated > settings.daily_budget_usd) {
        throw new HttpException('This request would exceed your daily AI budget.', 402);
      }
      if (usage.monthly + usage.reserved + estimated > settings.monthly_budget_usd) {
        throw new HttpException('This request would exceed your monthly AI budget.', 402);
      }
      const [row] = await q('insert into ai_budget_reservations (user_id,estimated_usd) values ($1,$2) returning id', [userId, estimated]);
      return row.id as string;
    });
  }

  private async ollama(model: string, req: AiRequest) {
    const res = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      redirect: 'error',
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
