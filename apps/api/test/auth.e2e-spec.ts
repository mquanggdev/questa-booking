import {
  createTestApp,
  createUserAndLogin,
  refreshCookie,
  resetDatabase,
  type TestApp,
} from './support/app.js';

describe('Auth (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  const register = (body: object) =>
    t.http().post('/api/v1/auth/register').send(body);
  const login = (email: string, password: string) =>
    t.http().post('/api/v1/auth/login').send({ email, password });
  const refresh = (cookie?: string) => {
    const req = t.http().post('/api/v1/auth/refresh');
    return cookie ? req.set('Cookie', cookie) : req;
  };

  describe('register', () => {
    it('creates a CUSTOMER and never returns the password hash', async () => {
      const res = await register({
        email: '  Jane@Example.COM ',
        password: 'long-enough-pw',
        fullName: 'Jane',
      }).expect(201);

      expect(res.body).toEqual({
        id: expect.any(String),
        email: 'jane@example.com',
        fullName: 'Jane',
        role: 'CUSTOMER',
      });
      const stored = await t.prisma.user.findUniqueOrThrow({
        where: { email: 'jane@example.com' },
      });
      expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('rejects a duplicate email with EMAIL_TAKEN', async () => {
      const body = {
        email: 'a@b.co',
        password: 'long-enough-pw',
        fullName: 'A',
      };
      await register(body).expect(201);
      const res = await register({ ...body, email: 'A@B.CO' }).expect(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
    });

    it('returns field-level validation errors', async () => {
      const res = await register({
        email: 'not-an-email',
        password: 'short',
        fullName: '',
      }).expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
      const fields = (res.body.details as { field: string }[]).map(
        (d) => d.field,
      );
      expect(fields).toEqual(
        expect.arrayContaining(['email', 'password', 'fullName']),
      );
    });

    it('rejects unknown fields such as a self-assigned role', async () => {
      const res = await register({
        email: 'x@y.co',
        password: 'long-enough-pw',
        fullName: 'X',
        role: 'ORGANIZER',
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('login', () => {
    it('returns an access token and sets an httpOnly refresh cookie', async () => {
      await register({
        email: 'u@t.co',
        password: 'long-enough-pw',
        fullName: 'U',
      });
      const res = await login('u@t.co', 'long-enough-pw').expect(200);

      expect(res.body).toMatchObject({
        accessToken: expect.any(String),
        expiresIn: 900,
        user: { email: 'u@t.co', role: 'CUSTOMER' },
      });
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/refresh_token=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      await register({
        email: 'u@t.co',
        password: 'long-enough-pw',
        fullName: 'U',
      });
      const wrongPassword = await login('u@t.co', 'wrong-password').expect(401);
      const unknownEmail = await login('nobody@t.co', 'whatever-pw').expect(
        401,
      );
      expect(wrongPassword.body).toEqual(unknownEmail.body);
      expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('access token', () => {
    it('is required on protected routes', async () => {
      const res = await t.http().get('/api/v1/users/me').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects a tampered token', async () => {
      const user = await createUserAndLogin(t);
      const tampered = `${user.accessToken.slice(0, -2)}xx`;
      await t
        .http()
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
    });

    it('identifies the user on /users/me', async () => {
      const user = await createUserAndLogin(t);
      const res = await t
        .http()
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(res.body).toMatchObject({ id: user.id, email: user.email });
    });
  });

  describe('refresh token rotation', () => {
    it('issues a new token and invalidates the old one', async () => {
      const user = await createUserAndLogin(t);
      const first = await refresh(user.cookie).expect(200);
      const rotated = refreshCookie(first.headers['set-cookie']);

      expect(rotated).not.toEqual(user.cookie);
      expect(first.body.accessToken).toEqual(expect.any(String));
      await refresh(rotated).expect(200);
    });

    it('revokes the whole family when an old token is replayed', async () => {
      const user = await createUserAndLogin(t);
      const first = await refresh(user.cookie).expect(200);
      const current = refreshCookie(first.headers['set-cookie']);

      // An attacker replays the stolen, already-rotated token.
      const replay = await refresh(user.cookie).expect(401);
      expect(replay.body.code).toBe('REFRESH_TOKEN_REUSED');

      // The legitimate holder of the newest token is logged out too.
      const after = await refresh(current).expect(401);
      expect(after.body.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('lets exactly one of two concurrent refreshes with the same token win', async () => {
      const user = await createUserAndLogin(t);
      const results = await Promise.all([
        refresh(user.cookie),
        refresh(user.cookie),
      ]);
      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses).toEqual([200, 401]);
    });

    it('rejects a missing or unknown cookie', async () => {
      expect((await refresh().expect(401)).body.code).toBe(
        'INVALID_REFRESH_TOKEN',
      );
      expect(
        (await refresh('refresh_token=does-not-exist').expect(401)).body.code,
      ).toBe('INVALID_REFRESH_TOKEN');
    });

    it('rejects an expired token', async () => {
      const user = await createUserAndLogin(t);
      await t.prisma.refreshToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await refresh(user.cookie).expect(401);
      expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
    });
  });

  describe('logout', () => {
    it('revokes the refresh token and clears the cookie', async () => {
      const user = await createUserAndLogin(t);
      const res = await t
        .http()
        .post('/api/v1/auth/logout')
        .set('Cookie', user.cookie)
        .expect(204);

      expect(String(res.headers['set-cookie'])).toMatch(/refresh_token=;/);
      await refresh(user.cookie).expect(401);
    });

    it('succeeds without a cookie', async () => {
      await t.http().post('/api/v1/auth/logout').expect(204);
    });
  });
});
