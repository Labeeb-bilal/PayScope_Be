import path from 'node:path';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  dbPath: process.env.DB_PATH ?? path.resolve(__dirname, '../data/app.db'),
  /** Directory with the built Next.js static export. Served when present. */
  staticDir: process.env.STATIC_DIR ?? path.resolve(__dirname, '../../frontend/out'),
  /** Seed automatically when the database is empty (useful on ephemeral hosting). */
  seedIfEmpty: process.env.SEED_IF_EMPTY !== 'false',
};
