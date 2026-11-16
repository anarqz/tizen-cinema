# Installing Cinema

Cinema has two parts:

1. **The Cinema server**: a small Node.js service that runs next to your media stack (Docker, TrueNAS, a Raspberry Pi, any always-on machine).
2. **The TV app**: a Tizen web app you sign and install on your Samsung TV once, using Developer Mode.

Budget about 20 minutes the first time, most of it for the Tizen tools.

---

## 1. Run the Cinema server

### Option A: Docker Compose (recommended)

```bash
git clone https://github.com/anarqz/tizen-cinema.git
cd tizen-cinema
docker compose up -d
```

The server listens on port **3817** and keeps its settings in `./data/config.json`.

### Option B: TrueNAS SCALE / other NAS app catalogs

Create a custom app with:

- **Image**: build it from this repo (`docker build -t cinema-backend .`) or run `node:22-alpine` with this repo mounted at `/app` and the command `node server/index.js`
- **Port**: `3817`
- **Storage**: a dataset mounted at `/data`
- **Environment**: `DATA_DIR=/data` (plus any of the optional variables from `.env.example`)

### Option C: plain Node.js

```bash
git clone https://github.com/anarqz/tizen-cinema.git
cd tizen-cinema
node server/index.js          # Node.js 20+, no npm install needed
```

### Configure it

Open **`http://<server-ip>:3817/settings`** on a phone or computer and fill in what you have. A green dot means the connection works.

| Service | Where to find the value |
|---|---|
| Jellyfin URL | The address your **TV** can reach, e.g. `http://192.168.1.10:8096`. Enable **Quick Connect** in Jellyfin → Dashboard → General. |
| TMDB | themoviedb.org → Settings → API → **API Read Access Token** |
| Trakt | trakt.tv/oauth/applications → New application (redirect URI `urn:ietf:wg:oauth:2.0:oob`) → **Client ID** |
| OMDb | omdbapi.com/apikey.aspx (free); click the activation link in the e-mail |
| Sonarr / Radarr / Prowlarr | Settings → General → **API Key** |
| Bazarr | Settings → General → Security → **API Key** (not the Sonarr key shown under Settings → Sonarr) |
| Deluge | Your Web UI password |

You can change all of this later from the TV (**⚙ Settings**).

---

## 2. Prepare the TV

1. **Find your computer's IP address** (the one that will install the app).
2. On the TV, open **Apps**, then type **1 2 3 4 5** on the remote. On remotes without number keys, use the on-screen number pad (the **123** button).
3. Turn **Developer mode: On**, set **Host PC IP** to your computer's address, then **turn the TV fully off and on** (hold the power button until the logo appears).
4. Note the TV's IP address (Settings → General → Network → Network Status → IP Settings).

---

## 3. Install the Tizen CLI and a signing certificate

Download the **Tizen Studio CLI** installer ("web-cli") for your OS from <https://developer.tizen.org/development/tizen-studio/download> and install it:

```bash
./web-cli_Tizen_Studio_<version>_<os>.bin --accept-license ~/tizen-studio
```

Create an author certificate and a security profile named `cinema`:

```bash
~/tizen-studio/tools/ide/bin/tizen certificate -a Cinema -p '<choose-a-password>' -c US -n Cinema -f cinema
~/tizen-studio/tools/ide/bin/tizen security-profiles add -n cinema \
    -a ~/tizen-studio-data/keystore/author/cinema.p12 -p '<the-same-password>'
~/tizen-studio/tools/ide/bin/tizen cli-config "profiles.path=$HOME/tizen-studio-data/profile/profiles.xml"
```

Keep this certificate: later updates must be signed with the same one, or the TV will refuse to replace the app.

---

## 4. Install the app on the TV

```bash
tools/install-tv.sh <tv-ip>            # uses the "cinema" profile
tools/install-tv.sh <tv-ip> my-profile # or another profile name
```

Open **Cinema** from the TV's Apps (you can also pin it to the Home bar). The first time:

1. Enter the **Cinema server address**, e.g. `http://192.168.1.10:3817`.
2. Pick your **profile**. Users hidden from Jellyfin's login screen sign in with **Other user**:
   - **Quick Connect**: in Jellyfin on your phone, open your profile → Quick Connect → type the code shown on the TV.
   - **Password**: available for users listed on the profile screen.

---

## Updating

```bash
git pull
docker compose up -d --build     # server
tools/install-tv.sh <tv-ip>      # TV app (same certificate)
```

Settings and profiles are kept.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `install-tv.sh` says the TV isn't connected | Developer Mode must point at **this** computer's IP, and the TV must be fully restarted afterwards. Port 26101 must be reachable. |
| "Could not reach a Cinema server" on the TV | Use the server's LAN IP (not `localhost`) and check that port 3817 is open. |
| Rows are empty | TMDB (required) or Trakt is missing or invalid. Check the status dots in Settings. |
| Quick Connect code never appears | Enable Quick Connect in the Jellyfin dashboard. |
| "Sync" says the account can't scan | Scanning the Jellyfin library needs an administrator profile. |
| A file plays with conversion or no sound | Some codecs (e.g. DTS audio) aren't supported by every TV; Cinema asks Jellyfin to transcode automatically. Make sure Jellyfin has hardware or enough CPU for transcoding. |
| Subtitles are out of sync | In the player: *Audio & subtitles → Sync with audio (Bazarr)*, or nudge them ±0.25 s. |
