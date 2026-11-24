# Performance: indexing strategy

How the indexes were chosen: measure the real query plans first, change one thing at a time, re-measure.

## Method

- `npm run explain` seeds 10,000 employees into a temp, file-backed (WAL) database and prints `EXPLAIN QUERY PLAN`
  for the SQL the app **actually executes**: the scripts call the real repository/service code and capture every
  statement it runs, so the plans always match the current code.
- `npm run bench` captures the same statements, prepares them once and reports the **median of 200 runs**
  (after 20 warm-up runs) per query. A list request is two statements (`COUNT(*)` + page), both included.
- No `ANALYZE` is run, because the app never runs it, so the planner sees what production sees.
- Query 6 (default directory page) is not one of the five original targets. It was added because it is the only
  query that uses `idx_employees_name`, so it is needed to decide whether that index can be dropped.

Timings are from one developer laptop and are only meaningful relative to each other.

## Before

### Timings

_10,000 employees, median of 200 runs after 20 warm-up runs, Node v26.4.0, SQLite 3.54.1, Apple M1, darwin arm64_

| Query | Statements | Median ms |
|---|---:|---:|
| 1. List sorted by salary (USD) desc, page 1 | 2 | 2.320 |
| 2. List filtered by country=IN, sorted by salary desc | 2 | 0.514 |
| 3. Search "pri" (name / email / code prefix) | 2 | 2.324 |
| 4. Benchmark (job_title + level + country) | 1 | 0.031 |
| 5. Salary history for one employee | 1 | 0.012 |
| 6. Default directory page (sorted by name) | 2 | 0.046 |

### Query plans

_10,000 employees, Node v26.4.0, SQLite 3.54.1, Apple M1, darwin arm64_

### 1. List sorted by salary (USD) desc, page 1

```sql
SELECT COUNT(*) AS n FROM employees e
```
```text
SCAN employees USING COVERING INDEX idx_employees_first_name
```

```sql
SELECT e.id, e.employee_code AS employeeCode, e.first_name AS firstName, e.last_name AS lastName, e.email, e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.salary, e.currency, ROUND(e.salary / c.usd_rate) AS salaryUsd, e.hire_date AS hireDate, e.created_at AS createdAt, e.updated_at AS updatedAt FROM employees e JOIN countries c ON c.code = e.country_code ORDER BY e.salary / c.usd_rate DESC, e.id DESC LIMIT @limit OFFSET @offset
```
```text
SCAN e USING INDEX idx_employees_country
SEARCH c USING INDEX sqlite_autoindex_countries_1 (code=?)
USE TEMP B-TREE FOR ORDER BY
```

### 2. List filtered by country=IN, sorted by salary desc

```sql
SELECT COUNT(*) AS n FROM employees e WHERE e.country_code = @country
```
```text
SEARCH e USING COVERING INDEX idx_employees_country (country_code=?)
```

```sql
SELECT e.id, e.employee_code AS employeeCode, e.first_name AS firstName, e.last_name AS lastName, e.email, e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.salary, e.currency, ROUND(e.salary / c.usd_rate) AS salaryUsd, e.hire_date AS hireDate, e.created_at AS createdAt, e.updated_at AS updatedAt FROM employees e JOIN countries c ON c.code = e.country_code WHERE e.country_code = @country ORDER BY e.salary / c.usd_rate DESC, e.id DESC LIMIT @limit OFFSET @offset
```
```text
SEARCH c USING INDEX sqlite_autoindex_countries_1 (code=?)
SEARCH e USING INDEX idx_employees_country (country_code=?)
USE TEMP B-TREE FOR ORDER BY
```

### 3. Search "pri" (name / email / code prefix)

```sql
SELECT COUNT(*) AS n FROM employees e WHERE (e.first_name LIKE @search ESCAPE '\' OR e.last_name LIKE @search ESCAPE '\' OR e.email LIKE @search ESCAPE '\' OR e.employee_code LIKE @search ESCAPE '\' OR (e.first_name || ' ' || e.last_name) LIKE @search ESCAPE '\')
```
```text
SCAN e
```

