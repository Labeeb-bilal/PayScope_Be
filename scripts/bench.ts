import { performance } from 'node:perf_hooks';
import { CASES, EMPLOYEE_COUNT, captureStatements, environment, openSeededTempDb } from './query-cases';

const RUNS = 200;
const WARMUP = 20;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const { db, cleanup } = openSeededTempDb();
try {
  console.log(`_${EMPLOYEE_COUNT.toLocaleString('en-US')} employees, median of ${RUNS} runs after ${WARMUP} warm-up runs, ${environment(db)}_\n`);
  console.log('| Query | Statements | Median ms |');
  console.log('|---|---:|---:|');
  for (const c of CASES) {
    const statements = captureStatements(db, () => c.run(db)).map(({ sql, args }) => ({ stmt: db.prepare(sql), args }));
    const once = () => {
      for (const { stmt, args } of statements) stmt.all(...args);
    };
    for (let i = 0; i < WARMUP; i++) once();
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      once();
      samples.push(performance.now() - t0);
    }
    console.log(`| ${c.name} | ${statements.length} | ${median(samples).toFixed(3)} |`);
  }
} finally {
  cleanup();
}
