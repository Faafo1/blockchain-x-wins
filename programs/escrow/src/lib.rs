use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

// Placeholder id. Run `anchor keys sync` after your first `anchor build`
// to replace it with the id of your own program keypair.
declare_id!("BKcdxCfd1bLfwWJJRLyKvyyq4oBQt6WkMibTGYYJR63B");

/// The most an arbiter can charge: 1000 basis points = 10%.
pub const MAX_ARBITER_FEE_BPS: u16 = 1000;

#[program]
pub mod escrow {
    use super::*;

    /// The buyer locks `amount` tokens for `seller`.
    ///
    /// - `deadline` (unix seconds): after this the buyer can take the tokens back,
    ///   but only when there is no arbiter.
    /// - `arbiter`: an optional neutral third party who can decide a dispute.
    ///   Pass `Pubkey::default()` (the all-zero key) for no arbiter.
    /// - `arbiter_fee_bps`: what the arbiter earns for settling a dispute, in basis
    ///   points of what is left (100 = 1%). At most 1000 (10%), and 0 without an arbiter.
    pub fn create(
        ctx: Context<Create>,
        escrow_id: u64,
        amount: u64,
        deadline: i64,
        arbiter: Pubkey,
        arbiter_fee_bps: u16,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        require!(
            deadline > Clock::get()?.unix_timestamp,
            EscrowError::DeadlineInPast
        );
        if arbiter != Pubkey::default() {
            require!(
                arbiter != ctx.accounts.buyer.key() && arbiter != ctx.accounts.seller.key(),
                EscrowError::InvalidArbiter
            );
        }
        require!(
            arbiter_fee_bps <= MAX_ARBITER_FEE_BPS
                && (arbiter_fee_bps == 0 || arbiter != Pubkey::default()),
            EscrowError::InvalidFee
        );

        let escrow = &mut ctx.accounts.escrow;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = ctx.accounts.seller.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.escrow_id = escrow_id;
        escrow.amount = amount;
        escrow.deadline = deadline;
        escrow.bump = ctx.bumps.escrow;
        escrow.arbiter = arbiter;
        escrow.total_amount = amount;
        escrow.arbiter_fee_bps = arbiter_fee_bps;

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount)
    }

    /// The buyer confirms delivery: everything still in the vault goes to the seller
    /// and the escrow is closed.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        pay_out_and_close_vault(
            &ctx.accounts.escrow,
            &ctx.accounts.vault,
            &ctx.accounts.seller_token,
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.token_program,
            ctx.accounts.escrow.amount,
        )
    }

    /// The buyer pays the seller part of what is left (for example a milestone).
    /// The escrow stays open with the rest. To pay everything, use `release`.
    pub fn release_part(ctx: Context<ReleasePart>, amount: u64) -> Result<()> {
        let remaining = ctx.accounts.escrow.amount;
        require!(
            amount > 0 && amount < remaining,
            EscrowError::InvalidPartialAmount
        );

        transfer_from_vault(
            &ctx.accounts.escrow,
            &ctx.accounts.vault,
            &ctx.accounts.seller_token,
            &ctx.accounts.token_program,
            amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.amount = remaining
            .checked_sub(amount)
            .ok_or(EscrowError::InvalidPartialAmount)?;
        Ok(())
    }

    /// Tokens go back to the buyer and the escrow is closed.
    /// - The seller can refund at any time (e.g. cannot deliver).
    /// - The buyer can refund only after the deadline, and only if there is no arbiter.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let caller = ctx.accounts.caller.key();
        let now = Clock::get()?.unix_timestamp;

        if caller == escrow.seller {
            // seller may always cancel
        } else if caller == escrow.buyer {
            require!(
                escrow.arbiter == Pubkey::default(),
                EscrowError::ArbiterDecides
            );
            require!(now >= escrow.deadline, EscrowError::TooEarly);
        } else {
            return err!(EscrowError::NotAllowed);
        }

        pay_out_and_close_vault(
            &ctx.accounts.escrow,
            &ctx.accounts.vault,
            &ctx.accounts.buyer_token,
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.token_program,
            ctx.accounts.escrow.amount,
        )
    }

    /// The arbiter settles a dispute: pay the seller (`pay_seller = true`)
    /// or refund the buyer (`pay_seller = false`). Only works if an arbiter was set.
    /// The arbiter's fee (if any) is taken from what is left in the vault, and the
    /// rest goes to the winner.
    pub fn resolve(ctx: Context<Resolve>, pay_seller: bool) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.arbiter != Pubkey::default() && escrow.arbiter == ctx.accounts.arbiter.key(),
            EscrowError::NotArbiter
        );

        let destination = if pay_seller {
            &ctx.accounts.seller_token
        } else {
            &ctx.accounts.buyer_token
        };

        let remaining = escrow.amount;
        let fee = (u128::from(remaining) * u128::from(escrow.arbiter_fee_bps) / 10_000) as u64;
        if fee > 0 {
            transfer_from_vault(
                &ctx.accounts.escrow,
                &ctx.accounts.vault,
                &ctx.accounts.arbiter_token,
                &ctx.accounts.token_program,
                fee,
            )?;
        }

        pay_out_and_close_vault(
            &ctx.accounts.escrow,
            &ctx.accounts.vault,
            destination,
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.token_program,
            remaining - fee,
        )
    }
}

