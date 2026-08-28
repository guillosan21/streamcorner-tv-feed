# StreamCorner TV feed

Automatically refreshed owner-authorized StreamCorner, TimStreams, and PPV.st game and stream feed for the StreamCorner Android TV app.

All event-based sports leagues from the three providers are retained in the feed. The Android app keeps profile favorite pickers separately restricted to its curated major-league catalog.

The scheduled GitHub Actions job requests a rebuild and deployment of `games.json` every 5 minutes, the fastest supported GitHub Actions schedule. The app checks that feed every minute. TimStreams embeds are resolved to direct signed HLS sources during each update, while PPV.st entries retain canonical secure player URLs for the app's isolated web-player fallback. Each entry includes live scores, the previous four days of major-league results, sport metadata, and an `is24x7` flag so the Android TV app can separate permanent sports channels from live events. Entertainment 24/7 entries such as TV shows and movie channels are excluded automatically.
