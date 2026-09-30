# Sports Lounge TV feed

SportsUpa HD Main sources are collected from exact public event-selection topics and included before ESPN schedule reconciliation. Each run requires the site's current Main HD declaration and decodes only a strict public RockyStream bootstrap into a stable, query-free Main ingest route. Signed media URLs and session credentials are not published. Admin remains excluded until its normal Android TV playback route is verified. Collection is bounded to 18 prioritized events; broker or provider failures can omit SportsUpa sources without changing other providers.

GitHub's scheduled events are best-effort and may be delayed or dropped. A guaranteed five-minute publication cadence requires an independent scheduler to call this workflow's existing `workflow_dispatch` trigger; the cron alone is not a freshness guarantee.

Automatically refreshed TimStreams, PPV.st, Sports Streams, DLStreams, and Pizarra MX game and stream feed for the Android TV app.

All event-based sports leagues from the configured feeds are retained in the feed. The Android app keeps profile favorite pickers separately restricted to its curated major-league catalog.

The scheduled GitHub Actions job requests a rebuild and deployment of `games.json` every 5 minutes, the fastest supported GitHub Actions schedule. The app checks that feed every minute. TimStreams manifests are verified during each live refresh, while playback uses the provider's stable watch-page/referrer chain so short-lived signed URLs do not expire before viewing. PPV.st entries retain canonical secure player URLs for the app's isolated web-player fallback. Offline live sources are omitted, and every source name includes its provider. Feed generation fails before deployment if a provider label disagrees with its verified playback endpoint, or if mergeable duplicate events remain. Schedule-backed cards carry stable ESPN event IDs and name-based matching is limited to clock-rounding tolerance to protect doubleheaders. Each entry includes live scores, the previous four days of major-league results, sport metadata, and an `is24x7` flag so the Android TV app can separate permanent sports channels from live events. Entertainment 24/7 entries such as TV shows and movie channels are excluded automatically.

Schema version 2 marks generated events as deduplicated and final-event filtered. Compatible app versions can trust those guarantees and display the cached catalog immediately instead of repeating expensive reconciliation on low-power TV hardware.

TimStreams catalog reads retry transient `events: null` rotation responses across both `timstreams.st` and `timst.cfd`. PPV mirrors rediscovered through another catalog are collapsed into PPV's single canonical event player.
