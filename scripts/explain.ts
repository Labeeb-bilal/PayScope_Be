import { CASES, EMPLOYEE_COUNT, captureStatements, environment, oneLine, openSeededTempDb } from './query-cases';

interface PlanRow {
  id: number;
  parent: number;
  detail: string;
}

function renderPlan(rows: PlanRow[]): string {
  const depth = new Map<number, number>([[0, -1]]);
  return rows
    .map((r) => {
      const d = (depth.get(r.parent) ?? -1) + 1;
      depth.set(r.id, d);
      return `${'  '.repeat(d)}${r.detail}`;
    })
    .join('\n');
}

const { db, cleanup } = openSeededTempDb();
try {
  console.log(`_${EMPLOYEE_COUNT.toLocaleString('en-US')} employees, ${environment(db)}_\n`);
  for (const c of CASES) {
    console.log(`### ${c.name}\n`);
    for (const { sql, args } of captureStatements(db, () => c.run(db))) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as PlanRow[];
      console.log('```sql');
      console.log(oneLine(sql));
      console.log('```');
      console.log('```text');
      console.log(renderPlan(plan));
      console.log('```\n');
    }
  }
} finally {
  cleanup();
}
