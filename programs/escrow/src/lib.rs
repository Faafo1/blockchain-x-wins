use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

// Placeholder id. Run `anchor keys sync` after your first `anchor build`
// to replace it with the id of your own program keypair.
declare_id!("BKcdxCfd1bLfwWJJRLyKvyyq4oBQt6WkMibTGYYJR63B");

#[program]
pub mod escrow {
    use super::*;

    /// The buyer locks `amount` tokens for `seller`. If the buyer never releases them,
    /// the buyer can take them back after `deadline` (unix timestamp, seconds).
    pub fn create(ctx: Context<Create>, escrow_id: u64, amount: u64, deadline: i64) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        require!(
            deadline > Clock::get()?.unix_timestamp,
            EscrowError::DeadlineInPast
        );

        let escrow = &mut ctx.accounts.escrow;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = ctx.accounts.seller.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.escrow_id = escrow_id;
        escrow.amount = amount;
        escrow.deadline = deadline;
        escrow.bump = ctx.bumps.escrow;

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

    /// The buyer confirms delivery: tokens go to the seller and the escrow is closed.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        pay_out_and_close_vault(
            &ctx.accounts.escrow,
            &ctx.accounts.vault,
            &ctx.accounts.seller_token,
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.token_program,
        )
    }

    /// Tokens go back to the buyer and the escrow is closed.
    /// - The seller can refund at any time (e.g. cannot deliver).
    /// - The buyer can refund only after the deadline has passed.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let caller = ctx.accounts.caller.key();
        let now = Clock::get()?.unix_timestamp;

        if caller == escrow.seller {
            // seller may always cancel
        } else if caller == escrow.buyer {
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
        )
    }
}

/// Sends the escrowed tokens to `destination`, then closes the vault token account
/// and returns its rent to the buyer. The escrow account itself is closed by Anchor.
fn pay_out_and_close_vault<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    rent_receiver: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
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
        escrow.amount,
    )?;

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
pub struct Refund<'info> {
    /// Either the seller (any time) or the buyer (after the deadline).
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

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub escrow_id: u64,
    pub amount: u64,
    pub deadline: i64,
    pub bump: u8,
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
}
