const $ = (id) => document.getElementById(id);
const tokenKey = "evcharge-override-token";

$("token-input").value = localStorage.getItem(tokenKey) || "";
$("save-token").addEventListener("click", () => {
  localStorage.setItem(tokenKey, $("token-input").value);
  flash("override-message", "Token saved locally.");
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
  $("mode").textContent = status.override.mode.replace(/_/g, " ");
  $("last-poll").textContent = fmtTime(status.lastPollAt);
  $("last-error").textContent = status.lastError || "";

  document
    .querySelectorAll("[data-mode]")
    .forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === status.override.mode));
}

async function fetchStatus() {
  const res = await fetch("/api/status");
  render(await res.json());
}

document.querySelectorAll("[data-mode]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const mode = btn.dataset.mode;
    const amps = $("amps-input").value ? Number($("amps-input").value) : undefined;
    const token = localStorage.getItem(tokenKey) || "";

    const res = await fetch("/api/override", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-override-token": token },
      body: JSON.stringify({ mode, amps }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      flash("override-message", `Error: ${body.error || res.status}`);
      return;
    }

    render(await res.json());
    flash("override-message", `Mode set to ${mode}.`);
  });
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
connectWs();
