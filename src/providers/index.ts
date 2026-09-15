import { MockProvider } from './mock.js';
import { OpenAIProvider } from './openai.js';
import type { LlmProvider } from './types.js';

export type { ChatMessage, ChatCompletionRequest, ChatCompletionResult, LlmProvider } from './types.js';
export { MockProvider } from './mock.js';
export { OpenAIProvider } from './openai.js';

export type ProviderKind = 'mock' | 'openai';

export function createProvider(
  kind: ProviderKind = 'mock',
  env: NodeJS.ProcessEnv = process.env,
): LlmProvider {
  if (kind === 'openai') {
    const key = env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        'LLM_PROVIDER=openai requires OPENAI_API_KEY. Use LLM_PROVIDER=mock for offline mode.',
      );
    }
    return new OpenAIProvider(key, env.OPENAI_MODEL ?? 'gpt-4o-mini');
  }
  return new MockProvider();
}

export function resolveProviderKind(env: NodeJS.ProcessEnv = process.env): ProviderKind {
  const raw = (env.LLM_PROVIDER ?? 'mock').toLowerCase();
  if (raw === 'openai' && env.OPENAI_API_KEY) return 'openai';
  return 'mock';
}
