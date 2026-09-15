import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  LlmProvider,
} from './types.js';

/**
 * Optional OpenAI Chat Completions provider.
 * Only used when OPENAI_API_KEY is set and LLM_PROVIDER=openai.
 */
export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = 'gpt-4o-mini') {
    if (!apiKey) {
      throw new Error('OpenAIProvider requires OPENAI_API_KEY');
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
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