```sql
SELECT e.id, e.employee_code AS employeeCode, e.first_name AS firstName, e.last_name AS lastName, e.email, e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.salary, e.currency, ROUND(e.salary / c.usd_rate) AS salaryUsd, e.hire_date AS hireDate, e.created_at AS createdAt, e.updated_at AS updatedAt FROM employees e JOIN countries c ON c.code = e.country_code WHERE (e.first_name LIKE @search ESCAPE '\' OR e.last_name LIKE @search ESCAPE '\' OR e.email LIKE @search ESCAPE '\' OR e.employee_code LIKE @search ESCAPE '\' OR (e.first_name || ' ' || e.last_name) LIKE @search ESCAPE '\') ORDER BY e.last_name ASC, e.first_name ASC, e.id ASC LIMIT @limit OFFSET @offset
```
```text
SCAN e USING INDEX idx_employees_name
SEARCH c USING INDEX sqlite_autoindex_countries_1 (code=?)
```

### 4. Benchmark (job_title + level + country)

```sql
SELECT e.id, e.employee_code AS employeeCode, e.first_name || ' ' || e.last_name AS name, e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.currency, e.salary, c.usd_rate AS usdRate FROM employees e JOIN countries c ON c.code = e.country_code WHERE e.country_code = @country AND e.job_title = @jobTitle AND e.level = @level
```
```text
SEARCH c USING INDEX sqlite_autoindex_countries_1 (code=?)
SEARCH e USING INDEX idx_employees_peer (job_title=? AND level=? AND country_code=?)
```

### 5. Salary history for one employee

```sql
SELECT id, employee_id AS employeeId, previous_salary AS previousSalary, new_salary AS newSalary, currency, effective_date AS effectiveDate, reason, created_at AS createdAt FROM salary_changes WHERE employee_id = ? ORDER BY effective_date DESC, id DESC
```
```text
SEARCH salary_changes USING INDEX idx_salary_changes_employee (employee_id=?)
```

### 6. Default directory page (sorted by name)

```sql
SELECT COUNT(*) AS n FROM employees e
```
```text
SCAN employees USING COVERING INDEX idx_employees_first_name
```

```sql
SELECT e.id, e.employee_code AS employeeCode, e.first_name AS firstName, e.last_name AS lastName, e.email, e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.salary, e.currency, ROUND(e.salary / c.usd_rate) AS salaryUsd, e.hire_date AS hireDate, e.created_at AS createdAt, e.updated_at AS updatedAt FROM employees e JOIN countries c ON c.code = e.country_code ORDER BY e.last_name ASC, e.first_name ASC, e.id ASC LIMIT @limit OFFSET @offset
```
```text
SCAN e USING INDEX idx_employees_name
SEARCH c USING INDEX sqlite_autoindex_countries_1 (code=?)
```


### What the plans say

| # | Query | Problem |
|---|---|---|
| 1 | Sort by USD salary | `ORDER BY e.salary / c.usd_rate` is an expression across a join, so no index can serve it: SQLite reads all 10k rows and sorts them in a temp B-tree to return 25 |
| 2 | Country + sort by salary | Index finds the 2,507 IN rows, but they are still sorted in a temp B-tree |
| 3 | Search "pri" | `LIKE` with `OR` across five expressions forces a full `SCAN e` for the count; the page query walks the whole name index checking every row |
| 4 | Benchmark | Already optimal: `idx_employees_peer` matches all three equality columns |
| 5 | Salary history | Already optimal: `idx_salary_changes_employee` serves the filter and the sort |
| 6 | Default page (by name) | Already optimal: walks `idx_employees_name` in order and stops after 25 rows |

`idx_employees_first_name` appears only as the narrowest index for `SELECT COUNT(*)`, which any index (or the table) can serve.
`idx_employees_name` is **used** by queries 3 and 6.

## After

All three changes applied (`salary_usd` + index, `(country_code, salary)` index, FTS5 search) and
`idx_employees_first_name` dropped. Same machine, same scripts, same method as Before.

### Summary

Plans are the page query's plan, plus the `COUNT(*)` plan where it changed. "ms" is the whole list request (count + page).

