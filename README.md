# evcharge

Personal solar-aware EV charging controller. Polls a GoodWe inverter (via the
SEMS cloud portal) for spare solar production and tells a Tesla to charge
only from that excess, with a small web dashboard to watch status and
manually override.

## How it works

```
GoodWe SEMS portal  --poll-->  controller  --OAuth token-->  Tesla Fleet API
                                    |
                                    v
                            Express + WebSocket API  -->  dashboard (web/public)
```

- **src/goodwe/client.ts** — logs into the SEMS cloud portal and reads PV
  production, household load, and grid import/export.
- **src/tesla/client.ts** — calls Tesla's Fleet API directly using an OAuth
  refresh token (auto-refreshing short-lived access tokens as needed) for
  reads (charge state, wake-up, listing vehicles) - these work for any
  vehicle. Commands (start/stop charging, set amps) are tried directly
  first, then automatically retried through a local `tesla-http-proxy`
  (when `TESLA_COMMAND_PROXY_URL` is set) if Tesla rejects them as
  requiring its signed "vehicle command protocol" - every vehicle except
  pre-2021 Model S/X. This means the same app instance works with either
  kind of vehicle without configuration per car.
- **src/controller/index.ts** — every `POLL_INTERVAL_MS`, computes
  `surplus = pvPower - householdLoad - buffer`, converts it to an amp
  target, and starts/stops/adjusts the car's charge rate. Uses
  hysteresis (separate start/stop thresholds) and a stable-cycle counter
  so it doesn't flap when a cloud passes over. Vehicle state comes from
  **src/tesla/telemetry.ts** (pushed, free) rather than polling
  `vehicle_data` (billed) whenever `TESLA_TELEMETRY_LOG_PATH` is set - see
  "Setting up Fleet Telemetry" below.
- **src/server/index.ts** — serves the dashboard, `GET /api/status`, and
  `POST /api/enabled` to turn solar charging on/off. Pushes live updates
  over WebSocket at `/ws`.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - Your SEMS portal account/password and power station ID.
   - A Tesla developer app (from developer.tesla.com) Client ID/Secret,
     an OAuth refresh token (from the authorization-code exchange, scoped
     to at least `vehicle_device_data` and `vehicle_charging_cmds`), and
     your target vehicle's ID/VIN.
3. `npm run dev` (or `npm run build && npm start`).
4. Open `http://localhost:3000`.
5. To find a vehicle's id/VIN, call `GET /api/vehicles` once the server
   is running - it lists every vehicle on the account (also available as
   a dropdown in the dashboard).

## Setting up the signed-command proxy (non-exempt vehicles)

Only needed if your target vehicle isn't a pre-2021 Model S/X - you'll
know because commands fail with "Tesla Vehicle Command Protocol required."

1. Clone and build Tesla's proxy: `git clone https://github.com/teslamotors/vehicle-command.git && cd vehicle-command && go build ./cmd/tesla-http-proxy && go build ./cmd/tesla-keygen`
2. Generate a key pair: `./tesla-keygen -key-file private-key.pem -output public-key.pem create`
3. Host `public-key.pem`'s contents at
   `https://yourdomain/.well-known/appspecific/com.tesla.3p.public-key.pem`
   (a free GitHub Pages **user** site - a repo named exactly
   `yourusername.github.io` - works; make sure to add an empty `.nojekyll`
   file at the repo root or Jekyll will silently exclude the dotfile
   path). This domain must match what you registered as your developer
   app's Allowed Origin/Redirect URLs.
4. Register your app with Tesla's Fleet API for your region (one-time, using
   an app-level `client_credentials` token, not your personal login):
   ```
   curl -s -X POST https://auth.tesla.com/oauth2/v3/token -d "grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&scope=vehicle_device_data%20vehicle_cmds%20vehicle_charging_cmds&audience=YOUR_FLEET_API_BASE_URL" > app_token.json
   curl -s -X POST YOUR_FLEET_API_BASE_URL/api/1/partner_accounts -H "Authorization: Bearer $(python3 -c "import json;print(json.load(open('app_token.json'))['access_token'])")" -H "Content-Type: application/json" -d '{"domain":"yourdomain"}'
   ```
5. Pair the virtual key: on your phone, visit `https://tesla.com/_ak/yourdomain`
   and approve it for the specific vehicle that needs it.
6. Generate a local TLS cert for the proxy (LibreSSL/macOS-safe method):
   ```
   openssl ecparam -genkey -name prime256v1 -noout -out server-key.pem
   openssl req -new -x509 -key server-key.pem -out server-cert.pem -days 365 -subj "/CN=localhost"
   ```