/// Moves `amount` tokens out of the vault to `destination`. The escrow account
/// (a PDA) signs for the vault.
fn transfer_from_vault<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let buyer_key = escrow.buyer;
    let id_bytes = escrow.escrow_id.to_le_bytes();
    let bump = [escrow.bump];
    let seeds: &[&[u8]] = &[b"escrow", buyer_key.as_ref(), &id_bytes, &bump];
    let signer_seeds = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: destination.to_account_info(),
                authority: escrow.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )
}

/// Sends `amount` (everything still in the vault, minus any arbiter fee) to `destination`, then closes
/// the vault token account and returns its rent to the buyer. The escrow account itself
/// is closed by Anchor.
fn pay_out_and_close_vault<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    rent_receiver: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    transfer_from_vault(escrow, vault, destination, token_program, amount)?;

    let buyer_key = escrow.buyer;
    let id_bytes = escrow.escrow_id.to_le_bytes();
    let bump = [escrow.bump];
    let seeds: &[&[u8]] = &[b"escrow", buyer_key.as_ref(), &id_bytes, &bump];
    let signer_seeds = &[seeds];

    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_receiver.clone(),
            authority: escrow.to_account_info(),
        },
        signer_seeds,
    ))
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct Create<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The seller's wallet address (receives the tokens on release).
    pub seller: SystemAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = buyer,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", buyer.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        payer = buyer,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = buyer
    )]
    pub buyer_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        close = buyer,
        has_one = buyer,
        seeds = [b"escrow", escrow.buyer.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = escrow.mint,
        token::authority = escrow.seller
    )]
    pub seller_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReleasePart<'info> {
    pub buyer: Signer<'info>,

    #[account(
        mut,
        has_one = buyer,
        seeds = [b"escrow", escrow.buyer.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = escrow.mint,
        token::authority = escrow.seller
    )]
    pub seller_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    /// Either the seller (any time) or the buyer (after the deadline, no arbiter).
    pub caller: Signer<'info>,

    #[account(
        mut,
        close = buyer,
        seeds = [b"escrow", escrow.buyer.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,

    /// Receives the rent back. Must be the original buyer.
    #[account(mut, address = escrow.buyer)]
    pub buyer: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = escrow.mint,
        token::authority = escrow.buyer
    )]
    pub buyer_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    /// The arbiter named when the escrow was created.
    pub arbiter: Signer<'info>,

    #[account(
        mut,
        close = buyer,
        seeds = [b"escrow", escrow.buyer.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,

    /// Receives the rent back. Must be the original buyer.
    #[account(mut, address = escrow.buyer)]
    pub buyer: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = escrow.mint,
        token::authority = escrow.seller
    )]
    pub seller_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = escrow.mint,
        token::authority = escrow.buyer
    )]
    pub buyer_token: Account<'info, TokenAccount>,

    /// Where the arbiter's fee goes: the arbiter's own token account for this mint.
    #[account(
        mut,
        token::mint = escrow.mint,
        token::authority = arbiter
    )]
    pub arbiter_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub escrow_id: u64,
    /// Tokens still in the vault. Goes down as the buyer makes partial releases.
    pub amount: u64,
    pub deadline: i64,
    pub bump: u8,
    /// All-zero key means "no arbiter".
    pub arbiter: Pubkey,
    /// What was originally locked (never changes). New fields go at the end so the
    /// positions of the earlier fields stay the same.
    pub total_amount: u64,
    /// The arbiter's fee in basis points (100 = 1%), paid when the arbiter resolves.
    pub arbiter_fee_bps: u16,
}

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deadline must be in the future")]
    DeadlineInPast,
    #[msg("Only the seller, or the buyer after the deadline, can refund")]
    NotAllowed,
    #[msg("The deadline has not passed yet")]
    TooEarly,
    #[msg("Only the arbiter named for this escrow can resolve it")]
    NotArbiter,
    #[msg("The arbiter cannot be the buyer or the seller")]
    InvalidArbiter,
    #[msg("This escrow has an arbiter, who must decide")]
    ArbiterDecides,
    #[msg("A partial release must be more than zero and less than what is left. To pay everything, use release")]
    InvalidPartialAmount,
    #[msg("The arbiter fee can be at most 10%, and only when there is an arbiter")]
    InvalidFee,
}
