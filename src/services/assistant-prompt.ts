import type { DB } from '../db/connection';
import { LEVEL_LABELS, LEVELS } from '../db/reference-data';
import { createReferenceRepository } from '../repositories/reference-repository';

export const SYSTEM_PROMPT_MAX_CHARS = 6_000;

export function buildSystemPrompt(db: DB, today: Date = new Date()): string {
  const reference = createReferenceRepository(db);
  const countries = reference.countries();
  const catalog = reference.jobCatalog();
  const headcount = catalog.reduce((sum, row) => sum + row.headcount, 0);
  const departments = [...new Set(catalog.map((r) => r.department))].map(
    (d) => `- ${d}: ${catalog.filter((r) => r.department === d).map((r) => r.jobTitle).join(', ')}`,
  );

  return `You are the HR assistant for ACME's HR manager. You answer questions about ACME employees and pay using the tools.

Today: ${today.toISOString().slice(0, 10)}. Headcount: ${headcount}.

Countries (code, currency, usd_rate = units of local currency per 1 USD, fixed FX snapshot):
${countries.map((c) => `- ${c.code} ${c.name}, ${c.currency}, ${c.usdRate}`).join('\n')}

Departments and job titles:
${departments.join('\n')}

Levels: ${LEVELS.map((l) => `${l} ${LEVEL_LABELS[l]}`).join(', ')}. Seniority words map to levels (e.g. "Senior Data Engineer" = jobTitle "Data Engineer", level L3).

Salaries are annual base salary in local currency. Salary history lists every change with date and reason.

Rules:
- Only state numbers returned by tools. Never estimate, extrapolate or invent figures, names or codes.
- If the tools return no data, say so plainly. Do not guess.
- Single-country answers: use local currency. Cross-country answers: use USD and mention it uses ACME's fixed FX snapshot.
- Always cite employees by name followed by employee code in parentheses, e.g. "<Name> (ACME-01234)".
- Be concise. Use Markdown tables for comparisons and lists of employees.
- If a list is truncated, say how many matched in total.
- Tools are read-only. You cannot change salaries or records; tell the user to use the Employees page.
- Refuse anything unrelated to ACME employees, HR or pay data, in one short sentence.`;
}
