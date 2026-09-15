import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../src/rag/corpus.js';
import { cosineSimilarity, retrieve } from '../src/rag/retrieve.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

describe('RAG retrieval (bag-of-words cosine)', () => {
  it('loads fixture corpus offline', async () => {
    const corpus = await loadCorpus(dataDir);
    expect(corpus.length).toBeGreaterThan(3);
    expect(corpus.every((c) => c.text.length > 0)).toBe(true);
  });

  it('ranks shipping queries toward shipping-policy', async () => {
    const corpus = await loadCorpus(dataDir);
    const hits = retrieve('How long does standard ground shipping take?', corpus, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toMatch(/shipping/i);
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('ranks returns queries toward returns doc', async () => {
    const corpus = await loadCorpus(dataDir);
    const hits = retrieve('What is the return window for unused items?', corpus, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toMatch(/return/i);
  });

  it('cosine similarity is 1 for identical vectors', () => {
    const v = new Map([
      ['shipping', 2],
      ['days', 1],
    ]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('cosine similarity is 0 for disjoint vectors', () => {
    const a = new Map([['alpha', 1]]);
    const b = new Map([['beta', 1]]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});
