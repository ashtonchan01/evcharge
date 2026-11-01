/**
 * Dashboard names for Ashton's cars. The option value stays the VIN;
 * Tesla's display_name is often "M3" / "MX" or empty, and the picker
 * otherwise falls back to the raw VIN.
 */
const VIN_LABELS: Record<string, string> = {
  "5YJ3F7EA5KF461091": "Model 3",
  "5YJXDCE25JF080915": "Model X",
};

const SHORT_LABELS: Record<string, string> = {
  M3: "Model 3",
  MX: "Model X",
  MS: "Model S",
  MY: "Model Y",
};

/** Tesla model character (VIN position 4) for the common WMIs. */
function modelFromVin(vin: string): string {
  if (vin.length < 4) return "";
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

/**
 * Label shown in the vehicle picker. Known VINs win, then Tesla's short
 * names (M3, MX, …), then a real custom name, then a VIN-prefix guess.
 */
export function vehicleLabel(vin: string | null | undefined, displayName?: string | null): string {
  const id = String(vin ?? "").trim().toUpperCase();
  if (id && VIN_LABELS[id]) return VIN_LABELS[id];

  const raw = String(displayName ?? "").trim();
  const short = SHORT_LABELS[raw.toUpperCase()];
  if (short) return short;

  if (raw && raw.toUpperCase() !== id) return raw;
  return modelFromVin(id) || raw || id;
}
