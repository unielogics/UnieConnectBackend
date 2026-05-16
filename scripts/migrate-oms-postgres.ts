import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const connectionString = process.env.AURORA_POSTGRES_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Set AURORA_POSTGRES_URL, POSTGRES_URL, or DATABASE_URL before running OMS migrations.');
  }
  const pool = new Pool({
    connectionString,
    ssl:
      process.env.POSTGRES_SSL === 'false'
        ? false
        : {
            rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED === 'true',
          },
  });
  const migrationDir = path.resolve(process.cwd(), 'migrations');
  const files = fs
    .readdirSync(migrationDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  try {
    await pool.query('CREATE TABLE IF NOT EXISTS oms_schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const file of files) {
      const existing = await pool.query('SELECT filename FROM oms_schema_migrations WHERE filename = $1', [file]);
      if (existing.rowCount) {
        console.log(`Skipping ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query('INSERT INTO oms_schema_migrations (filename) VALUES ($1)', [file]);
        await pool.query('COMMIT');
        console.log(`Applied ${file}`);
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
