import BN from "bn.js";

export function shortKey(key: string, chars = 4): string {
  return key.length <= chars * 2 + 1 ? key : `${key.slice(0, chars)}…${key.slice(-chars)}`;
}

/** "12.5" with 6 decimals -> 12500000 (as BN). Returns null for invalid input. */
export function parseUnits(value: string, decimals: number): BN | null {
  const v = value.trim();
  if (!/^\d*\.?\d*$/.test(v) || v === "" || v === ".") return null;
  const [whole, frac = ""] = v.split(".");
  if (frac.length > decimals) return null;
  const digits = (whole || "0") + frac.padEnd(decimals, "0");
  const bn = new BN(digits, 10);
  return bn.isZero() ? null : bn;
}

/** 12500000 with 6 decimals -> "12.5" */
export function formatUnits(raw: BN, decimals: number): string {
  const s = raw.toString(10).padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function formatDeadline(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

const FRIENDLY: Array<[RegExp, string]> = [
  [/User rejected|rejected the request|declined/i, "You cancelled the request in your wallet."],
  [/ZeroAmount|0x1770/, "Amount must be greater than zero."],
  [/DeadlineInPast|0x1771/, "The deadline must be in the future."],
  [/NotAllowed|0x1772/, "Only the seller, or the buyer after the deadline, can refund."],
  [/TooEarly|0x1773/, "The deadline has not passed yet, so the buyer cannot refund."],
  [/insufficient funds|0x1\b/i, "Not enough tokens or SOL in your wallet for this."],
  [/Attempt to debit an account but found no record|AccountNotFound/i, "Your wallet has no SOL on this network yet."],
  [/Failed to fetch|NetworkError|ECONNREFUSED/i, "Cannot reach the network. Is your local test network running?"],
];

export function errorText(e: unknown): string {
  const any = e as { error?: { errorMessage?: string }; message?: string };
  const raw = any?.error?.errorMessage ?? any?.message ?? String(e);
  for (const [pattern, text] of FRIENDLY) if (pattern.test(raw)) return text;
  return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
}
