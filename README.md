# BLOCKCHAIN X WINS

[![CI](https://github.com/Faafo1/blockchain-x-wins/actions/workflows/ci.yml/badge.svg)](https://github.com/Faafo1/blockchain-x-wins/actions/workflows/ci.yml)

A Solana **escrow** built with [Anchor](https://www.anchor-lang.com/). A buyer locks SPL tokens (e.g. USDC) for a seller, and the funds are released only when the buyer confirms delivery. It solves the trust problem in online selling: the seller knows the money is locked, and the buyer knows it is not paid until the goods arrive.

## How it works

| Instruction | Who calls it | What happens |
|-------------|--------------|--------------|
| `create(escrow_id, amount, deadline, arbiter)` | Buyer | Locks `amount` tokens in a program-owned vault for the seller. `arbiter` is optional (the all-zero key means none) |
| `release` | Buyer | Confirms delivery: tokens go to the seller, escrow closes |
| `refund` | Seller (any time) or buyer (after `deadline`, only if there is no arbiter) | Tokens go back to the buyer, escrow closes |
| `resolve(pay_seller)` | Arbiter | Settles a dispute: pays the seller or refunds the buyer |

Safety rules built in:
- Zero amounts and deadlines in the past are rejected.
- Only the buyer can release funds.
- Without an arbiter, the buyer cannot pull funds back before the deadline, so the seller is protected. The seller can always cancel.
- With an arbiter, the buyer cannot reclaim by waiting out the deadline: only the buyer (release), the seller (cancel) or the arbiter (decide) can move the funds. The arbiter cannot be the buyer or the seller.
- Strangers cannot refund, release or resolve.
- The vault is controlled by the program (a PDA), not by any person.

**Trade-off:** if an arbiter is named and then disappears, and the buyer and seller never agree, the funds stay locked. Choose an arbiter both sides trust.

**Not included yet:** partial releases and arbiter fees.

A small web app for this program is in [`app/`](app/README.md).

## Project layout

```
programs/escrow/src/lib.rs   On-chain program (Rust)
tests/escrow.ts              TypeScript tests
Anchor.toml                  Anchor config (localnet + devnet)
.github/workflows/ci.yml     GitHub Actions
```

## Setup

Install: [Rust](https://rustup.rs), the [Solana CLI](https://solana.com/docs/intro/installation), [Anchor](https://www.anchor-lang.com/docs/installation) (this project targets 0.31.x), Node.js and Yarn.

```bash
yarn install
solana-keygen new          # creates your dev wallet; keep it OUT of git
anchor build
anchor keys sync           # puts your real program id in lib.rs and Anchor.toml
anchor build               # rebuild with the new id
anchor test                # runs tests on a local validator (takes about a minute)
```

## Deploy to Devnet

```bash
solana config set --url devnet
solana airdrop 2           # free test SOL
anchor deploy --provider.cluster devnet
```

Only move to mainnet after the program has been tested and professionally reviewed. Mainnet uses real money.

## Security notes

- Never commit keypair files or `.env` files (the `.gitignore` blocks common ones).
- The program id in `lib.rs` is a placeholder until you run `anchor keys sync`.
- This is a learning starter. Get a professional audit before holding real user funds.

## License

MIT
