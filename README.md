# StreamCorner TV feed

Automatically refreshed owner-authorized game and stream feed for the StreamCorner Android TV app.

The scheduled GitHub Actions job rebuilds and deploys `games.json` to GitHub Pages every 5 minutes, the fastest supported GitHub Actions schedule. The app checks that feed every minute. Each entry includes live scores, the previous four days of major-league results, sport metadata, and an `is24x7` flag so the Android TV app can separate permanent sports channels from live events. Entertainment 24/7 entries such as TV shows and movie channels are excluded automatically.
