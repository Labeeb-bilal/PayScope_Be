/**
 * Times every insights call (median of 30 runs after 5 warm-ups) at 10k and 100k employees.
 * "Insights page" = the six calls the Pay insights page makes on load.
 * Usage: npm run bench:insights
 */
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { openDb } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { createInsightsService } from '../src/services/insights-service';

const RUNS = 30;
const WARMUP = 5;
const SIZES = (process.argv[2] ?? '10000,100000').split(',').map(Number);

function medianMs(fn: () => unknown): number {
  for (let i = 0; i < WARMUP; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(RUNS / 2)]!;
}

console.log(`_Median of ${RUNS} runs after ${WARMUP} warm-ups. Node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'}_\n`);
console.log(`| Call | ${SIZES.map((n) => `${n.toLocaleString('en-US')} employees`).join(' | ')} |`);
console.log(`|---|${SIZES.map(() => '---:').join('|')}|`);

const results = new Map<string, number[]>();
for (const n of SIZES) {
  const db = openDb(':memory:');
  seedDatabase(db, n);
  const s = createInsightsService(db);
  const cases: [string, () => unknown, boolean][] = [
    ['summary', () => s.summary(), true],
    ['byCountry', () => s.byCountry(), true],
    ['byDepartment', () => s.byDepartment(), true],
    ['byLevel', () => s.byLevel(), true],
    ['distribution (org, USD)', () => s.distribution(), true],
    ['distribution (IN, local)', () => s.distribution('IN'), false],
    ['benchmark (Data Engineer, L3, AE)', () => s.benchmark({ jobTitle: 'Data Engineer', level: 'L3', country: 'AE' }), false],
    ['payEquity (default)', () => s.payEquity({ threshold: 0.8, minPeers: 5, limit: 100 }), true],
  ];
  let page = 0;
  for (const [name, fn, onPage] of cases) {
    const ms = medianMs(fn);
    if (onPage) page += ms;
    results.set(name, [...(results.get(name) ?? []), ms]);
  }
  results.set('**Insights page (6 calls)**', [...(results.get('**Insights page (6 calls)**') ?? []), page]);
  db.close();
}
for (const [name, values] of results) console.log(`| ${name} | ${values.map((v) => v.toFixed(2)).join(' | ')} |`);