| # | Query | Plan before | Plan after | ms before | ms after |
|---|---|---|---|---:|---:|
| 1 | List sorted by USD salary desc | `SCAN e USING INDEX idx_employees_country` + `USE TEMP B-TREE FOR ORDER BY` (sorts all 10k rows) | `SCAN e USING INDEX idx_employees_salary_usd` (reads 25 rows in order, stops) | 2.320 | 0.048 |
| 2 | Country=IN, sorted by salary desc | `SEARCH e USING INDEX idx_employees_country` + `USE TEMP B-TREE FOR ORDER BY` | `SEARCH e USING INDEX idx_employees_country_salary (country_code=?)` (already in salary order) | 0.514 | 0.094 |
| 3 | Search "pri" | count: `SCAN e` (full table, 5 `LIKE`s per row); page: `SCAN e USING INDEX idx_employees_name` testing every row | `SCAN employees_fts VIRTUAL TABLE INDEX 0:M4` → `SEARCH e USING INTEGER PRIMARY KEY` (only the 164 matches); temp B-tree sorts just those | 2.324 | 0.232 |
| 4 | Benchmark (title + level + country) | `SEARCH e USING INDEX idx_employees_peer (job_title=? AND level=? AND country_code=?)` | unchanged | 0.031 | 0.033 |
| 5 | Salary history for one employee | `SEARCH salary_changes USING INDEX idx_salary_changes_employee (employee_id=?)` | unchanged | 0.012 | 0.014 |
| 6 | Default directory page (by name) | `SCAN e USING INDEX idx_employees_name` (stops after 25) | unchanged | 0.046 | 0.049 |

Queries 4–6 were already optimal; their ±0.003 ms differences are run-to-run noise (two consecutive After runs differed by up to 0.003 ms).

### Timings

_10,000 employees, median of 200 runs after 20 warm-up runs, Node v26.4.0, SQLite 3.54.1, Apple M1, darwin arm64_

| Query | Statements | Median ms |
|---|---:|---:|
| 1. List sorted by salary (USD) desc, page 1 | 2 | 0.048 |
| 2. List filtered by country=IN, sorted by salary desc | 2 | 0.094 |
| 3. Search "pri" (name / email / code prefix) | 2 | 0.232 |
| 4. Benchmark (job_title + level + country) | 1 | 0.033 |
| 5. Salary history for one employee | 1 | 0.014 |
| 6. Default directory page (sorted by name) | 2 | 0.049 |

### Write-side cost (measured)

`seedDatabase(10_000)`, median of 7, in-memory DB:

| | Without FTS (after steps 1–2) | FTS triggers, row by row | Final (bulk load: triggers off, one FTS `rebuild`) |
|---|---:|---:|---:|
| First seed (empty DB) | 118.8 ms | 247.7 ms | 130.7 ms |
| Re-seed (wipe 10k + insert 10k) | 157.1 ms | 832.7 ms | 164.8 ms |

Migrating a copy of the existing 10k-row `data/app.db` (add `salary_usd`, backfill, build and backfill FTS) took 174.7 ms
on first open, with no data lost (same row count, salary total and 15,305 history rows).

### Index drop decision

The task assumed `idx_employees_name` and `idx_employees_first_name` were both unused. The plans show that is only true
for `idx_employees_first_name`. Measured with each one removed:

| Variant | Query 3 (search) | Query 6 (default page) |
|---|---:|---:|
| Keep both | 0.202 ms | 0.046 ms |
| Drop `idx_employees_first_name` only | 0.215 ms | 0.049 ms |
| Drop both | 0.209 ms | **2.334 ms** (`USE TEMP B-TREE FOR ORDER BY` over all rows) |

So `idx_employees_first_name` was dropped and `idx_employees_name` was kept. The default directory view is the
most-loaded page in the app, and that index lets it read 25 rows instead of sorting 10,000.

### Full query plans (After)

_10,000 employees, Node v26.4.0, SQLite 3.54.1, Apple M1, darwin arm64_

### 1. List sorted by salary (USD) desc, page 1

```sql
SELECT COUNT(*) AS n FROM employees e
```
```text
SCAN employees USING COVERING INDEX idx_employees_salary_usd
```

