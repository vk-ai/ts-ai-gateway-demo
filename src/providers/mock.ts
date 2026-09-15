import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  LlmProvider,
} from './types.js';

/**
 * Deterministic offline provider for demos and CI.
 * Extracts key nouns from retrieved context and echoes a grounded answer.
 * Never calls the network.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = request.messages.find((m) => m.role === 'user')?.content ?? '';

    const contextBlock = extractContextBlock(system);
    const answer = buildGroundedAnswer(user, contextBlock);

    return {
      content: answer,
      provider: this.name,
      model: 'mock-v1',
    };
  }
}

function extractContextBlock(system: string): string {
  const marker = 'Retrieved context:';
  const idx = system.indexOf(marker);
  if (idx === -1) return system;
  return system.slice(idx + marker.length).trim();
}

function buildGroundedAnswer(question: string, context: string): string {
  if (!context.trim()) {
    return (
      'I do not have enough retrieved context to answer confidently. ' +
      'Please rephrase or ask about shipping, returns, products, or support hours.'
    );
  }

  // Prefer the most relevant sentence(s) that share tokens with the question.
  const qTokens = tokenize(question);
  const sentences = context
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  const scored = sentences
    .map((s) => ({
      text: s,
      score: overlapScore(qTokens, tokenize(s)),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // Fall back to first chunk of context so answers stay grounded.
    const snippet = context.replace(/\s+/g, ' ').trim().slice(0, 320);
    return `Based on the available documentation: ${snippet}`;
  }

  const top = scored.slice(0, 2).map((s) => s.text);
  return `Based on the retrieved documentation: ${top.join(' ')}`;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) {
    if (b.has(t)) n += 1;
  }
  return n;
}
