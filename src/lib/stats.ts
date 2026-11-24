/**
 * Pure statistics helpers. The insights themselves are computed in SQLite (see
 * repositories/insights-repository.ts); these in-memory versions define the expected maths
 * (e.g. PERCENTILE.INC interpolation) and are the oracle the SQL implementation is tested against.
 */

export interface SummaryStats {
  count: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
  total: number;
}

/** Linear-interpolated percentile (same method as Excel PERCENTILE.INC). Input must be sorted ascending. */
export function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of empty list');
  if (p < 0 || p > 1) throw new Error('p must be within [0, 1]');
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo]!;
  const hiVal = sorted[hi]!;
  return loVal + (hiVal - loVal) * (idx - lo);
}

export function median(values: readonly number[]): number {
  return percentileSorted([...values].sort((a, b) => a - b), 0.5);
}

export interface HistogramBucket {
  from: number;
  to: number;
  count: number;
}

/** Fixed-width histogram starting at 0. The last bucket is open-ended (≥ from) so outliers don't stretch the chart. */
export function histogram(values: readonly number[], bucketSize: number, maxBuckets = 20): HistogramBucket[] {
  if (bucketSize <= 0) throw new Error('bucketSize must be positive');
  if (values.length === 0) return [];
  const highest = Math.max(...values);
  const bucketCount = Math.min(maxBuckets, Math.floor(highest / bucketSize) + 1);
  const buckets: HistogramBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    from: i * bucketSize,
    to: (i + 1) * bucketSize,
    count: 0,
  }));
  for (const v of values) {
    const i = Math.min(bucketCount - 1, Math.floor(v / bucketSize));
    buckets[i]!.count++;
  }
  buckets[bucketCount - 1]!.to = Infinity;
  return buckets;
}

/** Rounds a raw step up to a "nice" number (1, 2, 2.5 or 5 × 10^n) so chart buckets read well. */
export function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

export function groupBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}
