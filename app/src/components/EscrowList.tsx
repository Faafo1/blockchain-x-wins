import { useCallback, useEffect, useState } from "react";
import type { Program, Idl } from "@coral-xyz/anchor";
import { useConnection, type AnchorWallet } from "@solana/wallet-adapter-react";
import { getMint } from "@solana/spl-token";
import { explorerUrl } from "../config";
import {
  fetchMyEscrows,
  hasArbiter,
  refundEscrow,
  releaseEscrow,
  releasePartEscrow,
  resolveEscrow,
  type EscrowRecord,
} from "../lib/escrow";
import { errorText, formatDeadline, formatUnits, parseUnits, shortKey } from "../lib/format";
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
  const [partial, setPartial] = useState<Record<string, string>>({});
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

  const act = async (record: EscrowRecord, kind: "release" | "refund" | "pay-seller" | "refund-buyer") => {
    const id = record.publicKey.toBase58();
    setBusyId(id);
    try {
      setStatus({ kind: "info", text: "Approve the transaction in your wallet…" });
      let sig: string;
      if (kind === "release") sig = await releaseEscrow(program, wallet.publicKey, record);
      else if (kind === "refund") sig = await refundEscrow(program, wallet.publicKey, record);
      else sig = await resolveEscrow(program, wallet.publicKey, record, kind === "pay-seller");
      const text = {
        release: "Released. The seller has been paid.",
        refund: "Refunded to the buyer.",
        "pay-seller": "Decision made: the seller has been paid.",
        "refund-buyer": "Decision made: the buyer has been refunded.",
      }[kind];
      setStatus({ kind: "ok", text, link: explorerUrl("tx", sig) });
      onChanged();
    } catch (e) {
      setStatus({ kind: "err", text: errorText(e) });
    } finally {
      setBusyId(null);
    }
  };

  const payPart = async (record: EscrowRecord) => {
    const id = record.publicKey.toBase58();
    const dec = decimals[record.account.mint.toBase58()] ?? 0;
    const raw = parseUnits(partial[id] ?? "", dec);
    if (!raw || raw.gte(record.account.amount)) {
      setStatus({
        kind: "err",
        text: "Enter an amount above zero and below what is left. To pay everything, use Release to seller.",
      });
      return;
    }
    setBusyId(id);
    try {
      setStatus({ kind: "info", text: "Approve the transaction in your wallet…" });
      const sig = await releasePartEscrow(program, wallet.publicKey, record, raw);
      setPartial((p) => ({ ...p, [id]: "" }));
      setStatus({
        kind: "ok",
        text: `Paid ${formatUnits(raw, dec)} to the seller. The rest stays locked.`,
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
          const withArbiter = hasArbiter(a);
          const isArbiter = withArbiter && a.arbiter.equals(wallet.publicKey);
          const deadline = a.deadline.toNumber();
          const pastDeadline = now >= deadline;
          const dec = decimals[a.mint.toBase58()] ?? 0;
          const buyerCanReclaim = isBuyer && !withArbiter && pastDeadline;
          const canRefund = isSeller || buyerCanReclaim;
          const role = isArbiter ? "You are the arbiter" : isBuyer ? "You are the buyer" : "You are the seller";
          return (
            <li key={id}>
              <div className="amount">
                {formatUnits(a.amount, dec)} <span className="muted">tokens</span>
                {!a.amount.eq(a.totalAmount) && (
                  <span className="muted small-text">
                    {" "}
                    left of {formatUnits(a.totalAmount, dec)} (paid so far: {formatUnits(a.totalAmount.sub(a.amount), dec)})
                  </span>
                )}
              </div>
              <div className="meta">
                {role}
                <br />
                Buyer {shortKey(a.buyer.toBase58())} → Seller {shortKey(a.seller.toBase58())}
                <br />
                Arbiter {withArbiter ? shortKey(a.arbiter.toBase58()) : "none"}
                <br />
                Token {shortKey(a.mint.toBase58())}
                <br />
                {withArbiter
                  ? `Deadline ${pastDeadline ? "passed" : "is"} ${formatDeadline(deadline)}; the arbiter decides disputes`
                  : `${pastDeadline ? "Deadline passed" : "Buyer can refund after"} ${formatDeadline(deadline)}`}
              </div>
              {isBuyer && (
                <div className="row">
                  <input
                    className="part"
                    value={partial[id] ?? ""}
                    onChange={(e) => setPartial((p) => ({ ...p, [id]: e.target.value }))}
                    inputMode="decimal"
                    placeholder="Amount to pay now"
                    aria-label="Amount to pay the seller now"
                  />
                  <button className="secondary" disabled={busyId === id} onClick={() => payPart(r)}>
                    Pay part now
                  </button>
                </div>
              )}
              <div className="row">
                {isBuyer && (
                  <button disabled={busyId === id} onClick={() => act(r, "release")}>
                    Release all to seller
                  </button>
                )}
                {canRefund && (
                  <button className="secondary" disabled={busyId === id} onClick={() => act(r, "refund")}>
                    {isSeller ? "Cancel and refund buyer" : "Refund me"}
                  </button>
                )}
                {isArbiter && (
                  <>
                    <button disabled={busyId === id} onClick={() => act(r, "pay-seller")}>
                      Decide: pay seller
                    </button>
                    <button className="secondary" disabled={busyId === id} onClick={() => act(r, "refund-buyer")}>
                      Decide: refund buyer
                    </button>
                  </>
                )}
                {isBuyer && !isSeller && !withArbiter && !pastDeadline && (
                  <span className="muted small-text">Refund unlocks after the deadline.</span>
                )}
                {isBuyer && !isSeller && withArbiter && (
                  <span className="muted small-text">The arbiter decides if you and the seller disagree.</span>
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
