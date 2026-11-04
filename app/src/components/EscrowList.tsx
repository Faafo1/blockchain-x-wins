import { useCallback, useEffect, useState } from "react";
import type { Program, Idl } from "@coral-xyz/anchor";
import { useConnection, type AnchorWallet } from "@solana/wallet-adapter-react";
import { getMint } from "@solana/spl-token";
import { explorerUrl } from "../config";
import { fetchMyEscrows, refundEscrow, releaseEscrow, type EscrowRecord } from "../lib/escrow";
import { errorText, formatDeadline, formatUnits, shortKey } from "../lib/format";
import type { Status } from "../App";

type Props = {
  program: Program<Idl>;
  wallet: AnchorWallet;
  refreshKey: number;
  setStatus: (s: Status) => void;
  onChanged: () => void;
};

export function EscrowList({ program, wallet, refreshKey, setStatus, onChanged }: Props) {
  const { connection } = useConnection();
  const [items, setItems] = useState<EscrowRecord[] | null>(null);
  const [decimals, setDecimals] = useState<Record<string, number>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async () => {
    try {
      const records = await fetchMyEscrows(program, wallet.publicKey);
      const mints = [...new Set(records.map((r) => r.account.mint.toBase58()))];
      const found: Record<string, number> = {};
      await Promise.all(
        mints.map(async (m) => {
          const info = await getMint(connection, records.find((r) => r.account.mint.toBase58() === m)!.account.mint);
          found[m] = info.decimals;
        })
      );
      setDecimals(found);
      setItems(records);
    } catch (e) {
      setItems([]);
      setStatus({ kind: "err", text: errorText(e) });
    }
  }, [program, wallet.publicKey, connection, setStatus]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15000);
    return () => clearInterval(t);
  }, []);

  const act = async (record: EscrowRecord, kind: "release" | "refund") => {
    const id = record.publicKey.toBase58();
    setBusyId(id);
    try {
      setStatus({ kind: "info", text: "Approve the transaction in your wallet…" });
      const sig =
        kind === "release"
          ? await releaseEscrow(program, wallet.publicKey, record)
          : await refundEscrow(program, wallet.publicKey, record);
      setStatus({
        kind: "ok",
        text: kind === "release" ? "Released. The seller has been paid." : "Refunded to the buyer.",
        link: explorerUrl("tx", sig),
      });
      onChanged();
    } catch (e) {
      setStatus({ kind: "err", text: errorText(e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="card">
      <div className="head-row">
        <h2>Your open escrows</h2>
        <button className="secondary small" onClick={() => { setItems(null); void load(); }}>
          Refresh
        </button>
      </div>

      {items === null && <p className="muted">Loading…</p>}
      {items !== null && items.length === 0 && (
        <p className="muted">Nothing here yet. Locked deals where you are the buyer or the seller will show up.</p>
      )}

      <ul className="list">
        {items?.map((r) => {
          const a = r.account;
          const id = r.publicKey.toBase58();
          const isBuyer = a.buyer.equals(wallet.publicKey);
          const isSeller = a.seller.equals(wallet.publicKey);
          const deadline = a.deadline.toNumber();
          const pastDeadline = now >= deadline;
          const dec = decimals[a.mint.toBase58()] ?? 0;
          const canRefund = isSeller || (isBuyer && pastDeadline);
          return (
            <li key={id}>
              <div className="amount">
                {formatUnits(a.amount, dec)} <span className="muted">tokens</span>
              </div>
              <div className="meta">
                {isBuyer ? "You are the buyer" : "You are the seller"}
                {isBuyer && isSeller ? " and the seller" : ""}
                <br />
                Buyer {shortKey(a.buyer.toBase58())} → Seller {shortKey(a.seller.toBase58())}
                <br />
                Token {shortKey(a.mint.toBase58())}
                <br />
                {pastDeadline ? "Deadline passed" : "Buyer can refund after"} {formatDeadline(deadline)}
              </div>
              <div className="row">
                {isBuyer && (
                  <button disabled={busyId === id} onClick={() => act(r, "release")}>
                    Release to seller
                  </button>
                )}
                {canRefund && (
                  <button className="secondary" disabled={busyId === id} onClick={() => act(r, "refund")}>
                    {isSeller ? "Cancel and refund buyer" : "Refund me"}
                  </button>
                )}
                {isBuyer && !pastDeadline && !isSeller && (
                  <span className="muted small-text">Refund unlocks after the deadline.</span>
                )}
                <a className="small-text" href={explorerUrl("address", id)} target="_blank" rel="noreferrer">
                  Explorer
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
