# Employee Salary Management - Backend

REST API for an HR manager to manage salaries for 10,000 employees across 10 countries, and to answer questions about how the organisation pays people.

- Live app: [pay-scope-fe.vercel.app](https://pay-scope-fe.vercel.app/)
- Frontend repo: [PayScope_Fe](https://github.com/Labeeb-bilal/PayScope_Fe/tree/prod)
- Results, architecture and scaling: [docs/results-and-scaling.md](docs/results-and-scaling.md)

> The API runs on Render's free plan. It sleeps after 15 minutes without traffic, so the first request can take about a minute. The database is re-seeded on every restart, so changes made while testing are reset.

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js, Express, TypeScript |
| Database | SQLite (better-sqlite3) with FTS5 full-text search |
| Validation | zod |
| AI assistant | Groq (OpenAI-compatible API) with tool calling |
| Tests | Vitest + Supertest, in-memory SQLite |

## Features

- Employee list with search, filters (country, department, level), sorting, pagination and CSV export
- Create, update and delete employees
- Salary changes with a reason and effective date, kept as an append-only history
- Pay insights: summary, pay by country, department and level, salary distribution
- Benchmark: min, P25, median, P75 and max for a role by country and level
- Pay-equity flags: employees paid below a share of their peer median
- Ask AI: questions in plain English, answered through read-only tools over the same services
- Seed script with 10,000 deterministic employees

## Architecture

![System architecture](docs/images/architecture.png)

```
src/
  routes/         HTTP only: validate input with zod, map errors to status codes
  services/       business rules, insights, AI assistant loop
  repositories/   SQL only
  lib/            pure helpers (stats, CSV, errors)
  db/             schema, migrations, reference data, seed
test/             unit and API tests
scripts/          benchmark scripts
docs/             requirements, design notes, results and scaling
```

Key decisions:

- Salaries are stored in local currency, which is the contract value. USD is used only for cross-country comparison, using a stored exchange-rate snapshot.
- `salary_usd` is a derived column, kept in sync on every salary or country change and rebuilt when a rate changes. It lets sorting by salary use an index.
- Indexes are based on real query plans (`EXPLAIN QUERY PLAN`). Unused ones were removed.
- The AI assistant never receives employee data in its prompt. It calls tools that run real queries, so numbers are exact.

## Getting started

Requirements: Node.js 20+

```bash
npm install
npm run seed      # creates data/app.db with 10,000 employees
npm run dev       # http://localhost:4000
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | Server port |
| `DB_PATH` | `data/app.db` | SQLite file location |
| `SEED_IF_EMPTY` | `true` | Seed 10,000 employees on start if the database is empty |
| `LLM_API_KEY` | none | Groq API key. The AI assistant is disabled without it |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | OpenAI-compatible endpoint |
| `LLM_MODEL` | `llama-3.3-70b-versatile` | Model with tool-calling support |

Get a free Groq key at [console.groq.com](https://console.groq.com).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start in watch mode |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run seed` | Seed 10,000 employees |
| `npm test` | Run all tests |
| `npm run test:coverage` | Tests with coverage report |
| `npm run typecheck` | Type-check without building |

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/health` | Health check |
| GET | `/api/meta` | Countries, levels, departments and job titles |
| GET | `/api/employees` | List with `search`, `country`, `department`, `level`, `sort`, `order`, `page`, `pageSize` |
| GET | `/api/employees/export.csv` | CSV export of the filtered list |
| GET | `/api/employees/:id` | Employee details with salary history |
| POST | `/api/employees` | Create an employee |
| PATCH | `/api/employees/:id` | Update an employee (country change requires a new salary) |
| DELETE | `/api/employees/:id` | Delete an employee |
| POST | `/api/employees/:id/salary-changes` | Change salary with `newSalary`, `effectiveDate`, `reason` |
| GET | `/api/insights/summary` | Headcount, payroll and median salary |
| GET | `/api/insights/by-country` | Pay by country in local currency and USD |
| GET | `/api/insights/by-department` | Payroll and median by department |
| GET | `/api/insights/by-level` | Median and range by level |
| GET | `/api/insights/distribution` | Salary distribution, optional `country` |
| GET | `/api/insights/benchmark` | Pay range for `jobTitle`, optional `level` and `country` |
| GET | `/api/insights/pay-equity` | Employees below `threshold` of their peer median |
| GET | `/api/assistant/status` | Whether the AI assistant is enabled |
| POST | `/api/assistant/chat` | Ask a question; the answer is streamed |

Errors use one format: `{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }`, with status 400, 404 or 409.

## Tests

```bash
npm test
```

Each test uses a fresh in-memory database, so tests are fast, isolated and give the same result every time. They cover the stats helpers, the seed generator, salary-change and relocation rules, insights calculated on a small hand-built dataset, the AI tool loop with a fake LLM client, and the HTTP API.

## Performance

Measured with `scripts/compare-sort.ts` (median of repeated runs after warm-up):

| Sort by salary, 100,000 employees | Before | After |
| --- | --- | --- |
| Median time | 32.2 ms | 0.009 ms |
| How it runs | Reads and sorts every row | Reads 25 rows from the index |

```bash
npx tsx scripts/compare-sort.ts 10000,100000,1000000
```

More detail and the scaling plan are in [docs/results-and-scaling.md](docs/results-and-scaling.md).
