import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { Escrow } from "../target/types/escrow";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Escrow as Program<Escrow>;
  const buyer = (provider.wallet as anchor.Wallet).payer;
  const seller = Keypair.generate();
  const stranger = Keypair.generate();

  let mint: PublicKey;
  let buyerToken: PublicKey;
  let sellerToken: PublicKey;

  const farFuture = () => new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

  const pdas = (id: number) => {
    const idBytes = new anchor.BN(id).toArrayLike(Buffer, "le", 8);
    const [escrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), buyer.publicKey.toBuffer(), idBytes],
      program.programId
    );
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrow.toBuffer()],
      program.programId
    );
    return { escrow, vault };
  };

  const create = async (id: number, amount: number, deadline: anchor.BN) => {
    const { escrow, vault } = pdas(id);
    await program.methods
      .create(new anchor.BN(id), new anchor.BN(amount), deadline)
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        mint,
        escrow,
        vault,
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    return { escrow, vault };
  };

  const balance = async (acct: PublicKey) =>
    Number((await getAccount(provider.connection, acct)).amount);

  before(async () => {
    mint = await createMint(provider.connection, buyer, buyer.publicKey, null, 6);
    buyerToken = await createAccount(provider.connection, buyer, mint, buyer.publicKey);
    sellerToken = await createAccount(provider.connection, buyer, mint, seller.publicKey);
    await mintTo(provider.connection, buyer, mint, buyerToken, buyer, 10_000_000);
  });

  it("locks tokens in escrow", async () => {
    const { escrow, vault } = await create(1, 1_000_000, farFuture());
    assert.equal(await balance(vault), 1_000_000);
    assert.equal(await balance(buyerToken), 9_000_000);

    const state = await program.account.escrow.fetch(escrow);
    assert.ok(state.seller.equals(seller.publicKey));
    assert.equal(state.amount.toNumber(), 1_000_000);
  });

  it("rejects zero amount and past deadlines", async () => {
    for (const [id, amount, deadline, expected] of [
      [90, 0, farFuture(), "ZeroAmount"],
      [91, 1000, new anchor.BN(1), "DeadlineInPast"],
    ] as [number, number, anchor.BN, string][]) {
      try {
        await create(id, amount, deadline);
        assert.fail("expected create to fail");
      } catch (err: any) {
        assert.include(String(err), expected);
      }
    }
  });

  it("does not let the buyer refund before the deadline", async () => {
    const { escrow, vault } = pdas(1);
    try {
      await program.methods
        .refund()
        .accounts({
          caller: buyer.publicKey,
          escrow,
          buyer: buyer.publicKey,
          vault,
          buyerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();
      assert.fail("expected refund to fail");
    } catch (err: any) {
      assert.include(String(err), "TooEarly");
    }
  });

  it("does not let a stranger refund", async () => {
    const { escrow, vault } = pdas(1);
    try {
      await program.methods
        .refund()
        .accounts({
          caller: stranger.publicKey,
          escrow,
          buyer: buyer.publicKey,
          vault,
          buyerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([stranger])
        .rpc();
      assert.fail("expected refund to fail");
    } catch (err: any) {
      assert.include(String(err), "NotAllowed");
    }
  });

  it("releases funds to the seller and closes the escrow", async () => {
    const { escrow, vault } = pdas(1);
    await program.methods
      .release()
      .accounts({
        buyer: buyer.publicKey,
        escrow,
        vault,
        sellerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    assert.equal(await balance(sellerToken), 1_000_000);
    assert.isNull(await provider.connection.getAccountInfo(escrow));
    assert.isNull(await provider.connection.getAccountInfo(vault));
  });

  it("lets the seller cancel and refund the buyer at any time", async () => {
    const before = await balance(buyerToken);
    const { escrow, vault } = await create(2, 500_000, farFuture());

    await program.methods
      .refund()
      .accounts({
        caller: seller.publicKey,
        escrow,
        buyer: buyer.publicKey,
        vault,
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([seller])
      .rpc();

    assert.equal(await balance(buyerToken), before);
    assert.isNull(await provider.connection.getAccountInfo(escrow));
  });

  it("lets the buyer refund after the deadline", async () => {
    const before = await balance(buyerToken);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 4);
    const { escrow, vault } = await create(3, 250_000, deadline);
    await sleep(8000);

    await program.methods
      .refund()
      .accounts({
        caller: buyer.publicKey,
        escrow,
        buyer: buyer.publicKey,
        vault,
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    assert.equal(await balance(buyerToken), before);
  });
});
