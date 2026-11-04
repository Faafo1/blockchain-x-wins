import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import idl from "../idl/escrow.json";
import { PROGRAM_ID } from "../config";

export type EscrowAccount = {
  buyer: PublicKey;
  seller: PublicKey;
  mint: PublicKey;
  escrowId: BN;
  amount: BN;
  deadline: BN;
  bump: number;
  /** The all-zero key means "no arbiter". */
  arbiter: PublicKey;
};

export const hasArbiter = (a: EscrowAccount): boolean => !a.arbiter.equals(PublicKey.default);

// Position of the `arbiter` field in the account data:
// 8-byte discriminator + buyer, seller, mint (32 each) + escrow_id, amount, deadline (8 each) + bump (1).
const ARBITER_OFFSET = 8 + 32 * 3 + 8 * 3 + 1;

export type EscrowRecord = { publicKey: PublicKey; account: EscrowAccount };

export function getProgram(connection: Connection, wallet: AnchorWallet): Program<Idl> {
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program(idl as unknown as Idl, provider);
}

export function escrowPda(buyer: PublicKey, escrowId: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), buyer.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  )[0];
}

export function vaultPda(escrow: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], PROGRAM_ID)[0];
}

function newEscrowId(): BN {
  // Unique enough per buyer, and safely below 2^53.
  return new BN(Date.now() * 1000 + Math.floor(Math.random() * 1000));
}

// The generic Program type does not know our account names, so we reach them loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const escrowAccounts = (program: Program<Idl>) => (program.account as any).escrow;

export async function createEscrow(
  program: Program<Idl>,
  buyer: PublicKey,
  args: { seller: PublicKey; mint: PublicKey; amount: BN; deadline: BN; arbiter?: PublicKey }
): Promise<string> {
  const buyerToken = getAssociatedTokenAddressSync(args.mint, buyer);
  const info = await program.provider.connection.getAccountInfo(buyerToken);
  if (!info) throw new Error("You have no tokens of this mint in your wallet yet.");

  const id = newEscrowId();
  const escrow = escrowPda(buyer, id);
  const vault = vaultPda(escrow);

  return program.methods
    .create(id, args.amount, args.deadline, args.arbiter ?? PublicKey.default)
    .accounts({
      buyer,
      seller: args.seller,
      mint: args.mint,
      escrow,
      vault,
      buyerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function releaseEscrow(
  program: Program<Idl>,
  buyer: PublicKey,
  record: EscrowRecord
): Promise<string> {
  const { seller, mint } = record.account;
  const sellerToken = getAssociatedTokenAddressSync(mint, seller);
  return program.methods
    .release()
    .accounts({
      buyer,
      escrow: record.publicKey,
      vault: vaultPda(record.publicKey),
      sellerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([createAssociatedTokenAccountIdempotentInstruction(buyer, sellerToken, seller, mint)])
    .rpc();
}

export async function refundEscrow(
  program: Program<Idl>,
  caller: PublicKey,
  record: EscrowRecord
): Promise<string> {
  const { buyer, mint } = record.account;
  const buyerToken = getAssociatedTokenAddressSync(mint, buyer);
  return program.methods
    .refund()
    .accounts({
      caller,
      escrow: record.publicKey,
      buyer,
      vault: vaultPda(record.publicKey),
      buyerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([createAssociatedTokenAccountIdempotentInstruction(caller, buyerToken, buyer, mint)])
    .rpc();
}

/** The arbiter settles a dispute: pay the seller or refund the buyer. */
export async function resolveEscrow(
  program: Program<Idl>,
  arbiter: PublicKey,
  record: EscrowRecord,
  paySeller: boolean
): Promise<string> {
  const { buyer, seller, mint } = record.account;
  const sellerToken = getAssociatedTokenAddressSync(mint, seller);
  const buyerToken = getAssociatedTokenAddressSync(mint, buyer);
  return program.methods
    .resolve(paySeller)
    .accounts({
      arbiter,
      escrow: record.publicKey,
      buyer,
      vault: vaultPda(record.publicKey),
      sellerToken,
      buyerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(arbiter, sellerToken, seller, mint),
      createAssociatedTokenAccountIdempotentInstruction(arbiter, buyerToken, buyer, mint),
    ])
    .rpc();
}

/** All open escrows where this wallet is the buyer, the seller or the arbiter. */
export async function fetchMyEscrows(program: Program<Idl>, me: PublicKey): Promise<EscrowRecord[]> {
  const accounts = escrowAccounts(program);
  const [asBuyer, asSeller, asArbiter] = (await Promise.all([
    accounts.all([{ memcmp: { offset: 8, bytes: me.toBase58() } }]),
    accounts.all([{ memcmp: { offset: 8 + 32, bytes: me.toBase58() } }]),
    accounts.all([{ memcmp: { offset: ARBITER_OFFSET, bytes: me.toBase58() } }]),
  ])) as [EscrowRecord[], EscrowRecord[], EscrowRecord[]];

  const seen = new Map<string, EscrowRecord>();
  for (const r of [...asBuyer, ...asSeller, ...asArbiter]) seen.set(r.publicKey.toBase58(), r);
  return [...seen.values()].sort((a, b) => b.account.escrowId.cmp(a.account.escrowId));
}
