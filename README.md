# evcharge

Personal solar-aware EV charging controller. Polls a GoodWe inverter (via the
SEMS cloud portal) for spare solar production and tells a Tesla to charge
only from that excess, with a small web dashboard to watch status and
manually override.

## How it works

```
GoodWe SEMS portal  --poll-->  controller  --signed command-->  tesla-http-proxy  -->  Tesla Fleet API
                                    |
                                    v
                            Express + WebSocket API  -->  dashboard (web/public)
```

- **src/goodwe/client.ts** — logs into the SEMS cloud portal and reads PV
  production, household load, and grid import/export.
- **src/tesla/client.ts** — talks to a local instance of Tesla's
  open-source [`tesla-http-proxy`](https://github.com/teslamotors/vehicle-command/tree/main/cmd/tesla-http-proxy),
  which holds the vehicle command signing key and forwards signed commands
  to the Fleet API. This app never sees the private key or calls Tesla
  directly.
- **src/controller/index.ts** — every `POLL_INTERVAL_MS`, computes
  `surplus = pvPower - householdLoad - buffer`, converts it to an amp
  target, and starts/stops/adjusts the car's charge rate. Uses
  hysteresis (separate start/stop thresholds) and a stable-cycle counter
  so it doesn't flap when a cloud passes over.
- **src/server/index.ts** — serves the dashboard, `GET /api/status`, and
  `POST /api/override` (protected by an `x-override-token` header) for
  manual auto/force-on/force-off control. Pushes live updates over
  WebSocket at `/ws`.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - Your SEMS portal account/password and power station ID.
   - A running `tesla-http-proxy` URL + a Fleet API OAuth access token
     scoped to `vehicle_device_data` and `vehicle_cmds`, plus your
     vehicle's ID/VIN.
   - An `OVERRIDE_TOKEN` (`openssl rand -hex 32`) to protect the manual
     override endpoint.
3. `npm run dev` (or `npm run build && npm start`).
4. Open `http://localhost:3000`.

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

## Manual override

The dashboard's override panel calls `POST /api/override` with
`{ "mode": "auto" | "force_on" | "force_off", "amps": <optional number> }`
and the `x-override-token` header. `force_on` without `amps` charges at
`MAX_CHARGE_AMPS`. Switching back to `auto` resumes solar-following on the
next poll.
