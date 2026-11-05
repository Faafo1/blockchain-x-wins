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
  let arbiterToken: PublicKey;
  let strangerToken: PublicKey;

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
    sellerKey: PublicKey = seller.publicKey,
    feeBps = 0
  ) => {
    const { escrow, vault } = pdas(id);
    await program.methods
      .create(new anchor.BN(id), new anchor.BN(amount), deadline, arbiterKey, feeBps)
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
    // Each caller passes their own token account for the fee.
    const callerToken = caller.publicKey.equals(arbiter.publicKey)
      ? arbiterToken
      : caller.publicKey.equals(seller.publicKey)
        ? sellerToken
        : strangerToken;
    return program.methods
      .resolve(paySeller)
      .accounts({
        arbiter: caller.publicKey,
        escrow,
        buyer: buyer.publicKey,
        vault,
        sellerToken,
        buyerToken,
        arbiterToken: callerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([caller])
      .rpc();
  };

  const releasePart = (id: number, amount: number, signer?: Keypair) => {
    const { escrow, vault } = pdas(id);
    const builder = program.methods.releasePart(new anchor.BN(amount)).accounts({
      buyer: signer ? signer.publicKey : buyer.publicKey,
      escrow,
      vault,
      sellerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any);
    return signer ? builder.signers([signer]).rpc() : builder.rpc();
  };

  const fullRelease = (id: number) => {
    const { escrow, vault } = pdas(id);
    return program.methods
      .release()
      .accounts({
        buyer: buyer.publicKey,
        escrow,
        vault,
        sellerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
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
    arbiterToken = await createAccount(provider.connection, buyer, mint, arbiter.publicKey);
    strangerToken = await createAccount(provider.connection, buyer, mint, stranger.publicKey);
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

  describe("partial releases", () => {
    it("pays part now and keeps the escrow open with the rest", async () => {
      const sellerBefore = await balance(sellerToken);
      const { escrow, vault } = await create(20, 1_000_000, farFuture());

      await releasePart(20, 400_000);

      assert.equal(await balance(sellerToken), sellerBefore + 400_000);
      assert.equal(await balance(vault), 600_000);
      const state = await program.account.escrow.fetch(escrow);
      assert.equal(state.amount.toNumber(), 600_000);
      assert.equal(state.totalAmount.toNumber(), 1_000_000);
    });

    it("lets the buyer release the rest in full afterwards", async () => {
      const sellerBefore = await balance(sellerToken);
      const { escrow, vault } = pdas(20);

      await fullRelease(20);

      assert.equal(await balance(sellerToken), sellerBefore + 600_000);
      assert.isNull(await provider.connection.getAccountInfo(escrow));
      assert.isNull(await provider.connection.getAccountInfo(vault));
    });

    it("rejects zero, everything that is left, and more than is left", async () => {
      await create(21, 500_000, farFuture());
      await expectFail(() => releasePart(21, 0), "InvalidPartialAmount");
      await expectFail(() => releasePart(21, 500_000), "InvalidPartialAmount");
      await expectFail(() => releasePart(21, 900_000), "InvalidPartialAmount");
    });

    it("does not let anyone but the buyer release part", async () => {
      await expectFail(() => releasePart(21, 100_000, stranger), "ConstraintHasOne");
      await expectFail(() => releasePart(21, 100_000, seller), "ConstraintHasOne");
    });

    it("refunds only what is left after a partial release", async () => {
      const buyerBefore = await balance(buyerToken);
      await releasePart(21, 200_000);

      await refund(21, seller, [seller]);

      // the buyer paid 500_000, 200_000 went to the seller, 300_000 comes back
      assert.equal(await balance(buyerToken), buyerBefore + 300_000);
    });

    it("lets the arbiter settle only what is left", async () => {
      const sellerBefore = await balance(sellerToken);
      const { escrow } = await create(22, 800_000, farFuture(), arbiter.publicKey);
      await releasePart(22, 300_000);
      assert.equal(await balance(sellerToken), sellerBefore + 300_000);

      await resolve(22, arbiter, true);

      assert.equal(await balance(sellerToken), sellerBefore + 800_000);
      assert.isNull(await provider.connection.getAccountInfo(escrow));
    });
  });
  describe("arbiter fee", () => {
    it("pays the arbiter a fee and the rest to the seller", async () => {
      const sellerBefore = await balance(sellerToken);
      const arbiterBefore = await balance(arbiterToken);
      const { escrow } = await create(30, 1_000_000, farFuture(), arbiter.publicKey, seller.publicKey, 500);
      const state = await program.account.escrow.fetch(escrow);
      assert.equal(state.arbiterFeeBps, 500);

      await resolve(30, arbiter, true);

      assert.equal(await balance(arbiterToken), arbiterBefore + 50_000);
      assert.equal(await balance(sellerToken), sellerBefore + 950_000);
      assert.isNull(await provider.connection.getAccountInfo(escrow));
    });

    it("takes the fee when the buyer is refunded too", async () => {
      const arbiterBefore = await balance(arbiterToken);
      const buyerBefore = await balance(buyerToken);
      await create(31, 1_000_000, farFuture(), arbiter.publicKey, seller.publicKey, 500);

      await resolve(31, arbiter, false);

      assert.equal(await balance(arbiterToken), arbiterBefore + 50_000);
      assert.equal(await balance(buyerToken), buyerBefore - 50_000);
    });

    it("charges the fee only on what is left after a partial release", async () => {
      const sellerBefore = await balance(sellerToken);
      const arbiterBefore = await balance(arbiterToken);
      await create(32, 800_000, farFuture(), arbiter.publicKey, seller.publicKey, 1000);
      await releasePart(32, 300_000);

      await resolve(32, arbiter, true);

      // 500_000 was left, so the fee is 50_000 and the seller gets 450_000 on top of the 300_000
      assert.equal(await balance(arbiterToken), arbiterBefore + 50_000);
      assert.equal(await balance(sellerToken), sellerBefore + 750_000);
    });

    it("pays no fee when the buyer releases or the seller cancels", async () => {
      const arbiterBefore = await balance(arbiterToken);
      await create(33, 400_000, farFuture(), arbiter.publicKey, seller.publicKey, 500);
      await fullRelease(33);
      await create(34, 400_000, farFuture(), arbiter.publicKey, seller.publicKey, 500);
      await refund(34, seller, [seller]);
      assert.equal(await balance(arbiterToken), arbiterBefore);
    });

    it("rejects a fee above 10%, or a fee with no arbiter", async () => {
      await expectFail(
        () => create(35, 1000, farFuture(), arbiter.publicKey, seller.publicKey, 1001),
        "InvalidFee"
      );
      await expectFail(
        () => create(36, 1000, farFuture(), NO_ARBITER, seller.publicKey, 100),
        "InvalidFee"
      );
    });
  });
});
