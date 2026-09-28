# Cloudflare feed watchdog

This Worker checks the public StreamCorner feed status every five minutes. It asks GitHub to run `update-feed.yml` on `main` only when `status.json` is more than 10 minutes old, no active run appears among the latest 20 workflow runs, and the newest completed run was updated more than 5 minutes ago. The cooldown uses the run's `updated_at` timestamp, so long running work receives a full five-minute quiet period after completion. These thresholds are configurable in `wrangler.toml`.

The Worker uses one Cron Trigger and two small HTTP requests per check at most. Cloudflare's Workers Free plan currently includes Cron Triggers; the account-wide free allowance is five triggers. The schedule uses UTC.

## Configure and deploy

1. Install Node.js and Wrangler, then authenticate Wrangler to the Cloudflare account that will own the Worker.
2. Create a GitHub fine-grained personal access token restricted to `guillosan21/streamcorner-tv-feed` with repository `Actions: read and write` permission. The Worker needs read access to list workflow runs and write access to dispatch one.
3. From this directory, store the token as a Cloudflare secret. Wrangler prompts for the value; do not put it in a source file or commit it:

   ```powershell
   npx wrangler secret put GITHUB_TOKEN
   ```

4. Deploy the Worker and its five-minute Cron Trigger:

   ```powershell
   npx wrangler deploy
   ```

The repository's `update-feed.yml` already enables `workflow_dispatch`. Keep the workflow file name and branch in `wrangler.toml` aligned if either changes. Public URLs and repository identifiers have defaults in the Worker source, which makes dashboard script deployment require only the `GITHUB_TOKEN` secret. `wrangler.toml` repeats those values and timing thresholds for reproducible CLI deployments. The token is only a Cloudflare secret binding.

## Verify locally

Run the mocked-fetch and fixed-clock tests with:

```powershell
node --test
```

Tests cover fresh and stale feeds, an active run, the dispatch cooldown, GitHub rate limiting, malformed feed status, and a failed dispatch. They do not contact GitHub or Cloudflare.

## Behavior and limits

- An invalid or unavailable feed status fails closed: the Worker skips dispatch rather than guessing that the feed is stale.
- An unavailable or rate-limited Actions API also skips dispatch. GitHub remains responsible for the actual run and Pages deployment.
- The Actions workflow does not cancel an already running Pages deployment when another run enters the concurrency group.
- A dispatch is not an immediate publication guarantee. The Worker only repairs missed or delayed GitHub schedules; it does not inspect provider health or deploy the feed itself.
- The secret is scoped to the feed repository. Rotate it in GitHub and update the Cloudflare secret if it is revoked or expires.

References: [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), and [GitHub workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow).
