# Smart Self Check Kiosk

A Windows kiosk system for visitor check-in and digital signage. Each kiosk loops its assigned slides, images, videos, and text, opens the configured site when a visitor approaches, and returns to signage after the visitor leaves. The default website is https://solarizedigitech.com/.

[Download the Windows x64 installer](https://github.com/akshatsrv/solarize-x-sensor/releases/download/v0.5.0/SmartSelfCheckConsole-Setup-0.5.0-x64.exe) · [GitHub release notes](https://github.com/akshatsrv/solarize-x-sensor/releases/tag/v0.5.0)

| Component | Where it runs | How to set it up |
| --- | --- | --- |
| Management server | One central Windows machine | Run the Node.js server with SQLite storage. |
| Desktop console | An operator's Windows x64 PC | Run Setup and choose a local system or an existing management server. |
| Kiosk agent and display | Each Windows kiosk | Start the kiosk agent with its server address, credential, and sensor settings. |

## Windows desktop console

1. Run `SmartSelfCheckConsole-Setup-0.5.0-x64.exe` on Windows x64. Setup installs for the current user, creates Start menu and desktop shortcuts, and opens the application when installation finishes.
2. Choose **Use this PC** to run the bundled server, SQLite database, console, and `local-kiosk` agent. Set a password of 12–128 characters for the local `owner` superuser. The application starts the local components and opens the console. The installer includes the runtime for every local component.
3. Go to **Destinations → local-kiosk → Start** to open the test display. Use **Simulate arrival** and **Simulate departure** to test the change between signage and check-in.

For an existing management server, enter its HTTPS address in **Connect to server** and sign in. If you have a new account, select **Activate invitation** and use the username and code from your superuser to set a password.

The console remembers the selected connection mode and holds the sign-in password in memory for that connection. The local system runs on loopback while the desktop app is open. When you reopen the app in local mode, it starts the server and kiosk again and asks for your password. The local SQLite data and kiosk cache are stored in your Windows user profile under `Smart Self Check Console/local-system`. To remove the app, use **Settings → Apps → Installed apps** in Windows.

The three-line button at the top of the sidebar shows or hides navigation. The **Connection** menu changes or disconnects the server. The **View** menu opens Destinations, Designer, Scheduler, Setup, and the other console pages. The updated web console remains available from the same server address.

From the source directory, run `npm ci` and `npm run console` to launch the desktop console on a development machine. Run `npm run package:installer` to produce the Windows setup executable under `dist/installer`, or `npm run package:console` for the portable Windows x64 directory under `dist`. These development builds are unsigned. The repository contains the source and build configuration. Keep generated binaries, databases, and credential files in their deployment locations.

## Superusers, registration, and passwords

### First sign-in

On a single-PC installation, create the first superuser with **Use this PC**. The username is `owner`, and you choose its password. Use **System management → Permissions** to invite additional users. For a separately deployed management server, follow these steps:

1. During server setup, generate a random bootstrap password and set `ADMIN_TOKEN` in `server.env`. For example, run `node -p "require('node:crypto').randomBytes(32).toString('base64url')"` on the server. Store the result in your organization's password manager and restrict `server.env` to the service account and administrators.
2. Start the server and sign in to the desktop console as `admin` with the value of `ADMIN_TOKEN`. This bootstrap account is managed by the server owner.
3. Open **System management → Permissions**, enter a named user, choose **Superuser**, and select **Create invitation**. Copy the one-time code and share it with that person through a secure channel. The code lasts 24 hours. Use individually named accounts for routine administration and keep `admin` for initial setup and recovery.

### Register additional users

A superuser can invite any number of named accounts with the following roles. The recipient enters the invitation in the desktop app using **Activate invitation** or visits `/register` on the same server in a browser. The recipient chooses a password of 12–128 characters. The server stores a salted password hash and marks the invitation used after activation.

| Role | Access |
| --- | --- |
| Superuser | Manage console accounts, kiosk enrollment and credentials, fleet settings, content, and schedules. |
| Publisher | Create and publish media, presentations, and schedules. |
| Operator | Start, stop, and restart displays, and use the sensor simulator on configured test kiosks. |
| Viewer | View the fleet and playback history. |

### Change, recover, or revoke access

- Signed-in named users can open **My account**, enter their current password, and choose a new one. Reconnect from the desktop **Connection** menu or open a fresh browser sign-in with the new password.
- A superuser can select **Reset invitation** for an existing account or **Reissue invitation** for a pending account. Share the new code securely. Activating the code replaces the previous password. Use **Remove** to revoke a user's access immediately.
- To rotate or recover the bootstrap `admin` password, replace `ADMIN_TOKEN` on the server and restart the management service. Named accounts are stored in SQLite and keep their own passwords. The activity log records invitations, password changes, and account management actions.

## Five-minute POC walkthrough

1. Open **Setup** and confirm server readiness. On the Windows kiosk run `node --env-file=kiosk.env scripts/doctor.mjs` from the application folder. It checks DNS, HTTPS/HTTP readiness, the enrolled credential, disk capacity, and the COM-port configuration if USB PIR mode is enabled.
2. Open **Designer → Use demo template**, then select each slide to preview it. Add a photo or video from the Content library, adjust the theme or duration, and save the presentation.
3. Select **Schedule presentation**, choose your test kiosk as the target, and publish. The editor opens on today's date with the presentation already in the playlist. For a one-off showcase, use all-day hours and a priority above other overlapping demo schedules.
4. Open **Destinations** and start the display. Check the scheduled slide name, playback state, and sensor status. Use **Simulate arrival** and **Simulate departure** on a simulator kiosk to demonstrate the website handoff. On Windows with a USB PIR serial device, validate the actual trigger and return in person.
5. Open **Playback history**, select the kiosk, and verify a slide start and a proximity-triggered check-in. Export the visible results to CSV if needed. A disconnected kiosk buffers up to 500 recent events locally for upload on reconnect. The server keeps the newest 20,000 records and the console shows up to 150 for the chosen filter.

## Windows deployment

Install Node.js 24 LTS on the server and each kiosk. Copy this directory to a stable location on each machine, such as `C:\SmartSelfCheck`.

### Central server

Create `server.env` in the project directory. Use two distinct random passwords. Share the kiosk password with the kiosk agents only.

```dotenv
SERVER_HOST=127.0.0.1
SERVER_PORT=8080
ADMIN_TOKEN=replace-with-admin-password
KIOSK_TOKEN=replace-with-kiosk-password
# SERVER_DATA_DIR=C:/SmartSelfCheck/data
```

```powershell
npm ci --omit=dev --omit=optional
node --env-file=server.env server.js
```

For a trusted LAN pilot with kiosks on other machines, set `SERVER_HOST=0.0.0.0` and allow inbound TCP 8080 from the pilot network. The browser can sign in with `admin` and `ADMIN_TOKEN` at the server address. For remote desktop-console connections and production kiosk enrollment, configure the HTTPS reverse proxy described below.

| Connection | Default | Purpose |
| --- | --- | --- |
| Kiosk and admin browser to production reverse proxy | Outbound TCP 443 from the client | Console, enrollment, heartbeat, and content |
| Local reverse proxy to Node on the server | Loopback TCP 8080 | Application and health checks |
| Kiosk agent to kiosk display or local sensor bridge | Loopback TCP 8090 | Local rendering and input |
| Kiosk to the check-in website | Outbound TCP 443 | Open the visitor website |

Synchronize server and kiosk clocks using your Windows time service so offline schedules run at their intended local times. Plan SSD space for the original media, kiosk cache, and backups. Verify the actual videos and displays at the target resolution before setting a fleet capacity expectation. The Setup page reports detected resources and access to the database. It does not measure throughput under a full fleet load.

### Production server profile

Use a single server process and one writable persistent data directory on a local disk per installation. SQLite stores destination settings, permission accounts, schedules, audit events, and the original bytes of images, videos, and text. On first startup the server imports existing `fleet.json` data and media into `fleet.sqlite` in one transaction. Existing files are retained for rollback. If any source media is missing, the import stops and can be retried after the file is restored. For production, replace the demo configuration with an environment file like this:

```dotenv
SERVER_MODE=production
SERVER_HOST=127.0.0.1
SERVER_PORT=8080
SERVER_ID=signage-main
SERVER_NAME=Main signage server
SERVER_PUBLIC_URL=https://signage.example.com
SERVER_TIME_ZONE=Asia/Kolkata
SERVER_LICENSE_SEATS=25
ADMIN_TOKEN=replace-with-a-random-secret-at-least-32-characters-long
SERVER_DATA_DIR=C:/SmartSelfCheck/data
```

Set `SERVER_LICENSE_SEATS` to the site's managed kiosk capacity, or omit it for unlimited seats. Assigning a kiosk credential consumes an app-managed seat. Revoking the credential releases that seat. The server keeps a digest of each credential and displays the original once when issuing it. Restrict access to the environment file and data directory to the service account and administrators.

Configure the reverse proxy to terminate TLS, restrict admin access to the organization network or VPN, preserve `Authorization`, and overwrite `X-Forwarded-Proto` with `https` for HTTPS requests. The Node listener rejects direct non-health requests in production. Set proxy upload limits to at least 100 MB and restrict abusive request rates. Monitor `/healthz` for process liveness and `/readyz` for access to the database and upload staging directory. Restrict Node's loopback listener to the local reverse proxy and maintenance tools.

In **Servers**, the dashboard shows the current server's name, address, release, and number of connected kiosks. Optional `SERVER_PEERS` entries show other installations' readiness and link to their dashboards. Each installation manages the kiosks enrolled against its own address.

```dotenv
SERVER_PEERS='[{"name":"Branch office","url":"https://branch-signage.example.com"}]'
```

Use the SQLite backup command instead of copying the live database file. Keep backups private because they contain account and kiosk credential digests. To verify a restore, place the backup as `fleet.sqlite` in a new data directory and start a separate server instance configured for that directory. Keep the Node service and reverse proxy under automatic restart supervision. Replication and automatic failover require a separate deployment design.

```powershell
node --env-file=server.env scripts/backup.mjs C:/Backups/signage-2026-11-25.sqlite
```

To start the server at Windows boot, create a Windows Task Scheduler task with an **At startup** trigger. Use **Run whether user is logged on or not** for the server account. Set the action to `node.exe` using its full path. Set arguments to `--env-file=server.env server.js` and **Start in** to the project folder. The account needs write access to the data directory. Back up that directory to preserve fleet settings and uploaded media.

### Each kiosk

Create `kiosk.env` with the central server address and a unique kiosk ID.

```dotenv
SERVER_URL=http://192.168.1.10:8080
KIOSK_ID=lobby-01
KIOSK_TOKEN=replace-with-kiosk-password
KIOSK_SENSOR_MODE=simulation
# KIOSK_DATA_DIR=C:/SmartSelfCheck/kiosk-data
# KIOSK_WINDOWED=1
# KIOSK_DEBUG_DESKTOP=1
```

```powershell
npm ci --omit=dev
npm run setup:kiosk
node --env-file=kiosk.env kiosk.js
```

The agent appears in the dashboard automatically. Start it under the dedicated kiosk Windows account. For automatic startup, create an **At log on** task for that account using **Run only when user is logged on**. Use the full path to `node.exe`, arguments `--env-file=kiosk.env kiosk.js`, and the project folder as **Start in**. Configure Windows sign-in on unattended devices so the account starts an interactive desktop after reboot. Set the task to run without a time limit and restart on failure.

In production, first select **Destinations → Enroll kiosk** on the authenticated dashboard, give the kiosk a unique ID and site, then copy the generated `kiosk.env` onto the device. It includes `KIOSK_MODE=production` and the HTTPS server URL. Existing demo IDs can be migrated through the destination's **Access** control. A revoked credential is rejected on the kiosk's next successful server contact. During an outage, devices continue using their last authenticated configuration and locally cached media.

The agent reopens its display if the display process closes. After a server outage or an offline kiosk reboot, an enrolled kiosk can use its last saved run state and cached playlist. The local sensor input continues to work without the central server. A check-in website still needs a working connection from the kiosk to that website.

## Manage content and devices

1. In **Content library**, upload images or videos or select **New text** for a plain-text announcement. Supported media formats are JPEG, PNG, WebP, MP4, and WebM, up to 100 MB per file. Use **Preview** to check the item in the admin browser. Text and images use the configured still-content duration.
2. Open **Fleet defaults** and add media in playback order, or select **Configure** for a particular kiosk and clear **Use fleet defaults** to assign a different playlist. **Save and publish** sends the assignment to the device. It finishes downloading the new files before switching playlists.
3. Use **Start all** or **Stop all** for the entire fleet. These commands replace individual run settings. Use **Start**, **Stop**, or **Restart** on a device for individual control. An active session can finish or time out before the queued stop or restart takes effect.
4. The device row reports online status, current media and playback state, download progress, proximity state, round-trip time to the server, CPU and memory use, and available disk space where supported.
5. With **simulation** selected, use **Simulate arrival** and **Simulate departure** in the dashboard. The website opens in the fullscreen desktop display. A blank website setting enables the built-in demo check-in.

### Schedule content

Open **Scheduler** and filter the month calendar by kiosk or site. Click a date to create a one-day schedule or select **New schedule** to set a date range, recurring weekdays, time zone, and playlist. Equal start and end times mean all-day playback. An end time earlier than the start time carries playback into the next day. Higher priority wins when schedules overlap. At the same priority, an individual kiosk takes precedence over a site, followed by the fleet. When no schedule applies, the kiosk plays its assigned default playlist. It downloads applicable schedule media before activating the new plan and can evaluate the cached plan during a server outage.

Use **System management → Permissions** to invite users, change their roles, and revoke access. The **Recent changes** list records administrative changes with the account that performed them.

Use **System management → Television settings** for fleet defaults or **Configure** on a destination for its overrides. The display output is numbered with the operating system's primary display as 1. Fit and rotation affect signage media. The check-in website follows the operating system's display orientation. Physical power, input, and volume control require a display-specific integration.

The configured absence timer applies when the website has not been used. Clicks, touch, keyboard input, and scrolling mark the external website session active. An active session stays open until the longer abandonment timeout while the visitor is away. The kiosk opens each visit in an isolated browser session. The supplied website does not send a registration-complete signal to the kiosk, so activity and absence determine the return to signage. The local demo supplies explicit completion for testing.

## Connect a physical sensor

### USB PIR on a Windows COM port

Plug the sensor into the Windows kiosk and run the following PowerShell command. Look for a new COM port, its friendly name, and its USB device ID. Compare the list with the sensor unplugged if several COM ports are present.

```powershell
Get-PnpDevice -PresentOnly -Class Ports | Format-Table FriendlyName, InstanceId -AutoSize
```

If Windows lists the sensor under **Ports (COM & LPT)** and it sends newline-terminated serial messages, use the reader's probe mode to find the idle and motion messages. Use the baud rate reported by the device documentation. Close the probe before starting the kiosk agent so the port is free.

```powershell
powershell.exe -NoProfile -File .\scripts\usb-pir.ps1 -Port COM4 -Baud 9600 -Probe
```

Configure the kiosk with the COM port and values actually observed in the probe. These values are examples:

```dotenv
KIOSK_SENSOR_MODE=usb-pir
KIOSK_PIR_PORT=COM4
KIOSK_PIR_BAUD=9600
KIOSK_PIR_OUTPUT=level
KIOSK_PIR_ACTIVE=1
KIOSK_PIR_INACTIVE=0
```

For a sensor that sends a motion event only, set `KIOSK_PIR_OUTPUT=pulse`, set the observed active value, and set `KIOSK_PIR_HOLD_MS` to the motion hold period. A new pulse extends it. PIR motion sensing can miss a stationary visitor, so validate the hold and active-check-in timers on site. The agent retries if the COM port disconnects. The dashboard shows the connection and last signal. The supplied label does not identify the sensor's USB interface. If it appears as HID or under a vendor device class, use its hardware IDs and protocol to select an adapter for the local input below.

### Local bridge for other interfaces

Once the sensor model is available, configure a Windows sensor bridge for its USB, serial, or network protocol. Have the bridge report the current presence state on every change and at least once every 15 seconds so the dashboard can distinguish a quiet sensor from a disconnected one. Use these settings on the kiosk:

```dotenv
KIOSK_SENSOR_MODE=local
KIOSK_SENSOR_TOKEN=replace-with-a-local-sensor-password
```

Test the local bridge endpoint from the kiosk:

```powershell
$Headers = @{ Authorization = 'Bearer replace-with-a-local-sensor-password' }
$Body = @{ present = $true } | ConvertTo-Json
Invoke-RestMethod -Uri http://127.0.0.1:8090/api/sensor -Method Post -Headers $Headers -ContentType 'application/json' -Body $Body
```

Send `present = $false` to report departure. The endpoint binds to loopback and accepts the kiosk's local sensor password. A received positive reading opens the configured website. When readings stop, the dashboard flags the sensor and the kiosk retains the last reported presence state until the bridge resumes. Adjust distance and debounce behavior in the physical sensor bridge for that model.

## Verify

- `npm test` covers kiosk sessions, scheduling, database migration, console address validation, and PIR message parsing.
- `npm run test:integration` starts a server and two kiosk agents on temporary loopback ports. It covers targeted and offline playback, check-in routing, sensor input, kiosk enrollment, permissions, single-use registration, password changes, and password recovery.
- For a Windows desktop smoke test set `KIOSK_WINDOWED=1`, start a kiosk, assign an image and a video, and verify both appear in order. Simulate arrival and departure to check the actual website opens and the screen returns. Remove `KIOSK_WINDOWED` for the full-screen installation.
- For an API or browser-only test, start the agent with `--manual-display` and open the local URL it prints. The external website is presented as a link in this mode. The desktop application opens it automatically.
