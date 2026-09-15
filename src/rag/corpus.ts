import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CorpusChunk {
  id: string;
  source: string;
  text: string;
  tokens: Map<string, number>;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'has', 'have', 'been', 'from', 'they', 'this',
  'that', 'with', 'will', 'your', 'what', 'when', 'how', 'who', 'into', 'than',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function bagOfWords(tokens: string[]): Map<string, number> {
  const bag = new Map<string, number>();
  for (const t of tokens) {
    bag.set(t, (bag.get(t) ?? 0) + 1);
  }
  return bag;
}

/** Split a document into roughly paragraph-sized chunks. */
export function chunkDocument(source: string, content: string): CorpusChunk[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: CorpusChunk[] = [];
  let idx = 0;
  for (const para of paragraphs) {
    // Further split very long paragraphs by sentence groups.
    const pieces =
      para.length > 600
        ? para.match(/.{1,500}(?:[.!?]|$)/gs) ?? [para]
        : [para];
    for (const piece of pieces) {
      const text = piece.trim();
      if (!text) continue;
      const tokens = bagOfWords(tokenize(text));
      chunks.push({
        id: `${source}#${idx}`,
        source,
        text,
        tokens,
      });
      idx += 1;
    }
  }
  return chunks;
}

export function defaultDataDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/rag -> ../../data  (or dist/rag -> ../../data)
  return path.resolve(here, '..', '..', 'data');
}

export async function loadCorpus(dataDir: string = defaultDataDir()): Promise<CorpusChunk[]> {
  const entries = await readdir(dataDir);
  const files = entries.filter((f) => /\.(md|txt)$/i.test(f)).sort();
  const chunks: CorpusChunk[] = [];

  for (const file of files) {
    const full = path.join(dataDir, file);
    const content = await readFile(full, 'utf8');
    chunks.push(...chunkDocument(file, content));
  }

  if (chunks.length === 0) {
    throw new Error(`No corpus documents found in ${dataDir}`);
  }
  return chunks;
}
