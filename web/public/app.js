const $ = (id) => document.getElementById(id);

function fmtW(w) {
  if (w === null || w === undefined) return "–";
  return `${Math.round(w).toLocaleString()} W`;
}

function fmtTime(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleTimeString();
}

function flash(id, msg, opts) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("error", Boolean(opts && opts.error));
  setTimeout(() => {
    if (el.textContent === msg) {
      el.textContent = "";
      el.classList.remove("error");
    }
  }, (opts && opts.ms) || 4000);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

let nextPollAt = null;
let latestStatus = null;
let chargeLimitPending = false;
let vehicleRetryTimer = null;

const VEHICLE_CACHE_KEY = "evcharge.vehicles";

function fmtDuration(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(rem).padStart(2, "0")}s`;
  return `${rem}s`;
}

function readVehicleCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(VEHICLE_CACHE_KEY) || "null");
    return parsed && Array.isArray(parsed.vehicles) ? parsed.vehicles : [];
  } catch {
    return [];
  }
}

function writeVehicleCache(vehicles) {
  try {
    localStorage.setItem(VEHICLE_CACHE_KEY, JSON.stringify({ vehicles, savedAt: Date.now() }));
  } catch {
    // Private mode / blocked storage — the in-memory options still hold.
  }
}

function vehicleIsCharging(vehicle) {
  if (!vehicle) return false;
  if (vehicle.chargingState === "Charging" || vehicle.chargingState === "Starting") return true;
  return (Number(vehicle.chargerVoltage) || 0) > 0 && (Number(vehicle.chargerActualCurrent) || 0) > 0;
}

function vehicleIsOnline(vehicle) {
  if (!vehicle) return false;
  if (vehicleIsCharging(vehicle)) return true;
  return vehicle.chargingState === "Stopped" || vehicle.chargingState === "Complete" || vehicle.chargingState === "NoPower";
}

function decisionView(status) {
  const now = Date.now();
  const nextAt = status.nextTeslaAttemptAt ? new Date(status.nextTeslaAttemptAt).getTime() : 0;
  const countdown = nextAt > now ? fmtDuration(Math.round((nextAt - now) / 1000)) : null;
  const rateUntil = status.rateLimitedUntil ? new Date(status.rateLimitedUntil).getTime() : 0;

  if (status.teslaWait === "budget" || (status.apiBudgetActive && status.teslaWait !== "rate_limited")) {
    return {
      cls: "budget",
      label: "Billing limit",
      note: countdown
        ? `Paid Tesla calls paused · retry in ${countdown}`
        : "Paid Tesla calls paused. Turn solar off and on for one try.",
    };
  }
  if (status.teslaWait === "auth") {
    return {
      cls: "rate_limited",
      label: "Tesla auth failed",
      note: countdown ? `Not a vehicle rate limit · retry in ${countdown}` : "Token host rejected the refresh",
    };
  }
  if (status.teslaWait === "rate_limited" || rateUntil > now) {
    const left = Math.max(0, Math.round(((rateUntil || nextAt) - now) / 1000));
    return { cls: "rate_limited", label: "Rate limited", note: `Tesla paused · retry in ${fmtDuration(left)}` };
  }
  const chargingNow = vehicleIsCharging(status.vehicle);
  const onlineNow = vehicleIsOnline(status.vehicle);
  // A live charge snapshot wins over a recovery-gap "waking" countdown.
  if ((status.teslaWait === "waking" || status.teslaWait === "asleep" || status.decision === "unavailable") && chargingNow) {
    return { cls: "charging", label: "Charging", note: status.statusNote || "" };
  }
  if ((status.teslaWait === "waking" || status.teslaWait === "asleep") && onlineNow) {
    return { cls: "online", label: "Online", note: "" };
  }
  if (status.teslaWait === "waking") {
    return { cls: "waking", label: "Waking car", note: countdown ? `Next try in ${countdown}` : "Trying now…" };
  }
  if (status.teslaWait === "asleep") {
    return {
      cls: "asleep",
      label: "Car asleep",
      note: countdown ? `Next try in ${countdown}` : "Waiting for telemetry",
    };
  }
  if (status.teslaWait === "quiet_hours") {
    return { cls: "idle", label: "Quiet hours", note: "Tesla is left alone overnight" };
  }

  const labels = {
    charging: "Charging",
    online: "Online",
    idle: "Idle",
    waiting_for_stability: "Waiting for stability",
    unavailable: "Unavailable",
  };
  const note = status.statusNote || "";
  return {
    cls: status.decision || "unavailable",
    label: labels[status.decision] || String(status.decision || "Unavailable").replace(/_/g, " "),
    note,
  };
}

function nextPollLabel() {
  if (!nextPollAt) return "";
  const secsLeft = Math.round((nextPollAt - Date.now()) / 1000);
  if (secsLeft > 0) return `Next check in ${secsLeft}s`;
  return "Checking…";
}

function tickCountdown() {
  if (!latestStatus) {
    setText("decision-note", "");
    const pollEl = $("next-poll");
    if (pollEl) {
      pollEl.hidden = true;
      pollEl.textContent = "";
    }
    return;
  }

  const view = decisionView(latestStatus);
  const decisionEl = $("decision");
  if (decisionEl) {
    decisionEl.textContent = view.label;
    decisionEl.className = `decision-pill ${view.cls}`;
  }

  // Tesla wake / hold notes win. Otherwise show the thin next-poll countdown
  // so the status bar is never an empty Online pill.
  const note = view.note || "";
  setText("decision-note", note);

  const pollEl = $("next-poll");
  if (pollEl) {
    if (note) {
      pollEl.hidden = true;
      pollEl.textContent = "";
    } else {
      const poll = nextPollLabel();
      pollEl.hidden = !poll;
      pollEl.textContent = poll;
    }
  }
}

function render(status) {
  const s = status.solar;
  const pv = s ? s.pvPowerW : null;
  const load = s ? s.loadPowerW : null;

  setText("pv", fmtW(pv));
  setText("load", fmtW(load));
  setText("surplus", fmtW(status.surplusW));

  $("line-solar").classList.toggle("active", (pv || 0) > 50);
  $("line-surplus").classList.toggle("active", (status.surplusW || 0) > 50);

  const v = status.vehicle;
  setText("plugged", v ? (v.pluggedIn ? "Yes" : "No") : "unknown");
  setText("charging-state", v ? v.chargingState : "unknown");
  setText("amps", v ? `${Math.round(v.chargeAmps)} A` : "–");
  setText("charge-limit", v && v.chargeLimitSoc ? `${Math.round(v.chargeLimitSoc)}%` : "–");

  const batteryLevel = v ? v.batteryLevel : null;
  const batteryLevelRounded = batteryLevel !== null && batteryLevel !== undefined ? Math.round(batteryLevel) : null;
  const fill = $("battery-fill");
  fill.style.width = batteryLevelRounded !== null ? `${batteryLevelRounded}%` : "0%";
  setText("battery-label", batteryLevelRounded !== null ? `${batteryLevelRounded}%` : "–");

  latestStatus = status;
  setText("last-error", status.lastError || "");

  nextPollAt = status.lastPollAt ? new Date(status.lastPollAt).getTime() + status.pollIntervalMs : null;
  tickCountdown();

  $("enabled-toggle").checked = status.override.enabled;
  setText("enabled-label", status.override.enabled ? "On" : "Off");
  setText("solar-hint", status.override.enabled ? "Follows the sun." : "Stops the car.");

  ensureVehicleOption(status.vehicleTag);

  const chargeLimitInput = $("charge-limit-input");
  const chargeLimitRange = $("charge-limit-range");
  if (
    !chargeLimitPending &&
    v &&
    v.chargeLimitSoc &&
    document.activeElement !== chargeLimitInput &&
    document.activeElement !== chargeLimitRange
  ) {
    const rounded = Math.round(v.chargeLimitSoc);
    chargeLimitInput.value = rounded;
    chargeLimitRange.value = rounded;
  }
}

async function fetchStatus() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) return;
    render(await res.json());
  } catch {
    // Keep the last paint. The next poll or a reopened socket will retry.
  }
}

function vehicleOptions() {
  return [...$("vehicle-select").options].filter((opt) => opt.value);
}

// Keep in sync with src/vehicleLabel.ts. Option values stay VINs.
const VIN_LABELS = {
  "5YJ3F7EA5KF461091": "Model 3",
  "5YJXDCE25JF080915": "Model X",
};

const SHORT_LABELS = {
  M3: "Model 3",
  MX: "Model X",
  MS: "Model S",
  MY: "Model Y",
};

function modelFromVin(vin) {
  if (!vin || vin.length < 4) return "";
  const wmi = vin.slice(0, 3);
  if (wmi !== "5YJ" && wmi !== "7SA" && wmi !== "LRW") return "";
  switch (vin[3]) {
    case "3":
      return "Model 3";
    case "S":
      return "Model S";
    case "X":
      return "Model X";
    case "Y":
      return "Model Y";
    default:
      return "";
  }
}

function vehicleLabel(vin, displayName) {
  const id = String(vin || "").trim().toUpperCase();
  if (id && VIN_LABELS[id]) return VIN_LABELS[id];
  const raw = String(displayName || "").trim();
  const short = SHORT_LABELS[raw.toUpperCase()];
  if (short) return short;
  if (raw && raw.toUpperCase() !== id) return raw;
  return modelFromVin(id) || raw || id;
}

function renderVehicleOptions(vehicles, opts) {
  const select = $("vehicle-select");
  const current = select.value;
  const stale = Boolean(opts && opts.stale);
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = stale ? "Select vehicle… (saved list)" : "Select vehicle…";
  select.appendChild(placeholder);
  for (const v of vehicles) {
    if (!v || !v.vin) continue;
    const opt = document.createElement("option");
    opt.value = v.vin;
    opt.dataset.displayName = v.displayName || "";
    opt.textContent = vehicleLabel(v.vin, v.displayName);
    select.appendChild(opt);
  }
  if (current && [...select.options].some((opt) => opt.value === current)) select.value = current;
}

function ensureVehicleOption(tag) {
  const select = $("vehicle-select");
  if (!tag) return;
  let opt = [...select.options].find((option) => option.value === tag);
  if (!opt) {
    opt = document.createElement("option");
    opt.value = tag;
    select.appendChild(opt);
  }
  // Status updates only know the VIN. Relabel every time so a raw VIN
  // option created before the vehicle list arrives does not stick.
  opt.textContent = vehicleLabel(tag, opt.dataset.displayName || "");
  select.value = tag;
}

function scheduleVehicleRetry(ms) {
  if (vehicleRetryTimer) return;
  vehicleRetryTimer = setTimeout(() => {
    vehicleRetryTimer = null;
    void loadVehicles();
  }, ms);
}

function showVehicleError(message) {
  const select = $("vehicle-select");
  if (vehicleOptions().length > 0) return;
  select.replaceChildren();
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = message;
  select.appendChild(opt);
}

async function loadVehicles() {
  const cached = readVehicleCache();
  if (cached.length && vehicleOptions().length === 0) renderVehicleOptions(cached, { stale: true });

  try {
    const res = await fetch("/api/vehicles");
    const body = await res.json().catch(() => ({}));
    const vehicles = Array.isArray(body) ? body : body.vehicles;
    if (Array.isArray(vehicles) && vehicles.length) {
      writeVehicleCache(vehicles);
      renderVehicleOptions(vehicles, { stale: Boolean(body.stale) || !res.ok });
    }

    if (!res.ok || body.error) {
      const reason = body.error || `HTTP ${res.status}`;
      if (!vehicles || !vehicles.length) showVehicleError(`Couldn't load vehicles (${reason})`);
      else flash("override-message", "Couldn't refresh vehicles; showing the last list.");
      const slow = res.status === 403 || res.status === 429 || /rate|billing|paused/i.test(String(body.error || ""));
      scheduleVehicleRetry(slow ? 5 * 60 * 1000 : 60 * 1000);
      return;
    }
  } catch (err) {
    if (!cached.length && vehicleOptions().length === 0) {
      showVehicleError(`Couldn't load vehicles (${err.message || "network"})`);
    } else {
      flash("override-message", "Couldn't refresh vehicles; showing the last list.");
    }
    scheduleVehicleRetry(60 * 1000);
  }
}

