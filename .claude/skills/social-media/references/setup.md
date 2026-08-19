# Getting credentials

Every platform here uses its **official API**, which means each one needs a
developer app and an authorized account. This is the slow part; budget an
afternoon the first time, and note that Instagram and TikTok both require
review before they will post publicly.

Credentials go in the registry at `~/.config/social-mcp/accounts.json`. Any
value may be written as `env:VAR_NAME` to read it from the environment instead
of storing the secret on disk — prefer that for anything long-lived.

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "ig_main",
      "platform": "instagram",
      "label": "Main brand",
      "handle": "@brand",
      "tags": ["brand", "en"],
      "credentials": {
        "igUserId": "17841400000000000",
        "accessToken": "env:IG_MAIN_TOKEN"
      }
    }
  ]
}
```

Add accounts with the `add_account` tool rather than editing by hand, then run
`check_account` to confirm each one works. `npx social-mcp --doctor` does the
same check from a terminal.

## Instagram — `igUserId`, `accessToken`

1. The account must be **Business or Creator** and linked to a Facebook Page.
2. Create an app at developers.facebook.com and add **Instagram Graph API**.
3. Request `instagram_basic`, `instagram_content_publish`,
   `instagram_manage_comments`, `instagram_manage_insights`, `pages_show_list`.
4. Get a User access token, then exchange it for a **60-day long-lived token**:
   `GET /oauth/access_token?grant_type=fb_exchange_token&...`
5. Find the IG user id: `GET /me/accounts` → the Page → `?fields=instagram_business_account`.
6. Publishing publicly requires **App Review** for `instagram_content_publish`.

The 60-day token must be refreshed before it expires. Set a reminder.

## YouTube — `clientId`, `clientSecret`, `refreshToken`

1. In Google Cloud Console, enable **YouTube Data API v3** and **YouTube
   Analytics API**.
2. Create an OAuth 2.0 **Desktop app** client.
3. Authorize with scopes `youtube.upload`, `youtube.readonly`,
   `youtube.force-ssl`, `yt-analytics.readonly`, requesting offline access.
4. Exchange the authorization code for a refresh token — that is the durable
   credential; the server refreshes access tokens itself.

A separate refresh token per channel is what makes two YouTube accounts work.
Watch the 10,000/day quota: each upload costs ~1,600 units.

## TikTok — `clientKey`, `clientSecret`, `refreshToken`

1. Register at developers.tiktok.com and add **Content Posting API** plus
   **Login Kit**.
2. Scopes: `user.info.basic`, `user.info.stats`, `video.publish`, `video.list`.
3. Complete OAuth to get a refresh token.
4. **Submit the app for audit.** Until it passes, every post is forced private
   (`SELF_ONLY`) no matter what you request.
5. Domains hosting `PULL_FROM_URL` media must be verified in the developer portal.

The refresh token rotates on each use; the server saves the replacement
automatically.

## X — `clientId`, `refreshToken` (+ `clientSecret` for confidential clients)

1. In the X developer portal create a project and app with **OAuth 2.0** and
   **Read and write** permissions.
2. Scopes: `tweet.read`, `tweet.write`, `users.read`, `offline.access`.
   `offline.access` is what produces the refresh token.
3. Run the PKCE authorization flow once per account.

Free tier allows 17 posts/24h and hides most analytics. Basic ($200/mo) unlocks
`organic_metrics`.

## LinkedIn — `accessToken`, `authorUrn`

1. Create an app at linkedin.com/developers, associated with the company page.
2. Request the **Community Management API** (approval required) or
   **Share on LinkedIn** + **Sign In with OpenID Connect**.
3. Scopes: `w_member_social` (personal) or `w_organization_social` +
   `r_organization_social` + `rw_organization_admin` (company page).
4. `authorUrn` is `urn:li:organization:<id>` for a page, or `urn:li:person:<sub>`
   for a profile — take `sub` from `/v2/userinfo`.

LinkedIn access tokens last 60 days and there is no refresh for member tokens;
re-authorize when it expires.

## Security notes

- The registry is written `0600` in a `0700` directory, but it is still
  plaintext. Use `env:` indirection and keep the secrets in a password manager
  or your shell's secret store.
- Never commit `accounts.json`. The repo's `.gitignore` already excludes it.
- Revoke tokens from the platform's own settings page — deleting the account
  entry here only stops this server from using it.
