import { getPostgresPool, pgQuery } from '../src/db/postgres';
import { ensureCortexCredentialForUser } from '../src/services/cortex-credentials.service';

type MissingCredentialUser = {
  id: string;
  email: string;
};

async function main() {
  const res = await pgQuery<MissingCredentialUser>(
    `SELECT u.id, u.email
     FROM app_users u
     LEFT JOIN oms_cortex_credentials c
       ON c.user_id = u.id
      AND c.status = 'active'
      AND c.secret_enc IS NOT NULL
     WHERE c.id IS NULL
     ORDER BY u.created_at ASC`,
  );

  if (!res) {
    throw new Error('Postgres is not configured; cannot backfill Cortex credentials.');
  }

  let provisioned = 0;
  let failed = 0;

  for (const user of res.rows) {
    try {
      const credential = await ensureCortexCredentialForUser(user.id);
      if (credential?.secret_enc) {
        provisioned += 1;
        console.log(`[ok] ${user.email} -> ${credential.api_username}`);
      } else {
        failed += 1;
        console.warn(`[pending] ${user.email} did not receive an active Cortex credential`);
      }
    } catch (error: any) {
      failed += 1;
      console.warn(`[failed] ${user.email}: ${error?.message || error}`);
    }
  }

  console.log(`Cortex credential backfill complete: ${provisioned} active, ${failed} pending/failed, ${res.rows.length} checked.`);

  const pool = getPostgresPool();
  await pool?.end();

  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error?.message || error);
  const pool = getPostgresPool();
  await pool?.end();
  process.exit(1);
});
