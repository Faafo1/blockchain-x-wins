import { useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { CLUSTER, PROGRAM_ID, explorerUrl } from "./config";
import { getProgram } from "./lib/escrow";
import { shortKey } from "./lib/format";
import { CreateEscrowForm } from "./components/CreateEscrowForm";
import { EscrowList } from "./components/EscrowList";
import { DevTools } from "./components/DevTools";

export type Status = { kind: "ok" | "err" | "info"; text: string; link?: string } | null;

export default function App() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const program = useMemo(() => (wallet ? getProgram(connection, wallet) : null), [connection, wallet]);

  const [mint, setMint] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Blockchain X Wins</h1>
          <p className="tagline">Escrow for online deals: money is locked until the buyer confirms delivery.</p>
        </div>
        <div className="top-right">
          <span className={`badge ${CLUSTER}`}>{CLUSTER}</span>
          <WalletMultiButton />
        </div>
      </header>

      <section className="how card">
        <h2>How it works</h2>
        <ol>
          <li><b>Buyer locks tokens</b> for a seller, with a deadline.</li>
          <li><b>Buyer releases</b> the tokens when the goods arrive, and the seller is paid.</li>
          <li><b>Refund:</b> the seller can cancel any time, and the buyer can take the money back after the deadline.</li>
        </ol>
      </section>

      {status && (
        <div className={`status ${status.kind}`} role="status">
          {status.text}
          {status.link && (
            <>
              {" "}
              <a href={status.link} target="_blank" rel="noreferrer">View transaction</a>
            </>
          )}
          <button className="x" onClick={() => setStatus(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {!wallet || !program ? (
        <section className="card connect">
          <h2>Connect your wallet</h2>
          <p>
            Install a Solana wallet such as Phantom, switch it to{" "}
            <b>{CLUSTER === "localnet" ? "Localnet (Developer Settings)" : "Devnet"}</b>, then press
            “Select Wallet” above.
          </p>
        </section>
      ) : (
        <>
          <DevTools wallet={wallet} setStatus={setStatus} onMint={setMint} />
          <div className="grid">
            <CreateEscrowForm
              program={program}
              wallet={wallet}
              mint={mint}
              setMint={setMint}
              setStatus={setStatus}
              onDone={refresh}
            />
            <EscrowList program={program} wallet={wallet} refreshKey={refreshKey} setStatus={setStatus} onChanged={refresh} />
          </div>
        </>
      )}

      <footer>
        Program{" "}
        <a href={explorerUrl("address", PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">
          {shortKey(PROGRAM_ID.toBase58(), 6)}
        </a>{" "}
        · {CLUSTER} · demo software, not audited. Do not use with real funds.
      </footer>
    </div>
  );
}