```sql
SELECT e.id, e.employee_code AS employeeCode, e.first_name AS firstName, e.last_name AS lastName, e.email, e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.salary, e.currency, e.salary_usd AS salaryUsd, e.hire_date AS hireDate, e.created_at AS createdAt, e.updated_at AS updatedAt FROM employees e JOIN countries c ON c.code = e.country_code ORDER BY e.salary_usd DESC, e.id DESC LIMIT @limit OFFSET @offset
```
```text
SCAN e USING INDEX idx_employees_salary_usd
SEARCH c USING INDEX sqlite_autoindex_countries_1 (code=?)
```

### 2. List filtered by country=IN, sorted by salary desc

```sql
SELECT COUNT(*) AS n FROM employees e WHERE e.country_code = @country
```
```text
SEARCH e USING COVERING INDEX idx_employees_country_salary (country_code=?)
```

```sql
SELECT e.id, e.employee_code AS employeeCode, e.first_name AS firstName, e.last_name AS lastName, e.email, e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.salary, e.currency, e.salary_usd AS salaryUsd, e.hire_date AS hireDate, e.created_at AS createdAt, e.updated_at AS updatedAt FROM employees e JOIN countries c ON c.code = e.country_code WHERE e.country_code = @country ORDER BY e.salary DESC, e.id DESC LIMIT @limit OFFSET @offset
```
```text
SEARCH c USING INDEX sqlite_autoindex_countries_1 (code=?)
SEARCH e USING INDEX idx_employees_country_salary (country_code=?)
```

### 3. Search "pri" (name / email / code prefix)

```sql
SELECT COUNT(*) AS n FROM employees e WHERE e.id IN (SELECT rowid FROM employees_fts WHERE employees_fts MATCH @search)
```
```text
SEARCH e USING INTEGER PRIMARY KEY (rowid=?)
LIST SUBQUERY 1
  SCAN employees_fts VIRTUAL TABLE INDEX 0:M4
```

```sql
SELECT e.id, e.employee_code AS employeeCode, e.first_name AS firstName, e.last_name AS lastName, e.email, e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.salary, e.currency, e.salary_usd AS salaryUsd, e.hire_date AS hireDate, e.created_at AS createdAt, e.updated_at AS updatedAt FROM employees e JOIN countries c ON c.code = e.country_code WHERE e.id IN (SELECT rowid FROM employees_fts WHERE employees_fts MATCH @search) ORDER BY e.last_name ASC, e.first_name ASC, e.id ASC LIMIT @limit OFFSET @offset
```
```text
SEARCH e USING INTEGER PRIMARY KEY (rowid=?)
LIST SUBQUERY 1
  SCAN employees_fts VIRTUAL TABLE INDEX 0:M4
SEARCH c USING INDEX sqlite_autoindex_countries_1 (code=?)
USE TEMP B-TREE FOR ORDER BY
```

### 4. Benchmark (job_title + level + country)

```sql
SELECT e.id, e.employee_code AS employeeCode, e.first_name || ' ' || e.last_name AS name, e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.currency, e.salary, c.usd_rate AS usdRate FROM employees e JOIN countries c ON c.code = e.country_code WHERE e.country_code = @country AND e.job_title = @jobTitle AND e.level = @level
```
```text
SEARCH c USING INDEX sqlite_autoindex_countries_1 (code=?)
SEARCH e USING INDEX idx_employees_peer (job_title=? AND level=? AND country_code=?)
```

### 5. Salary history for one employee

```sql
SELECT id, employee_id AS employeeId, previous_salary AS previousSalary, new_salary AS newSalary, currency, effective_date AS effectiveDate, reason, created_at AS createdAt FROM salary_changes WHERE employee_id = ? ORDER BY effective_date DESC, id DESC
```
```text
SEARCH salary_changes USING INDEX idx_salary_changes_employee (employee_id=?)
```

### 6. Default directory page (sorted by name)

```sql
SELECT COUNT(*) AS n FROM employees e
```
```text
SCAN employees USING COVERING INDEX idx_employees_salary_usd
```

