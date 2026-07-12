import crypto from 'crypto';

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

export function createSessionManager({
  idleTtlMs = 7 * 24 * 60 * 60 * 1000,
  absoluteTtlMs = 30 * 24 * 60 * 60 * 1000,
} = {}) {
  const sessions = new Map();

  function removeExpired(now = Date.now()) {
    for (const [key, session] of sessions.entries()) {
      if (session.expiresAt <= now || now - session.lastSeenAt > idleTtlMs) {
        sessions.delete(key);
      }
    }
  }

  return {
    create(user) {
      removeExpired();
      const token = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      const session = {
        userId: user.id,
        sessionVersion: user.sessionVersion,
        csrfToken: crypto.randomBytes(24).toString('base64url'),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + absoluteTtlMs,
      };
      sessions.set(tokenHash(token), session);
      return { token, session: { ...session } };
    },

    get(token) {
      if (!token) return null;
      removeExpired();
      const session = sessions.get(tokenHash(token));
      if (!session) return null;
      session.lastSeenAt = Date.now();
      return { ...session };
    },

    destroy(token) {
      if (token) sessions.delete(tokenHash(token));
    },

    destroyForUser(userId) {
      for (const [key, session] of sessions.entries()) {
        if (session.userId === userId) sessions.delete(key);
      }
    },

    cookieMaxAgeSeconds: Math.floor(absoluteTtlMs / 1000),
  };
}