7. Run the proxy: `./tesla-http-proxy -tls-key server-key.pem -cert server-cert.pem -key-file private-key.pem -port 4443`
8. Set `TESLA_COMMAND_PROXY_URL=https://localhost:4443` in `.env` and keep
   the proxy running alongside this app.

## Setting up Fleet Telemetry (avoids Tesla API billing)

Since Feb 2025, Tesla's Fleet API is pay-per-use - `vehicle_data` polling
every `POLL_INTERVAL_MS` all day is exactly the kind of usage that runs up
a bill (ChargeHQ hit the same wall and migrated off polling entirely -
see [their Fleet Telemetry FAQ](https://chargehq.net/kb/tesla-fleet-telemetry-faq)).
Fleet Telemetry flips the model: the car pushes state to a server you
run, only when something changes, instead of you asking for it on a
timer. This app uses telemetry as a free, always-on "is it plugged in /
charging / how many amps / how many watts" signal and can run the
solar-following ramp loop entirely off it, including during an active
charging session - it only falls back to a real (billed) `vehicle_data`
poll when telemetry has no fresh reading yet (e.g. right after a session
starts, before the first push arrives) - see the comments in
`src/controller/index.ts` and `src/tesla/telemetry.ts`.

You already have everything Fleet Telemetry needs if you set up the
signed-command proxy above: a registered developer domain, a hosted
public key, and a paired virtual key on the vehicle. Note that the
`ashtonchan01.github.io` domain used for the public-key/virtual-key steps
can't be used here - GitHub Pages only serves static files and GitHub
controls its DNS zone, so there's no way to add a record for it pointing
at the Oracle box. This deployment instead uses
[sslip.io](https://sslip.io) (`161-33-228-226.sslip.io`), a free wildcard
DNS service that resolves any `<anything>.<ip-with-dashes>.sslip.io`
straight to that IP with no registrar/DNS account needed - Let's Encrypt
can issue a normal cert for it via the ordinary HTTP-01 challenge. Swap
in a real domain later if you get one; nothing else about this setup
depends on it being sslip.io specifically.

1. Clone and build Tesla's telemetry server (separate repo from
   `vehicle-command`, needs Go 1.26+, newer than what Ubuntu 22.04's apt
   repo ships - install from https://go.dev/dl/ if `go version` shows
   something older): `git clone https://github.com/teslamotors/fleet-telemetry.git && cd fleet-telemetry && go build -o fleet-telemetry ./cmd/`
2. Point a real hostname at the box this app runs on - see the sslip.io
   note above, or a subdomain of a real domain you control as an A record
   to the Oracle instance's public IP - and get a **real CA-signed TLS
   cert** for it, e.g. via `certbot certonly --standalone -d
   your-hostname`. Unlike the local `tesla-http-proxy`, the car validates
   this cert over the public internet like a browser would, so a
   self-signed cert won't work here.
3. Write a `config.json` for the server - at minimum a TLS cert/key path,
   a port (open it the same way port 3000 was opened - see
   `oracle_cloud_evcharge_infra` notes on iptables), and a `logger`
   dispatcher so readings land in a plain JSON-lines file this app can
   tail:
   ```json
   {
     "host": "0.0.0.0",
     "port": 443,
     "tls": { "server_cert": "/path/to/fullchain.pem", "server_key": "/path/to/privkey.pem" },
     "records": { "V": ["logger"], "alerts": ["logger"], "errors": ["logger"] }
   }
   ```
   `src/tesla/telemetry.ts`'s field names (`Soc`, `DetailedChargeState`,
   `ChargePortDoorOpen`, `ChargeAmps`, `ACChargingPower`, `ChargeLimitSoc`)
   and its parsing of the logger dispatcher's output shape were both
   confirmed directly against a real `teslamotors/fleet-telemetry` checkout
   (`protos/vehicle_data.proto` and
   `datastore/simple/logger.go`/`transformers/payload.go`) - if a future
   version of that repo changes either, that's where to look first. Run
   the server under pm2 like `tesla-http-proxy`, and redirect its stdout
   to a file (pm2 does this automatically under `~/.pm2/logs/`).
4. Push the streaming config to the vehicle (one-time). Two gotchas found
   the hard way, both undocumented by Tesla's own error messages:
   - This needs a **user-context OAuth token** (the same one used for
     `vehicle_data`/commands), not the app-level `client_credentials` token
     from the proxy setup above - using the app token returns a misleading
     `"<VIN> not_found"` error that looks like a VIN/registration problem.
   - As of mid-2026 this endpoint **must be called through the signed
     Vehicle Command HTTP Proxy** (`tesla-http-proxy`, `TESLA_COMMAND_PROXY_URL`)
     rather than Tesla's Fleet API directly - calling it directly now
     returns `400 "This endpoint must be called through the Vehicle
     Command HTTP Proxy"`. Since the proxy only binds to localhost, run
     this `curl` from the same box the proxy runs on.
   - Getting the user token itself (`grant_type=refresh_token` against
     `auth.tesla.com/oauth2/v3/token`) can get blocked by Tesla's WAF from
     a non-browser TLS fingerprint (Node's `fetch`, plain `curl`) even
     though the same request works fine from a real browser. If you hit an
     `Access Denied` HTML response instead of a JSON token, use Python's
     `curl_cffi` (`pip3 install curl_cffi`) with `impersonate="chrome"`
     instead of `curl`/`requests` for this one call - it presents a real
     Chrome TLS fingerprint and sails through.
   ```
   curl -sk -X POST https://localhost:PROXY_PORT/api/1/vehicles/fleet_telemetry_config \
     -H "Authorization: Bearer $USER_OAUTH_ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "vins": ["YOUR_VIN"],
       "config": {
         "hostname": "telemetry.yourdomain",
         "port": 443,
         "ca": "'"$(cat /path/to/fullchain.pem | sed ':a;N;$!ba;s/\n/\\n/g')"'",
         "fields": {
           "Soc": { "interval_seconds": 60 },
           "DetailedChargeState": { "interval_seconds": 10 },
           "ChargePortDoorOpen": { "interval_seconds": 30 },
           "ChargeAmps": { "interval_seconds": 10 },
           "ACChargingPower": { "interval_seconds": 10 },
           "ChargeLimitSoc": { "interval_seconds": 300 }
         }
       }
     }'
   ```
5. Set `TESLA_TELEMETRY_LOG_PATH` in `.env` to the pm2 log file from step
   3 and restart. `TESLA_VEHICLE_TAG` needs to be the VIN (not the
   numeric vehicle id) in this mode, since telemetry records key by VIN.
   Also set `TESLA_TELEMETRY_ERROR_LOG_PATH` to the same process's pm2
   *error* log - fleet-telemetry's Go logger has been observed writing its
   actual `record_payload` data to stderr rather than stdout, so tailing
   only the "out" log can silently receive nothing while telemetry is
   working fine. The app tails both if both are set.
6. Watch the log for a minute after plugging in / unplugging to confirm
   readings are arriving, then check the dashboard's telemetry-last-seen
   timestamp updates.

Model S/X with an Intel Atom infotainment computer need "Allow
Third-Party App Data Streaming" enabled manually on the car's touchscreen
first - everything else should Just Work once the config push succeeds.

If any of this doesn't match what you see (wrong field names, no data
arriving), the app keeps working by falling back to the old
always-poll behavior - it just costs what it cost before.

## Tuning

All thresholds live in `.env`:

- `MIN_SURPLUS_START_W` / `MIN_SURPLUS_STOP_W` — hysteresis band so surplus
  hovering near zero doesn't start/stop every cycle.
- `STABLE_CYCLES_TO_START` / `STABLE_CYCLES_TO_STOP` — how many
  consecutive polls a condition must hold before acting.
- `MIN_CHARGE_AMPS` / `MAX_CHARGE_AMPS` — Tesla's charge amp floor/ceiling
  for your charging equipment.

The grid import buffer (solar reserved for the house before offering any
to the car) isn't in `.env` - it's set live from the dashboard, starts at
0W on boot, and calls `POST /api/buffer` with `{ "bufferW": <watts> }`.

## On/off toggle

The dashboard has a single switch. On: the controller follows solar
surplus automatically (the core behaviour described above). Off: the car
is left alone (or told to stop charging if it was mid-session), regardless
of solar. It calls `POST /api/enabled` with `{ "enabled": true | false }`.

## Multiple vehicles

The dashboard's vehicle dropdown (populated from `GET /api/vehicles`) lets
you switch which single vehicle the controller actively manages - it
controls one car at a time, not both simultaneously. Selecting a vehicle
calls `POST /api/vehicle` with `{ "tag": "<VIN>" }`, and resets the
stability counters so the newly selected car is evaluated fresh.
