# Employee Salary Management: Results and Scaling

Live app: [pay-scope-fe.vercel.app](https://pay-scope-fe.vercel.app/)

Code: [Frontend repo](https://github.com/Labeeb-bilal/PayScope_Fe/tree/prod) and [Backend repo](https://github.com/Labeeb-bilal/PayScope_Be)

Note on loading time: the frontend is on Vercel and the API is on Render's free plan. Render puts the API to sleep after 15 minutes with no traffic. The first request after that takes about a minute while it wakes up. After that the app is fast. The free plan also has no permanent disk, so the database is re-seeded with 10,000 employees on every restart and any changes made during testing are reset.

## 1. What I built

| Feature | Details |
| --- | --- |
| Employee list | Search, filter by country, department and level, sort, pagination, CSV export |
| Salary changes | Every change needs a reason and an effective date. Old salaries are kept as history |
| Pay insights | Headcount, payroll, pay by country, department and level, salary distribution |
| Benchmark | Min, P25, median, P75 and max for a role in each country and level |
| Pay equity | Lists people paid below 80% of the median of their peers, and the cost to fix it |
| Ask AI | HR can ask questions in plain English. The AI uses the app's own APIs to get the numbers |
| Seed data | 10,000 employees across 10 countries |

Tech: Node.js, Express, TypeScript, SQLite, Next.js, Mantine, Vitest.

## 2. Architecture

The frontend calls one API. The API owns the database and is the only part that talks to the LLM.

![System architecture](images/architecture.png)

Database tables:

| Table | Holds |
| --- | --- |
| employees | One row per employee: name, role, level, department, country, salary in local currency, salary in USD |
| salary_changes | Every salary change with old and new value, date and reason |
| countries | Country name, currency and exchange rate to USD |
| employees_fts | Search index for names, emails and employee codes |

How the AI assistant answers a question:

![How the AI assistant answers a question](images/ai-assistant-flow.png)

Each layer has one job. Routes only handle HTTP, services hold the rules, and repositories hold the SQL. This keeps the code easy to test. Tests run against a fresh in-memory database, so they are fast and give the same result every time.

## 3. Main decisions

- Salaries are saved in the employee's local currency, because that is what the contract says. USD is only used to compare across countries.
- I added a `salary_usd` column so sorting by salary can use an index. It is calculated from salary and the exchange rate, and updated whenever either of them changes.
- I checked every index with `EXPLAIN QUERY PLAN` and removed the ones that were not used.
- Search uses SQLite full-text search (FTS5) instead of `LIKE`.
- The AI assistant does not get employee data in its prompt. It calls tools that run the real queries, so the numbers are always exact.

## 4. Measured results

Sorting by salary got over 3,000 times faster at 100,000 employees once it used the index. All numbers below are measured, not estimated.

Sort by salary, first page, 100,000 employees (MacBook Pro):

|  | Before | After |
| --- | --- | --- |
| Median time | 32.2 ms | 0.009 ms |
| 95th percentile | 37.4 ms | 0.010 ms |
| How it runs | Reads and sorts every row | Reads 25 rows from the index |

Both versions return the same 25 employees.

Default list sorted by name:

|  | Time |
| --- | --- |
| With name index | 0.05 ms |
| Without name index | 2.3 ms |

10,000 employees (first version, local test):

| Operation | Time |
| --- | --- |
| Seeding 10,000 employees | about 150 ms |
| Employee list, filter, search | 2 to 7 ms |
| Insights pages | 14 to 17 ms |

To run the sort test again: `npx tsx scripts/compare-sort.ts 10000,100000,1000000` in the backend folder.

## 5. Scaling from 10,000 to 100,000 employees

The current design already handles the most common operations at 100,000 employees, because the expensive work is done by indexes rather than by scanning every row.

What already holds up at 100,000:

| Operation | Why it scales |
| --- | --- |
| Sorting by salary | Uses the salary_usd index. Measured at 0.009 ms with 100,000 employees |
| Default list sorted by name | Uses the name index and reads only one page of rows |
| Search | Uses the full-text index, so it does not read every row |
| Filters by country and department | Each filter has its own index |
| Seeding and bulk loads | Rows are inserted in one transaction and the search index is rebuilt once at the end |

What I would improve to support 100,000 employees comfortably:

| Area | Improvement | Architecture change | Benefit |
| --- | --- | --- | --- |
| Insights | Summary tables updated whenever a salary changes | Separate read model for reporting, kept up to date on write | Dashboards no longer read every employee on each visit |
| Insights | Cache results and clear the cache whenever data changes | Cache layer between the API and the database | Repeat visits load instantly and never show outdated numbers |
| Database | Move from SQLite to Postgres | Embedded database replaced by a dedicated database server | Several HR users can save at the same time |
| Hosting | Always-on servers with permanent storage | Stateless API servers behind a load balancer, data in a managed database | No slow first load, data kept across restarts, more servers can be added |
| Background work | Exchange-rate updates, imports and large exports | Job queue with a separate worker process | Heavy tasks do not slow down the app for HR |
| Frontend | Prefetch pages, load charts only where needed | Static frontend served from a CDN, code split per page | Faster pages and less data downloaded |
| Monitoring | Track response times and slow queries | Logging, metrics and alerts across all services | Problems are found before users notice them |

Beyond 100,000, the next steps would be read replicas for reporting and a shared cache such as Redis when the app runs on more than one server.

Alongside scaling, the next product additions would be login with roles, scheduled salary changes, keeping records of people who have left, exchange-rate history and Excel import.
