# Cloudflare feed watchdog

This Worker checks the public StreamCorner feed status every five minutes. It asks GitHub to run `update-feed.yml` on `main` only when `status.json` is more than 10 minutes old, no active run appears among the latest 20 workflow runs, and the newest completed run was updated more than 5 minutes ago. The cooldown uses the run's `updated_at` timestamp, so long running work receives a full five-minute quiet period after completion. These thresholds are configurable in `wrangler.toml`.

The Worker uses one Cron Trigger and two small HTTP requests per check at most. Cloudflare's Workers Free plan currently includes Cron Triggers; the account-wide free allowance is five triggers. The schedule uses UTC.

## Configure and deploy

1. Install Node.js and Wrangler, then authenticate Wrangler to the Cloudflare account that will own the Worker.
2. Create a GitHub fine-grained personal access token restricted to `guillosan21/streamcorner-tv-feed` with repository `Actions: write` permission. The configured public workflow-runs endpoint is read without a token; if changing the Worker to a private or custom repository, grant the token `Actions: read` as well.
3. From this directory, store the token as a Cloudflare secret. Wrangler prompts for the value; do not put it in a source file or commit it:

   ```powershell
   npx wrangler secret put GITHUB_TOKEN
   ```

4. Deploy the Worker and its five-minute Cron Trigger:

   ```powershell
   npx wrangler deploy
   ```

The repository's `update-feed.yml` already enables `workflow_dispatch`. Keep the workflow file name and branch in `wrangler.toml` aligned if either changes. Public URLs and repository identifiers have defaults in the Worker source, which makes dashboard script deployment require only the `GITHUB_TOKEN` secret. `wrangler.toml` repeats those values and timing thresholds for reproducible CLI deployments. The token is only a Cloudflare secret binding.

Both worker variants log one structured diagnostic per scheduled run with `stage`, `action`, `reason`, and, when available, `httpStatus`. GitHub API failures may also include bounded numeric rate-limit fields (`rateLimitLimit`, `rateLimitRemaining`, `rateLimitReset`, `retryAfterSeconds`), an allowlisted `rateLimitResource`, boolean `hasGitHubRequestId` and `contentTypeJson`, and a fixed `githubErrorCategory`. The runs-error parser retains and parses at most 2 KiB of response content, requests non-blocking cancellation for larger bodies, and maps recognized GitHub messages only when a GitHub request ID is present; it never logs body text. Fetch exceptions use fixed reason codes; the Worker never logs the token, request URL, response body, raw error text, or raw header values. A dispatch HTTP rejection (`workflow-dispatch-http-failed`) is distinct from a thrown dispatch request (`workflow-dispatch-fetch-failed`). `dashboard-worker.js` is kept on one line for direct use in the Cloudflare dashboard editor and can be copied there to collect these diagnostics.

## Verify locally

Run the mocked-fetch and fixed-clock tests with:

```powershell
node --test
```

Tests cover fresh and stale feeds, an active run, the dispatch cooldown, GitHub rate limiting, malformed feed status, and a failed dispatch. They do not contact GitHub or Cloudflare.

## Behavior and limits

- An invalid or unavailable feed status fails closed: the Worker skips dispatch rather than guessing that the feed is stale.
- For `guillosan21/streamcorner-tv-feed`, the Worker makes one unauthenticated workflow-runs GET because the repository is public. Other configured repositories use the token for that GET. Any non-success response, including 401, 403, or 429, fails closed without a retry. The workflow dispatch request always uses the configured token.
- An unavailable or rate-limited Actions API also skips dispatch. GitHub remains responsible for the actual run and Pages deployment.
- The Actions workflow does not cancel an already running Pages deployment when another run enters the concurrency group.
- A dispatch is not an immediate publication guarantee. The Worker only repairs missed or delayed GitHub schedules; it does not inspect provider health or deploy the feed itself.
- The secret is scoped to the feed repository. Rotate it in GitHub and update the Cloudflare secret if it is revoked or expires.

References: [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), and [GitHub workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow).
