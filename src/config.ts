import path from 'node:path';
import { parseCorsOrigins } from './lib/cors';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  dbPath: process.env.DB_PATH ?? path.resolve(__dirname, '../data/app.db'),
  staticDir: process.env.STATIC_DIR ?? path.resolve(__dirname, '../../frontend/out'),
  seedIfEmpty: process.env.SEED_IF_EMPTY !== 'false',
  corsOrigins: parseCorsOrigins(),
};
