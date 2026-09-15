import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { handleChat } from '../src/chat.js';
import { MockProvider } from '../src/providers/mock.js';
import { loadCorpus } from '../src/rag/corpus.js';
import { groundednessScore, keywordOverlap } from '../src/rag/retrieve.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

describe('groundedness / keyword overlap evals (mock only)', () => {
  it('computes high groundedness when answer reuses context tokens', () => {
    const context =
      'Standard ground shipping takes 3–5 business days within the contiguous United States.';
    const answer =
      'Based on documentation: standard ground shipping takes 3–5 business days.';
    expect(groundednessScore(answer, context)).toBeGreaterThan(0.5);
  });

  it('computes low groundedness for unrelated answer', () => {
    const context = 'Orders ship the same business day before 2 PM.';
    const answer = 'Quantum flux capacitors require dilithium crystals.';
    expect(groundednessScore(answer, context)).toBeLessThan(0.2);
  });

  it('keywordOverlap rewards shared terms', () => {
    expect(
      keywordOverlap('free shipping over fifty dollars', 'free shipping applies over $50'),
    ).toBeGreaterThan(0.2);
  });

  it('end-to-end mock chat is grounded on shipping question', async () => {
    const corpus = await loadCorpus(dataDir);
    const provider = new MockProvider();
    const result = await handleChat(provider, corpus, {
      message: 'Is free shipping available on large orders?',
      topK: 3,
    });

    expect(result.provider).toBe('mock');
    expect(result.retrieved.length).toBeGreaterThan(0);
    expect(result.answer.length).toBeGreaterThan(20);
    expect(result.metrics.groundedness).toBeGreaterThan(0.35);

    const contextBlob = result.retrieved.map((r) => r.text).join(' ');
    expect(keywordOverlap(result.answer, contextBlob)).toBeGreaterThan(0.1);
  });

  it('end-to-end mock chat retrieves returns policy for refund question', async () => {
    const corpus = await loadCorpus(dataDir);
    const provider = new MockProvider();
    const result = await handleChat(provider, corpus, {
      message: 'How long do refunds take after a return?',
    });

    expect(result.retrieved.some((r) => /return/i.test(r.source))).toBe(true);
    expect(result.metrics.groundedness).toBeGreaterThan(0.3);
    expect(result.answer.toLowerCase()).toMatch(/refund|return|business/);
  });

  it('empty message is rejected', async () => {
    const corpus = await loadCorpus(dataDir);
    const provider = new MockProvider();
    await expect(handleChat(provider, corpus, { message: '  ' })).rejects.toThrow(
      /message is required/i,
    );
  });
});
