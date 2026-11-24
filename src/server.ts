import { createApp } from './app';
import { config } from './config';
import { openDb } from './db/connection';
import { seedDatabase } from './db/seed';
import { createLlmClientFromEnv } from './lib/llm-client';

console.log(`Environment: ${process.env.NODE_ENV ?? '(NODE_ENV not set)'}`);
const db = openDb(config.dbPath);

const { n } = db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number };
if (n === 0 && config.seedIfEmpty) {
  const started = Date.now();
  seedDatabase(db, 10_000);
  console.log(`Empty database: seeded 10,000 employees in ${Date.now() - started} ms`);
}

const llm = createLlmClientFromEnv();
console.log(llm ? `AI assistant enabled (model ${llm.model})` : 'AI assistant disabled: set LLM_API_KEY to enable it');

const cors = config.corsOrigins;
if (cors === '*') console.warn('CORS: any origin is allowed (CORS_ORIGIN=*). Not recommended in production.');
else if (cors.length) console.log(`CORS: ${cors.join(', ')}`);
else console.warn('CORS: CORS_ORIGIN is not set, so only same-origin requests work. A frontend on another URL (e.g. the Next dev server or Vercel) will be blocked.');

const app = createApp(db, { staticDir: config.staticDir, llm, corsOrigins: config.corsOrigins });
const server = app.listen(config.port, () => console.log(`Salary Manager listening on http://localhost:${config.port}`));

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
