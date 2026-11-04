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
const NO_ARBITER = PublicKey.default;

describe("escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Escrow as Program<Escrow>;
  const buyer = (provider.wallet as anchor.Wallet).payer;
  const seller = Keypair.generate();
  const stranger = Keypair.generate();
  const arbiter = Keypair.generate();

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

  const create = async (
    id: number,
    amount: number,
    deadline: anchor.BN,
    arbiterKey: PublicKey = NO_ARBITER,
    sellerKey: PublicKey = seller.publicKey
  ) => {
    const { escrow, vault } = pdas(id);
    await program.methods
      .create(new anchor.BN(id), new anchor.BN(amount), deadline, arbiterKey)
      .accounts({
        buyer: buyer.publicKey,
        seller: sellerKey,
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

  const refund = (id: number, caller: Keypair, signers: Keypair[] = []) => {
    const { escrow, vault } = pdas(id);
    const builder = program.methods.refund().accounts({
      caller: caller.publicKey,
      escrow,
      buyer: buyer.publicKey,
      vault,
      buyerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any);
    return signers.length ? builder.signers(signers).rpc() : builder.rpc();
  };

  const resolve = (id: number, caller: Keypair, paySeller: boolean) => {
    const { escrow, vault } = pdas(id);
    return program.methods
      .resolve(paySeller)
      .accounts({
        arbiter: caller.publicKey,
        escrow,
        buyer: buyer.publicKey,
        vault,
        sellerToken,
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([caller])
      .rpc();
  };

  const balance = async (acct: PublicKey) =>
    Number((await getAccount(provider.connection, acct)).amount);

  const expectFail = async (run: () => Promise<unknown>, expected: string) => {
    try {
      await run();
    } catch (err: any) {
      assert.include(String(err), expected);
      return;
    }
    assert.fail(`expected failure containing ${expected}`);
  };

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
    assert.ok(state.arbiter.equals(NO_ARBITER));
    assert.equal(state.amount.toNumber(), 1_000_000);
  });

  it("rejects zero amount and past deadlines", async () => {
    await expectFail(() => create(90, 0, farFuture()), "ZeroAmount");
    await expectFail(() => create(91, 1000, new anchor.BN(1)), "DeadlineInPast");
  });

  it("rejects an arbiter who is the buyer or the seller", async () => {
    await expectFail(
      () => create(92, 1000, farFuture(), seller.publicKey),
      "InvalidArbiter"
    );
    await expectFail(
      () => create(93, 1000, farFuture(), buyer.publicKey),
      "InvalidArbiter"
    );
  });

  it("does not let the buyer refund before the deadline", async () => {
    await expectFail(() => refund(1, buyer), "TooEarly");
  });

  it("does not let a stranger refund", async () => {
    await expectFail(() => refund(1, stranger, [stranger]), "NotAllowed");
  });

  it("does not let anyone resolve when there is no arbiter", async () => {
    await expectFail(() => resolve(1, stranger, true), "NotArbiter");
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
    const { escrow } = await create(2, 500_000, farFuture());

    await refund(2, seller, [seller]);

    assert.equal(await balance(buyerToken), before);
    assert.isNull(await provider.connection.getAccountInfo(escrow));
  });

  it("lets the buyer refund after the deadline when there is no arbiter", async () => {
    const before = await balance(buyerToken);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 4);
    await create(3, 250_000, deadline);
    await sleep(8000);

    await refund(3, buyer);

    assert.equal(await balance(buyerToken), before);
  });

  describe("with an arbiter", () => {
    it("lets the arbiter pay the seller", async () => {
      const sellerBefore = await balance(sellerToken);
      const { escrow } = await create(10, 300_000, farFuture(), arbiter.publicKey);

      await resolve(10, arbiter, true);

      assert.equal(await balance(sellerToken), sellerBefore + 300_000);
      assert.isNull(await provider.connection.getAccountInfo(escrow));
    });

    it("lets the arbiter refund the buyer", async () => {
      const buyerBefore = await balance(buyerToken);
      const { escrow } = await create(11, 300_000, farFuture(), arbiter.publicKey);

      await resolve(11, arbiter, false);

      assert.equal(await balance(buyerToken), buyerBefore);
      assert.isNull(await provider.connection.getAccountInfo(escrow));
    });

    it("does not let anyone else resolve it", async () => {
      await create(12, 100_000, farFuture(), arbiter.publicKey);
      await expectFail(() => resolve(12, stranger, true), "NotArbiter");
      await expectFail(() => resolve(12, seller, true), "NotArbiter");
    });

    it("does not let the buyer wait out the deadline and reclaim the funds", async () => {
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 4);
      await create(13, 100_000, deadline, arbiter.publicKey);
      await sleep(8000);
      await expectFail(() => refund(13, buyer), "ArbiterDecides");
    });

    it("still lets the buyer release and the seller cancel", async () => {
      // escrow 12 and 13 are still open from the tests above
      const sellerBefore = await balance(sellerToken);
      const e12 = pdas(12);
      await program.methods
        .release()
        .accounts({
          buyer: buyer.publicKey,
          escrow: e12.escrow,
          vault: e12.vault,
          sellerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();
      assert.equal(await balance(sellerToken), sellerBefore + 100_000);

      const buyerBefore = await balance(buyerToken);
      await refund(13, seller, [seller]);
      assert.equal(await balance(buyerToken), buyerBefore + 100_000);
    });
  });
});
