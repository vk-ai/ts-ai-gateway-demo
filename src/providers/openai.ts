import { ProviderError, providerErrorFromResponse } from './errors.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  LlmProvider,
} from './types.js';

/**
 * Optional OpenAI Chat Completions provider.
 * Only used when OPENAI_API_KEY is set and LLM_PROVIDER=openai (or listed in LLM_FALLBACKS).
 * Non-2xx responses throw ProviderError (status + parsed Retry-After) so the
 * FallbackProvider can decide retry vs fallback. `OPENAI_BASE_URL` lets you point it
 * at any OpenAI-compatible server (e.g. a local stub with fault injection).
 */
export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model = 'gpt-4o-mini', baseUrl = 'https://api.openai.com/v1') {
    if (!apiKey) {
      throw new Error('OpenAIProvider requires OPENAI_API_KEY');
    }
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens ?? 512,
        }),
        signal: request.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      throw new ProviderError(`${this.name} ${aborted ? 'request aborted' : 'network error'}: ${msg}`, {
        provider: this.name,
        kind: aborted ? 'timeout' : 'network',
      });
    }

    if (!res.ok) {
      throw await providerErrorFromResponse(this.name, res);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('OpenAI returned empty content');
    }

    return {
      content,
      provider: this.name,
      model: this.model,
    };
  }
}
