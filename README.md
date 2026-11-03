# BLOCKCHAIN X WINS

A Solana **escrow** built with [Anchor](https://www.anchor-lang.com/). A buyer locks SPL tokens (e.g. USDC) for a seller, and the funds are released only when the buyer confirms delivery. It solves the trust problem in online selling: the seller knows the money is locked, and the buyer knows it is not paid until the goods arrive.

## How it works

| Instruction | Who calls it | What happens |
|-------------|--------------|--------------|
| `create(escrow_id, amount, deadline)` | Buyer | Locks `amount` tokens in a program-owned vault for the seller |
| `release` | Buyer | Confirms delivery: tokens go to the seller, escrow closes |
| `refund` | Seller (any time) or buyer (after `deadline`) | Tokens go back to the buyer, escrow closes |

Safety rules built in:
- Zero amounts and deadlines in the past are rejected.
- Only the buyer can release funds.
- The buyer cannot pull funds back before the deadline, so the seller is protected. The seller can always cancel.
- Strangers cannot refund or release.
- The vault is controlled by the program (a PDA), not by any person.

**Not included yet:** a dispute arbiter (a third party who decides when buyer and seller disagree), partial releases, and a website. These are good next steps.

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
