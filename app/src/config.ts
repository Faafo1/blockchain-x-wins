import { PublicKey } from "@solana/web3.js";
import idl from "./idl/escrow.json";

const RPC_BY_CLUSTER = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
} as const;

export type ClusterName = keyof typeof RPC_BY_CLUSTER;

const requested = (import.meta.env.VITE_CLUSTER as string | undefined) ?? "localnet";

export const CLUSTER: ClusterName = requested === "devnet" ? "devnet" : "localnet";

export const RPC_URL: string =
  (import.meta.env.VITE_RPC_URL as string | undefined) || RPC_BY_CLUSTER[CLUSTER];

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);

export function explorerUrl(kind: "address" | "tx", value: string): string {
  const base = `https://explorer.solana.com/${kind}/${value}`;
  if (CLUSTER === "devnet") return `${base}?cluster=devnet`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;
}
