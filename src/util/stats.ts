/**
 * Prices move with inventory, time of day and A/B buckets, so a comparison is
 * built from several samples per market and reported as a median.
 */

export function median(values: number[]): number {
  if (values.length === 0) throw new Error('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function spread(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}
