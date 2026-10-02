import { createTestApp, type TestApp } from './support/app.js';

describe('Health (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /api/v1/health returns 200 without a token', () => {
    return t.http().get('/api/v1/health').expect(200).expect({ status: 'ok' });
  });

  it('GET /api/v1/health/ready reports database and Redis up', () => {
    return t
      .http()
      .get('/api/v1/health/ready')
      .expect(200)
      .expect({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });
});
