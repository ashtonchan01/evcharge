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
- **src/tesla/client.ts** — calls Tesla's Fleet API directly using an
  OAuth refresh token (auto-refreshing short-lived access tokens as
  needed). This only works for vehicles that don't require Tesla's signed
  "vehicle command protocol" virtual-key pairing - roughly pre-2021 cars
  on older infotainment firmware. Newer vehicles would need commands
  routed through a signed-command proxy (e.g. Tesla's open-source
  `tesla-http-proxy`) instead.
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
