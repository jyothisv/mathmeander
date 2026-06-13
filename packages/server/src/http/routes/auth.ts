// Session lifecycle. The IdP JWT is used EXACTLY ONCE (at exchange); requests then
// carry an opaque server session token — "issue session, invalidate prior on new
// login" (arch doc §7), with the single-session rule isolated in auth/policy.ts.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import { AppError } from '../errors.js';
import { onSessionCreate } from '../../auth/policy.js';
import {
  findActiveSession,
  hashToken,
  insertSession,
  mintSessionToken,
  revokeSession,
} from '../../db/sessions.js';
import { ensurePersonalSpace, findPersonalSpace, upsertUser } from '../../db/users.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface RequestContext {
  userId: string;
  sessionId: string;
  spaceId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext | null;
  }
}

/** Resolve the request's session or 401. Space is resolved server-side — requests
 *  never carry space_id (multi-space is reserved; arch doc §6). */
export async function requireSession(deps: AppDeps, req: FastifyRequest): Promise<RequestContext> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHENTICATED', 'missing bearer token');
  }
  const now = deps.now();
  const session = await findActiveSession(deps.db, hashToken(header.slice(7)), now);
  if (!session) {
    throw new AppError(401, 'SESSION_REVOKED', 'session is revoked, expired, or unknown');
  }
  // Created at session exchange; absent here means a server-side invariant broke.
  const space = await findPersonalSpace(deps.db, session.user_id);
  if (!space) throw new Error(`user ${session.user_id} has no personal space`);
  return { userId: session.user_id, sessionId: session.id, spaceId: space.id };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post(
    '/api/auth/sessions',
    { schema: { body: z.object({ idp_token: z.string().min(1) }) } },
    async (req, reply) => {
      const { idp_token } = req.body as { idp_token: string };
      const now = deps.now();

      let identity: { subject: string; email: string | null };
      try {
        identity = await deps.idpVerifier.verify(idp_token);
      } catch {
        throw new AppError(401, 'UNAUTHENTICATED', 'IdP token rejected');
      }

      const user = await upsertUser(
        deps.db,
        {
          id: uuidv7(),
          idpIssuer: deps.env.AUTH_ISSUER,
          idpSubject: identity.subject,
          email: identity.email,
        },
        now,
      );
      const space = await ensurePersonalSpace(deps.db, user.id, uuidv7(), now);

      const { token, tokenHash } = mintSessionToken();
      const sessionId = uuidv7();
      await insertSession(
        deps.db,
        {
          id: sessionId,
          userId: user.id,
          tokenHash,
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        },
        now,
      );
      const { revoked } = await onSessionCreate(deps.db, user.id, sessionId, now);
      req.log.info({ userId: user.id, revoked }, 'session created');

      return reply.status(201).send({
        token,
        user: { id: user.id, email: user.email },
        space: { id: space.id },
      });
    },
  );

  app.delete('/api/auth/sessions/current', async (req, reply) => {
    const ctx = await requireSession(deps, req);
    await revokeSession(deps.db, ctx.sessionId, deps.now());
    return reply.status(204).send();
  });
}
