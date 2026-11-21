import { describe, expect, it } from 'vitest';
import { usageDetail } from './usage-detail';

describe('usageDetail', () => {
  it('só chaves com valor > 0, na ordem, separadas por vírgula e espaço', () => {
    expect(usageDetail({ people: 3, exceptions: 0, scheduled: 2 })).toBe(
      'people=3, scheduled=2',
    );
    expect(usageDetail({ people: 3, exceptions: 1, scheduled: 2 })).toBe(
      'people=3, exceptions=1, scheduled=2',
    );
  });

  it('people=2 sozinho', () => {
    expect(usageDetail({ people: 2 })).toBe('people=2');
  });
});
