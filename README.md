# First Blood Uploader

A small Windows tray application that records completed League of Legends **ARAM: Mayhem** matches and uploads them to the First Blood dashboard at [hollowpoints.gg/first-blood](https://hollowpoints.gg/first-blood).

It records the match ID, participating Riot IDs, champions, kills, wins, first-kill and first-death players, pentakills, and the final local League client snapshot. Multiple friends can record the same match: the website deduplicates by Riot match ID and merges the most complete observations.

## Installing

Download the latest `FirstBloodUploader-Setup.exe` from this repository's Releases page. On first launch:

1. Open **Settings**.
2. Give the PC a recognizable name.
3. Enter the temporary invite code supplied by the site owner.
4. Confirm the League installation folder and choose **Register and save**.

The application can start with Windows and minimize to the system tray. **Check for updates** securely downloads the newest Velopack release and restarts the application.

## Privacy and credentials

Configuration, device credentials, logs, local match data, and upload history are stored under `%LOCALAPPDATA%\FirstBloodUploader`; they are never included in this repository or a release package. Each installation receives a unique revocable credential. The server stores only its SHA-256 hash and rate-limits both device and IP traffic.

Successful and duplicate uploads are permanently recorded locally. Authentication failures, throttling, and temporary server problems remain retryable. Invalid match records are marked as unable to complete.

## Building locally

Requirements: Node.js 22+, the .NET 10 SDK, and Windows.

```powershell
npm install
npm test
npm run build:recorder
dotnet publish desktop/FirstBloodUploader/FirstBloodUploader.csproj -c Release -r win-x64 --self-contained true -o release/publish
Copy-Item FirstBloodRecorder.exe release/publish/FirstBloodRecorder.exe
```

The release workflow is triggered by a version tag such as `v1.1.0`. It builds the recorder and uploader, packages them with pinned Velopack 1.2.0, and publishes the installer and update feed through GitHub Releases.

## Riot Games notice

This project is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered trademarks of Riot Games, Inc.
