import { useState, type FormEvent } from "react";
import type { Program, Idl } from "@coral-xyz/anchor";
import { useConnection, type AnchorWallet } from "@solana/wallet-adapter-react";
import { getMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { explorerUrl } from "../config";
import { createEscrow } from "../lib/escrow";
import { errorText, parseUnits } from "../lib/format";
import type { Status } from "../App";

const DEADLINES = [
  { label: "5 minutes (for testing)", seconds: 5 * 60 },
  { label: "1 day", seconds: 24 * 3600 },
  { label: "3 days", seconds: 3 * 24 * 3600 },
  { label: "7 days", seconds: 7 * 24 * 3600 },
  { label: "14 days", seconds: 14 * 24 * 3600 },
];

type Props = {
  program: Program<Idl>;
  wallet: AnchorWallet;
  mint: string;
  setMint: (v: string) => void;
  setStatus: (s: Status) => void;
  onDone: () => void;
};

function toKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value.trim());
  } catch {
    return null;
  }
}

export function CreateEscrowForm({ program, wallet, mint, setMint, setStatus, onDone }: Props) {
  const { connection } = useConnection();
  const [seller, setSeller] = useState("");
  const [amount, setAmount] = useState("");
  const [seconds, setSeconds] = useState(DEADLINES[1].seconds);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const sellerKey = toKey(seller);
    const mintKey = toKey(mint);
    if (!sellerKey) return setStatus({ kind: "err", text: "The seller address is not a valid Solana address." });
    if (!mintKey) return setStatus({ kind: "err", text: "The token address is not a valid Solana address." });
    if (sellerKey.equals(wallet.publicKey))
      return setStatus({ kind: "err", text: "The seller must be a different wallet from yours." });

    setBusy(true);
    try {
      const mintInfo = await getMint(connection, mintKey);
      const raw = parseUnits(amount, mintInfo.decimals);
      if (!raw) {
        setStatus({
          kind: "err",
          text: `Enter an amount above zero with at most ${mintInfo.decimals} decimal places.`,
        });
        return;
      }
      const deadline = new BN(Math.floor(Date.now() / 1000) + seconds);
      setStatus({ kind: "info", text: "Approve the transaction in your wallet…" });
      const sig = await createEscrow(program, wallet.publicKey, {
        seller: sellerKey,
        mint: mintKey,
        amount: raw,
        deadline,
      });
      setStatus({ kind: "ok", text: "Tokens are now locked in escrow.", link: explorerUrl("tx", sig) });
      setAmount("");
      onDone();
    } catch (err) {
      setStatus({ kind: "err", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Lock tokens for a seller</h2>
      <form onSubmit={submit}>
        <label>
          Seller wallet address
          <input value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="Paste the seller's address" required />
        </label>
        <label>
          Token address (mint)
          <input value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Paste the token's mint address" required />
        </label>
        <label>
          Amount
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="e.g. 25" required />
        </label>
        <label>
          Buyer can take it back after
          <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
            {DEADLINES.map((d) => (
              <option key={d.seconds} value={d.seconds}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : "Lock tokens"}
        </button>
      </form>
    </section>
  );
}
