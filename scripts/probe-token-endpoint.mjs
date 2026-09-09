// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Asks the OAuth token endpoint whether it will accept the shape of request the
 * refresher sends, without spending anything.
 *
 * The refresh token below is deliberately invalid, so there is nothing to
 * redeem and no credential can be rotated, written or lost. That is what makes
 * this safe to run at any time, and it is the check that distinguishes the two
 * failures a unit test cannot tell apart:
 *
 *   400 invalid_grant   the request reached the application and was understood
 *   429, no request id  refused at the edge before it was ever looked at
 *
 * The second one reads as rate limiting and is not. See `docs/DECISIONS.md`
 * section 2 — a user agent that claims to be Claude Code is refused here, and
 * the same string is *required* on the usage endpoint.
 *
 *   node scripts/probe-token-endpoint.mjs [user-agent]
 */

const ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_BETA = 'oauth-2025-04-20';

const userAgent = process.argv[2] ?? 'claude-usage-graph';

const response = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'anthropic-beta': OAUTH_BETA,
    'User-Agent': userAgent,
  },
  body: JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: 'not-a-real-token-diagnostic-probe',
    client_id: CLIENT_ID,
  }),
});

const body = await response.text().catch(() => '');
const reachedApp = response.headers.get('request-id') !== null;

console.log(`user-agent  ${userAgent}`);
console.log(`status      ${response.status} ${response.statusText}`);
console.log(`reached app ${reachedApp}${reachedApp ? '' : '  <- refused at the edge, not rate limited'}`);
console.log(`body        ${body.slice(0, 300).replace(/\s+/g, ' ')}`);

process.exitCode = reachedApp ? 0 : 1;