```sql
SELECT e.id, e.employee_code AS employeeCode, e.first_name AS firstName, e.last_name AS lastName, e.email, e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.salary, e.currency, e.salary_usd AS salaryUsd, e.hire_date AS hireDate, e.created_at AS createdAt, e.updated_at AS updatedAt FROM employees e JOIN countries c ON c.code = e.country_code ORDER BY e.last_name ASC, e.first_name ASC, e.id ASC LIMIT @limit OFFSET @offset
```
```text
SCAN e USING INDEX idx_employees_name
SEARCH c USING INDEX sqlite_autoindex_countries_1 (code=?)
```


## Trade-offs

**Denormalised `salary_usd`.** It duplicates information (`salary / usd_rate`) to make one sort indexable.
- *Write cost:* on create the value is computed inside the same `INSERT` (one subquery on the 10-row `countries` table) and
  `idx_employees_salary_usd` gets one more entry. A salary change or relocation runs one extra `UPDATE` by primary key in the
  same transaction. All of these are single-row writes at HR-edit rates.
- *Correctness risk:* a cache can go stale. Mitigations: it is written in the same transaction as `salary`/`country_code`,
  `salary` + `currency` stay the source of truth (contracts, insights and pay equity still use them), and the value can always
  be rebuilt.
- *FX refresh:* changing a rate means recomputing every row in that currency. `recomputeSalaryUsd(db, country?)` only writes
  rows whose value changes and runs on every `openDb`, so a rate edited in `reference-data.ts` takes effect on the next boot.
  At 10k rows a full recompute is a single statement. With live FX feeds this would move to a scheduled job.
- *Alternative rejected:* a SQLite generated column can't reference another table (`countries.usd_rate`), and an expression
  index has the same problem.

**FTS5 triggers on every write.** Insert, delete and any change to name/email/code also update the full-text index.
- Per inserted row, the insert trigger costs (247.7 − 118.8) ms / 10,000 ≈ 0.013 ms (from the first-seed numbers above).
  Interactive writes are one row at a time, so this is a fixed, tiny cost per edit.
- Salary changes don't pay anything: the update trigger is `AFTER UPDATE OF first_name, last_name, email, employee_code`.
- Bulk loads did pay: row-by-row triggers made a 10k re-seed 5× slower (157 → 833 ms). `withoutSearchTriggers()` drops the
  triggers inside the seed transaction, loads, rebuilds the index once and restores the triggers (165 ms).
- Behaviour change: search now matches a *prefix of any word* in name, email or code (`smith` also finds `jane.smith@…`)
  instead of a prefix of the whole field. Multi-word input is AND-ed in any order. That is what people expect from a search box.
  Punctuation is treated as a separator; input that is only punctuation returns no results rather than an error.

**Why `level` and `hire_date` are not indexed.**
- `level` has 5 values. In the seed data each level is 6–30% of the table (L1 3,011 · L2 3,006 · L3 2,226 · L4 1,155 ·
  L5 602 rows). Reading that share of rows through an index (one table lookup per row) is generally no faster than a scan.
  It is also usually combined with more selective filters (country, title), and
  `idx_employees_peer` already covers `level` for benchmarks.
- `hire_date` is only used as an optional sort column. It's rarely chosen, and a full sort of 10k rows has the same plan
  shape as query 1 before (2.32 ms). Not worth an index that every insert must maintain.

**Indexes now redundant (not changed here).** `idx_employees_country (country_code)` is a prefix of
`idx_employees_country_salary (country_code, salary)`. After step 2 the planner prefers the composite one, even for the
country `COUNT(*)`. It could be dropped to save a write per insert; it was left in place because that wasn't in scope.

**At 1M rows.**
- Insights currently load every row and aggregate in TypeScript, so their cost grows linearly with headcount (not measured
  here: `bench.ts` times the SQL, not the TypeScript aggregation). Replace with
  precomputed aggregates per (country, department, level, title) kept up to date on write, or refreshed by a job, and cache
  the responses.
- Offset pagination degrades for deep pages; switch to keyset pagination on `(sort_key, id)`, which the indexes above already support.
- Move to Postgres: concurrent writers (SQLite has one writer), `percentile_cont` for in-database percentiles, materialised
  views for the aggregates, `pg_trgm` or `tsvector` for search, and a proper FX table with effective dates.

