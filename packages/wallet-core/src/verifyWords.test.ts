import { describe, expect, it } from 'vitest';
import { verifyRetypedPhrase, verifyWordInputs } from './verifyWords.js';

const WORDS = ['abandon', 'ability', 'able'];

describe('verifyWordInputs', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(verifyWordInputs(WORDS, [{ index: 1, text: ' Ability ' }])).toEqual({ correct: true, firstMismatch: null });
  });

  it('reports the first wrong slot', () => {
    expect(verifyWordInputs(WORDS, [{ index: 0, text: 'abandon' }, { index: 2, text: 'abel' }])).toEqual({ correct: false, firstMismatch: 2 });
  });
});

describe('verifyRetypedPhrase', () => {
  it('accepts the whole phrase with any spacing', () => {
    expect(verifyRetypedPhrase(WORDS, '  abandon\nability   able ').correct).toBe(true);
  });

  it('rejects a missing, wrong or extra word', () => {
    expect(verifyRetypedPhrase(WORDS, 'abandon ability')).toEqual({ correct: false, firstMismatch: 2 });
    expect(verifyRetypedPhrase(WORDS, 'abandon able ability')).toEqual({ correct: false, firstMismatch: 1 });
    expect(verifyRetypedPhrase(WORDS, 'abandon ability able zoo')).toEqual({ correct: false, firstMismatch: 3 });
    expect(verifyRetypedPhrase(WORDS, '')).toEqual({ correct: false, firstMismatch: 0 });
  });
});
