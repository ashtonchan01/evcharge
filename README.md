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
  so it doesn't flap when a cloud passes over.
- **src/server/index.ts** — serves the dashboard, `GET /api/status`, and
  `POST /api/enabled` (protected by an `x-override-token` header) to turn
  solar charging on/off. Pushes live updates over WebSocket at `/ws`.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - Your SEMS portal account/password and power station ID.
   - A Tesla developer app (from developer.tesla.com) Client ID/Secret,
     an OAuth refresh token (from the authorization-code exchange, scoped
     to at least `vehicle_device_data` and `vehicle_charging_cmds`), and
     your target vehicle's ID/VIN.
   - An `OVERRIDE_TOKEN` (`openssl rand -hex 32`) to protect the on/off
     and vehicle-lookup endpoints.
3. `npm run dev` (or `npm run build && npm start`).
4. Open `http://localhost:3000`.
5. To find a vehicle's id/VIN, call `GET /api/vehicles` with an
   `x-override-token` header once the server is running - it lists every
   vehicle on the account.

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

## Tuning

All thresholds live in `.env`:

- `MIN_SURPLUS_START_W` / `MIN_SURPLUS_STOP_W` — hysteresis band so surplus
  hovering near zero doesn't start/stop every cycle.
- `GRID_IMPORT_BUFFER_W` — solar reserved for the house before offering
  any to the car.
- `STABLE_CYCLES_TO_START` / `STABLE_CYCLES_TO_STOP` — how many
  consecutive polls a condition must hold before acting.
- `MIN_CHARGE_AMPS` / `MAX_CHARGE_AMPS` — Tesla's charge amp floor/ceiling
  for your charging equipment.

## On/off toggle

The dashboard has a single switch. On: the controller follows solar
surplus automatically (the core behaviour described above). Off: the car
is left alone (or told to stop charging if it was mid-session), regardless
of solar. It calls `POST /api/enabled` with `{ "enabled": true | false }`
and the `x-override-token` header.

## Multiple vehicles

The dashboard's vehicle dropdown (populated from `GET /api/vehicles`) lets
you switch which single vehicle the controller actively manages - it
controls one car at a time, not both simultaneously. Selecting a vehicle
calls `POST /api/vehicle` with `{ "tag": "<VIN>" }` and the
`x-override-token` header, and resets the stability counters so the newly
selected car is evaluated fresh.
