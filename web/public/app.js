const $ = (id) => document.getElementById(id);
const tokenKey = "evcharge-override-token";

$("token-input").value = localStorage.getItem(tokenKey) || "";
$("save-token").addEventListener("click", () => {
  localStorage.setItem(tokenKey, $("token-input").value);
  flash("override-message", "Token saved locally.");
  loadVehicles();
});

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

function render(status) {
  const s = status.solar;
  $("pv").textContent = s ? fmtW(s.pvPowerW) : "–";
  $("load").textContent = s ? fmtW(s.loadPowerW) : "–";
  $("grid").textContent = s ? fmtW(s.gridPowerW) : "–";
  $("surplus").textContent = fmtW(status.surplusW);

  const v = status.vehicle;
  $("plugged").textContent = v ? (v.pluggedIn ? "Yes" : "No") : "unknown";
  $("charging-state").textContent = v ? v.chargingState : "unknown";
  $("battery").textContent = v ? `${v.batteryLevel}%` : "–";
  $("amps").textContent = v ? `${v.chargeAmps} A` : "–";

  $("decision").textContent = status.decision.replace(/_/g, " ");
  $("target-amps").textContent = status.targetAmps !== null ? `${status.targetAmps} A` : "–";
  $("last-poll").textContent = fmtTime(status.lastPollAt);
  $("last-error").textContent = status.lastError || "";

  $("enabled-toggle").checked = status.override.enabled;
  $("enabled-label").textContent = status.override.enabled ? "On" : "Off";

  const select = $("vehicle-select");
  if (status.vehicleTag && [...select.options].some((o) => o.value === status.vehicleTag)) {
    select.value = status.vehicleTag;
  }
}

async function fetchStatus() {
  const res = await fetch("/api/status");
  render(await res.json());
}

async function loadVehicles() {
  const token = localStorage.getItem(tokenKey) || "";
  if (!token) return;

  const res = await fetch("/api/vehicles", { headers: { "x-override-token": token } });
  if (!res.ok) return;

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
  const token = localStorage.getItem(tokenKey) || "";

  const res = await fetch("/api/vehicle", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-override-token": token },
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
  const token = localStorage.getItem(tokenKey) || "";

  const res = await fetch("/api/enabled", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-override-token": token },
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

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener("open", () => {
    $("conn-indicator").classList.remove("dot-off");
    $("conn-indicator").classList.add("dot-on");
  });

  ws.addEventListener("close", () => {
    $("conn-indicator").classList.remove("dot-on");
    $("conn-indicator").classList.add("dot-off");
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
