import { describe, expect, it } from 'vitest';
import { groupBy, histogram, median, percentileSorted, summarize, toUsd } from '../src/lib/stats';

describe('percentileSorted', () => {
  it('matches Excel PERCENTILE.INC on a known list', () => {
    const xs = [10, 20, 30, 40, 50];
    expect(percentileSorted(xs, 0)).toBe(10);
    expect(percentileSorted(xs, 0.25)).toBe(20);
    expect(percentileSorted(xs, 0.5)).toBe(30);
    expect(percentileSorted(xs, 1)).toBe(50);
  });

  it('interpolates between values', () => {
    expect(percentileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileSorted([100, 200], 0.25)).toBe(125);
  });

  it('rejects empty input and invalid p', () => {
    expect(() => percentileSorted([], 0.5)).toThrow();
    expect(() => percentileSorted([1], 1.5)).toThrow();
  });
});

describe('median', () => {
  it('does not require sorted input or mutate it', () => {
    const xs = [5, 1, 3];
    expect(median(xs)).toBe(3);
    expect(xs).toEqual([5, 1, 3]);
  });
});

describe('summarize', () => {
  it('returns null for no data', () => {
    expect(summarize([])).toBeNull();
  });

  it('computes all summary fields', () => {
    expect(summarize([40, 10, 30, 20])).toEqual({
      count: 4, min: 10, p25: 17.5, median: 25, p75: 32.5, max: 40, mean: 25, total: 100,
    });
  });
});

describe('histogram', () => {
  it('buckets values with an open-ended last bucket', () => {
    const buckets = histogram([5, 15, 15, 25, 999], 10, 3);
    expect(buckets.map((b) => b.count)).toEqual([1, 2, 2]);
    expect(buckets[2]!.to).toBe(Infinity);
  });

  it('handles empty input and rejects bad bucket size', () => {
    expect(histogram([], 10)).toEqual([]);
    expect(() => histogram([1], 0)).toThrow();
  });
});

describe('toUsd', () => {
  it('divides by units-per-USD', () => {
    expect(toUsd(835_000, 83.5)).toBe(10_000);
  });
});

describe('groupBy', () => {
  it('groups preserving order', () => {
    const g = groupBy(['apple', 'avocado', 'banana'], (s) => s[0]!);
    expect(g.get('a')).toEqual(['apple', 'avocado']);
    expect(g.get('b')).toEqual(['banana']);
  });
});
