import createClient from 'openapi-fetch';
import type { paths } from './schema';

/**
 * Client for Server Components: talks to the API over the internal network
 * (http://api:3000 in Docker). Public endpoints only; user-specific data is
 * fetched in the browser, where the access token lives.
 */
export const serverApi = createClient<paths>({
  baseUrl: process.env.API_INTERNAL_URL ?? 'http://localhost:3100',
});
