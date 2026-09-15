import { describe, expect, it } from 'vitest';
import { createProvider, resolveProviderKind } from '../src/providers/index.js';
import { MockProvider } from '../src/providers/mock.js';

describe('providers', () => {
  it('defaults to mock without API keys', () => {
    expect(resolveProviderKind({})).toBe('mock');
    expect(resolveProviderKind({ LLM_PROVIDER: 'openai' })).toBe('mock');
    const p = createProvider('mock');
    expect(p).toBeInstanceOf(MockProvider);
    expect(p.name).toBe('mock');
  });

  it('mock complete is deterministic for same inputs', async () => {
    const p = new MockProvider();
    const req = {
      messages: [
        {
          role: 'system' as const,
          content:
            'Retrieved context:\nStandard ground shipping takes 3–5 business days.',
        },
        { role: 'user' as const, content: 'How long is ground shipping?' },
      ],
    };
    const a = await p.complete(req);
    const b = await p.complete(req);
    expect(a.content).toBe(b.content);
    expect(a.provider).toBe('mock');
    expect(a.model).toBe('mock-v1');
  });

  it('createProvider(openai) without key throws', () => {
    expect(() => createProvider('openai', {})).toThrow(/OPENAI_API_KEY/);
  });
});
