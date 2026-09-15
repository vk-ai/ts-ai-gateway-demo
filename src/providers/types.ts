/**
 * Shared LLM provider contract.
 * Implementations: MockProvider (default, offline) and OpenAIProvider (optional).
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  provider: string;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}
