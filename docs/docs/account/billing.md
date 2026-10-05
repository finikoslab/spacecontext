---
title: 'Billing'
description: 'Free scan, prepaid balance, card top-ups through Stripe, automatic top-up, refunds and the ledger.'
---

# Billing

Reading, searching and asking spaces are included. **Live scans** are paid from a **prepaid balance in US dollars**.

| | Price |
| --- | --- |
| Test keys | Free, unlimited |
| First live scan of an account | Free |
| Each live scan after that | **$1.00**, charged when the scan starts |
| Failed scans | Refunded automatically |

Spaces you scanned with the iPhone app are readable through the API and MCP with **Space Context Pro** (an app subscription). API scans are separate: they are always paid from the balance, never from app credits.

## Add funds

In the console, **Billing → Add $10 / $25 / $50**. You are taken to a **Stripe Checkout** page. Pay by card, and you come back to the console. The balance updates within a few seconds, when Stripe confirms the payment.

- Amounts from $5 to $500 per top-up (the API accepts any amount in that range).
- The balance never expires and is used only for API scans.
- Tick **Save the card for automatic top-ups** to allow automatic top-up later. The card is stored by Stripe, never by us. Saving another card later replaces it, and the previous one is removed from Stripe.

## Automatic top-up

With a saved card, the console can top up for you:

- **When the balance is below**: the threshold, in dollars.
- **Add**: the amount to charge, from $5 to $500.

A top-up is attempted right after a paid scan starts and leaves the balance below the threshold. It is also attempted when the balance cannot pay for the next scan, and when a scan is refused for insufficient funds; in that last case the next attempt to start can succeed. Two attempts are at least 10 minutes apart, with at most 3 per day.

If the bank declines the card, automatic top-up turns itself off, the console shows the reason, and the `wallet.auto_recharge_failed` [webhook](../api/webhooks.md) is sent. Fix the card with a manual top-up and turn it back on. **Remove saved card** turns automatic top-up off and deletes the card from Stripe's customer record.

## When scans are charged and refunded

1. `POST /v1/scans/{id}/start` charges the scan in a single atomic step: the free scan first, then the balance. If neither covers it, the start answers `402 INSUFFICIENT_FUNDS` with `balance_cents` and `price_cents`, and nothing is charged.
2. A scan that fails (unreadable video, nothing recognisable, processing error, or more than 2 hours of processing) is refunded once, automatically, and its files are deleted.
3. A scan cancelled before it starts was never charged.

## The ledger

**Billing → Activity** lists every movement with the balance after it: top-ups, scans, refunds, free scans, card refunds and disputes. The balance is always the sum of the ledger, and it is checked every night.

If you ask your bank or Stripe for a refund of a top-up, the refunded amount is taken from the balance; if a payment is disputed, it is taken while the dispute is open. The balance can then go below zero until you add funds.

## Taxes and invoices

Payments are processed by Stripe on behalf of Finikos S.r.l. (Italy). For invoices, write to [support](https://spacecontext.finikos.it/support) with the email of your account.
