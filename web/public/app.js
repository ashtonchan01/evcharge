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

function flash(id, msg) {
  const el = $(id);
  el.textContent = msg;
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = "";
  }, 4000);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

let nextPollAt = null;

function tickCountdown() {
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

  const decisionEl = $("decision");
  decisionEl.textContent = status.decision.replace(/_/g, " ");
  decisionEl.className = `decision-pill ${status.decision}`;

  setText("target-amps", status.targetAmps !== null ? `${Math.round(status.targetAmps)} A` : "–");
  setText("last-poll", fmtTime(status.lastPollAt));
  setText("last-error", status.lastError || "");

  nextPollAt = status.lastPollAt ? new Date(status.lastPollAt).getTime() + status.pollIntervalMs : null;
  tickCountdown();

  $("enabled-toggle").checked = status.override.enabled;
  setText("enabled-label", status.override.enabled ? "On" : "Off");

  const select = $("vehicle-select");
  if (status.vehicleTag && [...select.options].some((o) => o.value === status.vehicleTag)) {
    select.value = status.vehicleTag;
  }

  const bufferInput = $("buffer-input");
  const bufferRange = $("buffer-range");
  if (document.activeElement !== bufferInput && document.activeElement !== bufferRange) {
    bufferInput.value = status.gridImportBufferW || "";
    bufferRange.value = status.gridImportBufferW || 0;
  }

  const chargeLimitInput = $("charge-limit-input");
  const chargeLimitRange = $("charge-limit-range");
  if (
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

async function loadVehicles() {
  const res = await fetch("/api/vehicles");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const select = $("vehicle-select");
    select.innerHTML = `<option value="">Couldn't load vehicles (${body.error || res.status})</option>`;
    flash("override-message", `Couldn't load vehicles: ${body.error || res.status}`);
    return;
  }

  const vehicles = await res.json();
  const select = $("vehicle-select");
  const current = select.value;
  select.innerHTML = '<option value="">Select vehicle…</option>';
  for (const v of vehicles) {
    const opt = document.createElement("option");
    opt.value = v.vin;
    opt.textContent = `${v.displayName || v.vin} (${v.state})`;
    select.appendChild(opt);
  }
  if (current) select.value = current;
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
  const percent = Number($("charge-limit-input").value);

  if (!Number.isFinite(percent) || percent < 50 || percent > 100) {
    flash("override-message", "Charge limit must be between 50 and 100.");
    return;
  }

  const res = await fetch("/api/charge-limit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ percent }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    flash("override-message", `Error: ${body.error || res.status}`);
    return;
  }

  render(await res.json());
  flash("override-message", `Charge limit set to ${percent}%.`);
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
