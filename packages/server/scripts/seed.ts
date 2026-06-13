// Dev seed: fixed well-known ids, idempotent, and the welcome note goes through the
// REAL create path (core-validated, origin=system) — seeds are canonical values by
// construction, never raw-SQL approximations.
import pg from 'pg';
import { v5 as uuidv5 } from 'uuid';
import { createObject } from '../src/core/index.js';
import { insertObjectWithProvenance } from '../src/db/objects.js';
import { withTransaction } from '../src/db/pool.js';
import { ensurePersonalSpace, upsertUser } from '../src/db/users.js';

// Same namespace as the dev-idp, so the seeded user IS the user dev@mathmeander.local
// logs in as.
const SUBJECT_NAMESPACE = '6f7cf3f4-32a8-44a5-9b8b-0e6a3a3d9d10';

const DEV_EMAIL = 'dev@mathmeander.local';
const FIXED = {
  userId: '01976000-0000-7000-8000-000000000001',
  spaceId: '01976000-0000-7000-8000-000000000002',
  welcomeNoteId: '01976000-0000-7000-8000-000000000003',
  welcomeProvenanceId: '01976000-0000-7000-8000-000000000004',
};

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mathmeander:mathmeander@localhost:5432/mathmeander_dev?sslmode=disable';
const issuer = process.env.AUTH_ISSUER ?? 'http://localhost:8788';

const db = new pg.Pool({ connectionString: databaseUrl });
const now = new Date();

const user = await upsertUser(
  db,
  {
    id: FIXED.userId,
    idpIssuer: issuer,
    idpSubject: uuidv5(DEV_EMAIL, SUBJECT_NAMESPACE),
    email: DEV_EMAIL,
  },
  now,
);
const space = await ensurePersonalSpace(db, user.id, FIXED.spaceId, now);

const existing = await db.query('SELECT 1 FROM objects WHERE id = $1', [FIXED.welcomeNoteId]);
if (existing.rowCount === 0) {
  const result = createObject(
    {
      id: FIXED.welcomeNoteId,
      type: 'note',
      title: 'Welcome to MathMeander',
      raw_source:
        'This note was created through the real core-validated path.\n' +
        'Try writing rough math: $e^{i\\pi} + 1 = 0$ — it is preserved verbatim.',
    },
    { provenance_id: FIXED.welcomeProvenanceId, origin: 'system', created_by: 'seed' },
    space.id,
    now,
  );
  if (!result.ok) {
    throw new Error(`seed welcome note failed core validation: ${JSON.stringify(result.error)}`);
  }
  await withTransaction(db, (client) =>
    insertObjectWithProvenance(client, result.value.object, result.value.provenance),
  );
  console.log('seeded welcome note');
} else {
  console.log('welcome note already present');
}

console.log(`seeded: user ${user.id} (${DEV_EMAIL}), space ${space.id}`);
await db.end();