$("vehicle-select").addEventListener("change", async (e) => {
  const tag = e.target.value;
  if (!tag) return;

  const res = await fetch("/api/vehicle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    flash("override-message", `Error: ${body.error || res.status}`);
    return;
  }

  render(await res.json());
  flash("override-message", "Switched active vehicle.");
});

$("enabled-toggle").addEventListener("change", async (e) => {
  const enabled = e.target.checked;

  const res = await fetch("/api/enabled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });

  if (!res.ok) {
    e.target.checked = !enabled;
    const body = await res.json().catch(() => ({}));
    flash("override-message", `Error: ${body.error || res.status}`);
    return;
  }

  render(await res.json());
  flash("override-message", enabled ? "On. Follows the sun." : "Off. Car stays stopped.");
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

let pushEnsureStarted = false;

async function ensurePush() {
  if (pushEnsureStarted) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  if (Notification.permission === "denied") return;
  pushEnsureStarted = true;
  try {
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") {
      pushEnsureStarted = false;
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    if (await registration.pushManager.getSubscription()) return;
    const keyRes = await fetch("/api/push/public-key", { cache: "no-store" });
    const { publicKey, enabled } = await keyRes.json();
    if (!enabled || !publicKey) return;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });
  } catch {
    pushEnsureStarted = false;
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then(() => ensurePush())
    .catch(() => {});
}
document.addEventListener("pointerdown", () => void ensurePush(), { once: true });

$("charge-limit-range").addEventListener("input", (e) => {
  $("charge-limit-input").value = e.target.value;
});

$("charge-limit-input").addEventListener("input", (e) => {
  if (e.target.value !== "") $("charge-limit-range").value = e.target.value;
});

$("charge-limit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = Number($("charge-limit-input").value);
  const percent = Math.round(raw);
  const button = e.target.querySelector("button");

  if (!Number.isFinite(raw) || raw < 50 || raw > 100 || percent < 50 || percent > 100) {
    flash("charge-limit-message", "Charge limit must be between 50 and 100.", { error: true });
    return;
  }

  chargeLimitPending = true;
  if (button) button.disabled = true;
  try {
    const res = await fetch("/api/charge-limit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ percent }),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      flash("charge-limit-message", body.error || `Couldn't set charge limit (${res.status}).`, {
        error: true,
        ms: 8000,
      });
      return;
    }

    render(body);
    const shown =
      body.vehicle && body.vehicle.chargeLimitSoc ? Math.round(body.vehicle.chargeLimitSoc) : percent;
    setText("charge-limit", `${shown}%`);
    $("charge-limit-input").value = shown;
    $("charge-limit-range").value = shown;
    flash("charge-limit-message", `Charge limit set to ${shown}%.`);
  } catch (err) {
    flash("charge-limit-message", `Couldn't set charge limit: ${err.message || err}`, { error: true, ms: 8000 });
  } finally {
    chargeLimitPending = false;
    if (button) button.disabled = false;
  }
});

let socket = null;
let reconnectTimer = null;

function connectWs() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;

  ws.addEventListener("open", () => {
    $("conn-indicator").classList.remove("dot-off");
    $("conn-indicator").classList.add("dot-on");
    setText("conn-label", "Live");
  });

  ws.addEventListener("close", () => {
    if (socket === ws) socket = null;
    $("conn-indicator").classList.remove("dot-on");
    $("conn-indicator").classList.add("dot-off");
    setText("conn-label", "Reconnecting…");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs, 2000);
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "status") render(msg.data);
  });
}

function refreshLive() {
  void fetchStatus();
  if (!socket || socket.readyState !== WebSocket.OPEN) connectWs();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshLive();
});
window.addEventListener("pageshow", () => refreshLive());

fetchStatus();
loadVehicles();
connectWs();
setInterval(() => void fetchStatus(), 20000);
setInterval(tickCountdown, 1000);
