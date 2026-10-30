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
  if (status.teslaWait === "rate_limited" || rateUntil > now) {
    const left = Math.max(0, Math.round(((rateUntil || nextAt) - now) / 1000));
    return { cls: "rate_limited", label: "Rate limited", note: `Tesla paused · retry in ${fmtDuration(left)}` };
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
    idle: "Idle",
    waiting_for_stability: "Waiting for stability",
    unavailable: "Unavailable",
  };
  let note = status.statusNote || "";
  if (!note && status.telemetryEnabled && !status.telemetryLastSeenAt && status.override && status.override.enabled) {
    note = "No streaming telemetry — not spending extra Tesla polls";
  }
  return {
    cls: status.decision || "unavailable",
    label: labels[status.decision] || String(status.decision || "Unavailable").replace(/_/g, " "),
    note,
  };
}

function tickCountdown() {
  if (latestStatus) {
    const view = decisionView(latestStatus);
    const decisionEl = $("decision");
    if (decisionEl) {
      decisionEl.textContent = view.label;
      decisionEl.className = `decision-pill ${view.cls}`;
    }
    setText("decision-note", view.note || "");
  }
  if (!nextPollAt) {
    setText("next-poll", "–");
    return;
  }
  const secsLeft = Math.round((nextPollAt - Date.now()) / 1000);
  setText("next-poll", secsLeft > 0 ? `${secsLeft}s` : "due");
}

function render(status) {
  const s = status.solar;
  const pv = s ? s.pvPowerW : null;
  const load = s ? s.loadPowerW : null;

  setText("pv", fmtW(pv));
  setText("pv-2", fmtW(pv));
  setText("load", fmtW(load));
  setText("load-2", fmtW(load));
  setText("grid", s ? fmtW(s.gridPowerW) : "–");
  setText("surplus", fmtW(status.surplusW));
  setText("surplus-2", fmtW(status.surplusW));

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
  const view = decisionView(status);
  const decisionEl = $("decision");
  decisionEl.textContent = view.label;
  decisionEl.className = `decision-pill ${view.cls}`;
  setText("decision-note", view.note || "");

  setText("target-amps", status.targetAmps !== null ? `${Math.round(status.targetAmps)} A` : "–");
  setText("last-poll", fmtTime(status.lastPollAt));
  setText("last-error", status.lastError || "");

  nextPollAt = status.lastPollAt ? new Date(status.lastPollAt).getTime() + status.pollIntervalMs : null;
  tickCountdown();

  $("enabled-toggle").checked = status.override.enabled;
  setText("enabled-label", status.override.enabled ? "On" : "Off");

  ensureVehicleOption(status.vehicleTag);

  const bufferInput = $("buffer-input");
  const bufferRange = $("buffer-range");
  if (document.activeElement !== bufferInput && document.activeElement !== bufferRange) {
    bufferInput.value = status.gridImportBufferW || "";
    bufferRange.value = status.gridImportBufferW || 0;
  }

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
  const res = await fetch("/api/status");
  render(await res.json());
}

function vehicleOptions() {
  return [...$("vehicle-select").options].filter((opt) => opt.value);
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
    const name = v.displayName || v.vin;
    const state = v.state ? ` (${v.state})` : "";
    opt.textContent = stale ? `${name}${state} · saved` : `${name}${state}`;
    select.appendChild(opt);
  }
  if (current && [...select.options].some((opt) => opt.value === current)) select.value = current;
}

function ensureVehicleOption(tag) {
  const select = $("vehicle-select");
  if (!tag) return;
  if (![...select.options].some((opt) => opt.value === tag)) {
    const opt = document.createElement("option");
    opt.value = tag;
    opt.textContent = tag;
    select.appendChild(opt);
  }
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
  flash("override-message", enabled ? "Solar charging turned on." : "Solar charging turned off.");
});

$("buffer-range").addEventListener("input", (e) => {
  $("buffer-input").value = e.target.value;
});

$("buffer-input").addEventListener("input", (e) => {
  if (e.target.value !== "") $("buffer-range").value = e.target.value;
});

$("buffer-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("buffer-input").value;
  const bufferW = raw === "" ? 0 : Number(raw);

  if (!Number.isFinite(bufferW) || bufferW < 0) {
    flash("override-message", "Buffer must be a non-negative number.");
    return;
  }

  const res = await fetch("/api/buffer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bufferW }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    flash("override-message", `Error: ${body.error || res.status}`);
    return;
  }

  render(await res.json());
  flash("override-message", `Grid import buffer set to ${bufferW} W.`);
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function refreshNotifyButton() {
  const button = $("notify-button");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    button.disabled = true;
    button.textContent = "Notifications not supported in this browser";
    return;
  }

  if (Notification.permission === "denied") {
    button.disabled = true;
    button.textContent = "Notifications blocked in browser settings";
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  button.textContent = existing ? "Notifications enabled" : "Enable notifications";
  button.disabled = Boolean(existing);
}

async function enablePush() {
  const button = $("notify-button");
  try {
    const keyRes = await fetch("/api/push/public-key");
    const { publicKey, enabled } = await keyRes.json();
    if (!enabled || !publicKey) {
      flash("notify-message", "Push notifications aren't configured on the server.");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      flash("notify-message", "Notification permission was not granted.");
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });

    flash("notify-message", "Notifications enabled - you'll get an alert when charging completes.");
    await refreshNotifyButton();
  } catch (err) {
    flash("notify-message", `Couldn't enable notifications: ${err.message || err}`);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then(() => refreshNotifyButton())
    .catch(() => {});
}

$("notify-button").addEventListener("click", enablePush);

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

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener("open", () => {
    $("conn-indicator").classList.remove("dot-off");
    $("conn-indicator").classList.add("dot-on");
    setText("conn-label", "Live");
  });

  ws.addEventListener("close", () => {
    $("conn-indicator").classList.remove("dot-on");
    $("conn-indicator").classList.add("dot-off");
    setText("conn-label", "Reconnecting…");
    setTimeout(connectWs, 2000);
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "status") render(msg.data);
  });
}

fetchStatus();
loadVehicles();
connectWs();
setInterval(tickCountdown, 1000);
