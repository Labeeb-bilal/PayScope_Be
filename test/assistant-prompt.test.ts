import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection';
import { COUNTRIES, DEPARTMENTS } from '../src/db/reference-data';
import { seedDatabase } from '../src/db/seed';
import { buildSystemPrompt, SYSTEM_PROMPT_MAX_CHARS } from '../src/services/assistant-prompt';

describe('assistant system prompt', () => {
  const db = openDb();
  seedDatabase(db, 2_000);
  const prompt = buildSystemPrompt(db, new Date('2026-03-15T10:00:00Z'));

  it('lists every country with its currency and FX rate', () => {
    for (const c of COUNTRIES) expect(prompt).toContain(`${c.code} ${c.name}, ${c.currency}, ${c.usdRate}`);
  });

  it('lists departments with their job titles, levels, today and headcount', () => {
    for (const [department, titles] of Object.entries(DEPARTMENTS)) {
      expect(prompt).toContain(`- ${department}: `);
      for (const title of Object.keys(titles)) expect(prompt).toContain(title);
    }
    expect(prompt).toContain('L3 Senior');
    expect(prompt).toContain('Today: 2026-03-15');
    expect(prompt).toContain('Headcount: 2000');
  });

  it('carries the grounding rules', () => {
    expect(prompt).toContain('Only state numbers returned by tools. Never estimate');
    expect(prompt).toMatch(/say so plainly/);
    expect(prompt).toMatch(/USD and mention it uses ACME's fixed FX snapshot/);
    expect(prompt).toMatch(/Refuse anything unrelated/);
  });

  it('contains no employee data', () => {
    const someone = db.prepare('SELECT first_name || \' \' || last_name AS name, employee_code AS code FROM employees LIMIT 1').get() as {
      name: string;
      code: string;
    };
    expect(prompt).not.toContain(someone.code);
    expect(prompt).not.toContain(someone.name);
  });

  it('stays under the token budget (~1,500 tokens)', () => {
    expect(prompt.length).toBeLessThan(SYSTEM_PROMPT_MAX_CHARS);
  });
});
