import { openDb } from './connection';
import { seedDatabase } from './seed';
import { config } from '../config';

const count = Number(process.argv[2] ?? 10_000);
const started = Date.now();
const db = openDb(config.dbPath);
const inserted = seedDatabase(db, count);
db.close();
console.log(`Seeded ${inserted} employees into ${config.dbPath} in ${Date.now() - started} ms`);