## Insights: computed in SQL instead of in Node

### Problem

Every insight called one shared `load()` that read **every employee row** (11 columns, joined to `countries`),
converted each salary to USD in TypeScript (`salary / usd_rate`), then grouped, summed and sorted in memory.
The Pay insights page makes 6 such calls, so one page view read the whole table 6 times. Measured breakdown at 10k
employees: reading the 11-column rows ≈ 8 ms, the USD division ≈ 0.2 ms, sort + percentiles ≈ 2.3 ms. So the cost was
mostly moving rows into Node, not the arithmetic.

### Change

- **USD from the stored column.** Every USD figure uses `employees.salary_usd`. No join to `countries` and no division per row.
- **Counts, totals, averages, min/max** come from SQL `GROUP BY` with `COUNT`/`SUM`/`AVG`/`MIN`/`MAX`.
- **Percentiles** (median, P25, P75, P99) are read from a **sorted index**: `ORDER BY value LIMIT 1 OFFSET k` with `k`
  computed from the group's `COUNT(*)`. SQLite walks the index and returns one number, with no sort. Two lookups give the
  same linear interpolation as before (Excel `PERCENTILE.INC`).
- **Histogram** buckets come from `GROUP BY bucket`.
- **Pay equity:** the peer-group columns are streamed from a covering index already sorted by
  (title, level, country, salary), so each group's median is just its middle value. Then one SQL statement finds each
  group's underpaid people with an index range search (`salary < threshold × median`), orders them and computes
  `totalFlagged` / `totalGapUsd`. The USD gap is computed only for flagged rows.
- **Indexes** (net +1):
  - `(department)` → `(department, salary_usd)`
  - new `(level, salary_usd)`
  - `(job_title, level, country_code)` → `(job_title, level, country_code, salary)`

  `(country_code, salary)` and `(salary_usd)` already existed. Old database files drop the replaced indexes on open.
  Every percentile lookup now runs as `SEARCH … USING COVERING INDEX`. The only temp B-tree left is the histogram's
  `GROUP BY` over at most 16 buckets.

### Rejected: window functions

`ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)` keeps percentiles fully in SQL, but measured **slower** than the original
JavaScript, because SQLite sorts and buffers every row:

| Approach | Pay equity, 10k | Pay equity, 100k | Insights page, 10k | Insights page, 100k |
|---|---:|---:|---:|---:|
| Original (all rows into Node) | 9.35 ms | 103.51 ms | 59.90 ms | 709.80 ms |
| Window functions | 123.83 ms | 2,612.21 ms | 202.14 ms | 3,480.70 ms |
| One indexed `OFFSET` query per peer group (~870 groups) | 12.87 ms | 22.61 ms | | |
| **Final (index lookups + covering-index stream for peer medians)** | **4.28 ms** | **38.41 ms** | **14.69 ms** | **148.92 ms** |

(The per-group `OFFSET` row is from a standalone prototype of pay equity only. At 10k its ~1,700 tiny queries cost more
in per-call overhead than streaming the sorted index once.)

### Before / after

`npm run bench:insights`, median of 30 runs after 5 warm-ups, Apple M1, Node v26.4.0. All times in ms.

| Call | Before, 10k | After, 10k | Before, 100k | After, 100k |
|---|---:|---:|---:|---:|
| summary | 11.87 | 1.86 | 132.88 | 20.65 |
| byCountry | 10.85 | 3.88 | 128.96 | 46.24 |
| byDepartment | 9.33 | 1.17 | 117.37 | 11.04 |
| byLevel | 9.36 | 1.53 | 112.51 | 12.20 |
| distribution (org, USD) | 9.14 | 1.95 | 114.57 | 20.38 |
| distribution (IN, local) | 1.86 | 0.64 | 26.41 | 6.20 |
| benchmark (Data Engineer, L3, AE) | 0.04 | 0.10 | 0.11 | 0.13 |
| payEquity (default) | 9.35 | 4.28 | 103.51 | 38.41 |
| **Insights page (6 calls)** | 59.90 | 14.69 | 709.80 | 148.92 |

