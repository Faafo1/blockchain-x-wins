# Escrow web app

A small React app for the escrow program: connect a Solana wallet, lock tokens for a seller, then release or refund them.

Works against a **local test network** (free, no faucet needed) or **Devnet**.

## Run it locally

You need the repo's Anchor project built once, and Node 22.

**Terminal 1** (repo root): start a local network with the program loaded.
```bash
anchor localnet
```
Leave it running.

**Terminal 2:** start the app.
```bash
cd app
npm install
npm run sync-idl      # copies your real program id from the last `anchor build`
npm run dev
```
Open http://localhost:5173.

**Wallet setup (Phantom):** Settings, Developer Settings, turn on Testnet Mode, and choose **Solana Localnet**. Create two accounts in Phantom so you can play both buyer and seller.

## Try a full deal

1. Connect account 1 (the buyer). Press **Get 2 test SOL**, then **Create a test token**.
2. Paste account 2's address as the seller. Enter an amount and press **Lock tokens**.
3. Press **Release to seller**, or wait for the deadline and try **Refund me**.
4. Switch Phantom to account 2 to see it from the seller's side (the seller can cancel and refund any time).

## Use Devnet instead

Copy `.env.example` to `.env` and set `VITE_CLUSTER=devnet`. Deploy the program to Devnet first, run `npm run sync-idl`, and switch your wallet to Devnet.

## Notes

- Demo software, not audited. Do not use real funds.
- `npm run sync-idl` must be re-run whenever you rebuild the program with a new id.
