# StreamCorner TV feed

Automatically refreshed owner-authorized StreamCorner, TimStreams, and PPV.st game and stream feed for the StreamCorner Android TV app.

All event-based sports leagues from the three providers are retained in the feed. The Android app keeps profile favorite pickers separately restricted to its curated major-league catalog.

The scheduled GitHub Actions job requests a rebuild and deployment of `games.json` every 5 minutes, the fastest supported GitHub Actions schedule. The app checks that feed every minute. TimStreams manifests are verified during each live refresh, while playback uses the provider's stable watch-page/referrer chain so short-lived signed URLs do not expire before viewing. PPV.st entries retain canonical secure player URLs for the app's isolated web-player fallback. Offline live sources are omitted, and every source name includes its provider. Feed generation fails before deployment if a provider label disagrees with its verified playback endpoint, or if mergeable duplicate events remain. Schedule-backed cards carry stable ESPN event IDs and name-based matching is limited to clock-rounding tolerance to protect doubleheaders. Each entry includes live scores, the previous four days of major-league results, sport metadata, and an `is24x7` flag so the Android TV app can separate permanent sports channels from live events. Entertainment 24/7 entries such as TV shows and movie channels are excluded automatically.

TimStreams catalog reads retry transient `events: null` rotation responses across both `timstreams.st` and `timst.cfd`. PPV mirrors rediscovered through another catalog are collapsed into PPV's single canonical event player, while independent StreamCorner and TimStreams feeds remain available.
