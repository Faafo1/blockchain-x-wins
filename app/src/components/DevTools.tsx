import { useState } from "react";
import { useConnection, useWallet, type AnchorWallet } from "@solana/wallet-adapter-react";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { CLUSTER, explorerUrl } from "../config";
import { errorText } from "../lib/format";
import type { Status } from "../App";

type Props = {
  wallet: AnchorWallet;
  setStatus: (s: Status) => void;
  onMint: (mint: string) => void;
};

/** Helpers for trying the app on a test network: free SOL (local only) and a throwaway test token. */
export function DevTools({ wallet, setStatus, onMint }: Props) {
  const { connection } = useConnection();
  const { sendTransaction } = useWallet();
  const [busy, setBusy] = useState(false);

  const confirm = async (signature: string) => {
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  };

  const airdrop = async () => {
    setBusy(true);
    try {
      setStatus({ kind: "info", text: "Requesting 2 test SOL…" });
      const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
      await confirm(sig);
      setStatus({ kind: "ok", text: "You received 2 test SOL." });
    } catch (e) {
      setStatus({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const makeTestToken = async () => {
    setBusy(true);
    try {
      setStatus({ kind: "info", text: "Creating a test token… approve it in your wallet." });
      const mint = Keypair.generate();
      const lamports = await getMinimumBalanceForRentExemptMint(connection);
      const ata = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey);
      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: mint.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint.publicKey, 6, wallet.publicKey, null),
        createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint.publicKey),
        createMintToInstruction(mint.publicKey, ata, wallet.publicKey, 1_000_000_000n)
      );
      const sig = await sendTransaction(tx, connection, { signers: [mint] });
      await confirm(sig);
      onMint(mint.publicKey.toBase58());
      setStatus({
        kind: "ok",
        text: "Created a test token and sent you 1,000 of it. Its address is filled in below.",
        link: explorerUrl("tx", sig),
      });
    } catch (e) {
      setStatus({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card tools">
      <h2>Test tools</h2>
      <p className="muted">
        For trying things out on a test network. These tokens have no real value.
      </p>
      <div className="row">
        {CLUSTER === "localnet" && (
          <button className="secondary" disabled={busy} onClick={airdrop}>
            Get 2 test SOL
          </button>
        )}
        <button className="secondary" disabled={busy} onClick={makeTestToken}>
          Create a test token (1,000 to me)
        </button>
      </div>
    </section>
  );
}