The insights page is **4.1× faster at 10k** and **4.8× faster at 100k**. The single benchmark lookup got slower
(0.04 → 0.10 ms) because it now makes a few indexed lookups instead of one filtered read; it is still a tenth of a
millisecond. The sort and arithmetic no longer block Node's event loop for 100+ ms at 100k rows. That mattered because
the synchronous driver means a long insight call delays every other request.

Write cost of the index changes was within noise: seeding 10k took 142.9 → 137.6 ms, and a salary change
0.125 → 0.121 ms (medians of 7 runs).

### Correctness

- The old and new implementations were run side by side on the full 10k seed and every returned value compared
  (5,218 values). All local-currency figures, medians, percentiles and averages are **identical**. Pay equity flags the
  same people with the same numbers and the same total gap ($6,570,767 at threshold 0.8).
- Expected differences come from using the rounded per-employee `salary_usd`:
  - USD totals move by a few dollars (largest: total payroll −$46 on $653,374,519, 0.00001%).
  - One employee sits exactly on a histogram bucket boundary and moves to the next bucket.
- Pay-equity order among near-ties is now exact. The old code rounded the ratio to 3 decimals before sorting, so
  0.5709 and 0.5714 tied and their order depended on grouping order.
- `test/insights-repository.test.ts` checks every SQL aggregate, percentile, histogram and pay-equity result against a
  plain in-memory oracle on 1,500 seeded employees. A planted off-by-one in the percentile lookup fails 6 of its 10 tests.

## Future improvements

### SQLite-backed API response cache (designed, not built)

**Why:** insights responses are recomputed on every request. That's ~15 ms per Pay insights page at 10k employees
and ~146 ms at 100k (measured above). The data changes rarely (salary edits) and is read often (dashboard, assistant
tools), so the same answers get recomputed again and again. A cache makes repeat reads a single indexed lookup. It also
stops large insight calls from blocking the synchronous API for other requests.

**Why SQLite and not Redis:** no extra server to run. More importantly, the cache can live in the **same database file**
as the salaries, so it can be invalidated **inside the same transaction** as the write that makes it stale. With an
external cache, invalidation is a separate step after the commit, and a crash in between leaves stale data behind.

**Design:**
- `api_cache(key TEXT PRIMARY KEY, version INTEGER, body TEXT, created_at TEXT)`. `key` is the normalised request
  (path + sorted query), e.g. `/api/insights/benchmark?country=AE&jobTitle=Data+Engineer`.
- `data_version` is a one-row counter. `AFTER INSERT / UPDATE / DELETE` triggers on `employees` (and on `countries`, for
  FX rate changes) increment it, so every write path bumps it, including the seed script and direct SQL. The counter
  update is part of the writing transaction.
- On a request, serve `body` only if its `version` equals the current `data_version`. Otherwise compute, store with
  the current version, and return. Stale entries never need a bulk delete because they simply stop matching; a periodic
  `DELETE … WHERE version < current` reclaims space.
- Scope: `/api/insights/*` and `/api/meta`. Not the employee list or search: they change constantly and already take
  under 0.2 ms.
- An `X-Cache: HIT | MISS` response header for visibility, and a test that a salary change makes the next insights
  response fresh.

**Durability:**
- The cache is a file on disk, so it survives API crashes and restarts. With `synchronous=NORMAL`, a power loss may drop
  the last few cache writes.
- On hosting with an ephemeral disk (Render free plan) it's wiped on restart together with the data, which is re-seeded.
- Losing the cache is always harmless: entries are recomputed on the next request. Correctness depends only on the
  version check, never on the cache surviving.

**Costs and limits:**
- One extra tiny write (the counter) per employee write.
- Cache fills add writes to SQLite's single-writer lock.
- Works for one server (or several processes sharing the file). With several servers on separate disks, a shared
  cache (Redis) or HTTP caching with `ETag` keyed on `data_version` would be needed.

**When to build it:** when headcount approaches ~100k, when several people use the dashboard at once, or if the
assistant's tool calls become a noticeable share of API load. At 10k employees and one HR user the gain is small
(~15 ms per page view), which is why it isn't built yet.
