import { bagOfWords, tokenize, type CorpusChunk } from './corpus.js';

export interface RetrievedChunk {
  id: string;
  source: string;
  text: string;
  score: number;
}

/**
 * In-memory bag-of-words cosine similarity retrieval.
 * No vector DB — suitable for small fixture corpora.
 */
export function retrieve(
  query: string,
  corpus: CorpusChunk[],
  topK = 3,
): RetrievedChunk[] {
  const qVec = bagOfWords(tokenize(query));
  if (qVec.size === 0) return [];

  const scored = corpus
    .map((chunk) => ({
      id: chunk.id,
      source: chunk.source,
      text: chunk.text,
      score: cosineSimilarity(qVec, chunk.tokens),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

export function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [, v] of a) normA += v * v;
  for (const [, v] of b) normB += v * v;

  if (normA === 0 || normB === 0) return 0;

  for (const [term, av] of a) {
    const bv = b.get(term);
    if (bv !== undefined) dot += av * bv;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Keyword / token overlap ratio of answer tokens found in context (0–1). */
export function groundednessScore(answer: string, context: string): number {
  const answerTokens = new Set(tokenize(answer));
  if (answerTokens.size === 0) return 0;
  const contextTokens = new Set(tokenize(context));
  let hit = 0;
  for (const t of answerTokens) {
    if (contextTokens.has(t)) hit += 1;
  }
  return hit / answerTokens.size;
}

/** Jaccard-like keyword overlap between two strings (0–1). */
export function keywordOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
  }
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}
