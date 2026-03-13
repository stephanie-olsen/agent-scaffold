/**
 * Strategy loader — v2 (S3 + S5 + S9).
 */

import { fold as s3 } from './s3-topic-segmentation.mjs';
import { fold as s5 } from './s5-unified-folding.mjs';
import { fold as s9 } from './s9-topic-constrained.mjs';
import { fold as s9v3 } from './s9-v3-bounded.mjs';

export const strategies = { s3, s5, s9, 's9-v3': s9v3 };

export function getStrategy(name) {
  const fn = strategies[name];
  if (!fn) throw new Error(`Unknown strategy: ${name}. Available: ${Object.keys(strategies).join(', ')}`);
  return fn;
}
