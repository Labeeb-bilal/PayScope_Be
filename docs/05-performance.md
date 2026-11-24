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
| 2 | Country + sort by salary | Index finds the ~2.5k IN rows, but they are still sorted in a temp B-tree |
| 3 | Search "pri" | `LIKE` with `OR` across five expressions forces a full `SCAN e` for the count; the page query walks the whole name index checking every row |
| 4 | Benchmark | Already optimal: `idx_employees_peer` matches all three equality columns |
| 5 | Salary history | Already optimal: `idx_salary_changes_employee` serves the filter and the sort |
| 6 | Default page (by name) | Already optimal: walks `idx_employees_name` in order and stops after 25 rows |

`idx_employees_first_name` appears only as the narrowest index for `SELECT COUNT(*)`, which any index (or the table) can serve.
`idx_employees_name` is **used** by queries 3 and 6.
