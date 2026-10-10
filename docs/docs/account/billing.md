---
title: 'Billing'
description: 'Free scan, prepaid balance, the card on file for live keys that can scan, card top-ups through Stripe, automatic top-up, refunds and the ledger.'
---

# Billing

Reading, searching and asking spaces are included. **Live scans** are paid from a **prepaid balance in US dollars**.

| | Price |
| --- | --- |
| Test keys | Free, within the [limits](../limits.md) |
| First live scan of a new account | Free, one free scan per card (see [Add a card](#add-a-card)) |
| Each live scan after that | **$1.00**, charged when the scan starts |
| Failed scans | Refunded automatically |
| Live scans, and live keys that can scan | Need a card on file: saved in the console without a charge, or a top-up already paid |

Spaces you scanned with the iPhone app are readable through the API, the console and MCP with the same account, at no cost. Billing stays separate: the app's credits and Space Context Pro are App Store purchases; API scans are always paid from the balance, never from app credits.

## Add a card

A **live key that can scan** (`scans:write`), whether you create it in the console, approve it for `spacecontext login` or allow scanning when you connect an assistant, needs a **card on file**. [Test keys](api-keys.md#test-and-live) and read-only live keys never do. Without a card, creating such a key answers `402 PAYMENT_METHOD_REQUIRED`.

In the console, open **Billing → Add a card** (a new account also finds it in the **Get started** checklist of the Overview). As for a top-up, you first accept the billing terms (below). A **Stripe Checkout** page saves the card and **charges nothing**; your bank may ask you to confirm it with **3-D Secure**. The card counts once Stripe confirms it, within a few seconds of coming back to the console.

- The card is stored by Stripe, never by us. It is the same saved card that automatic top-up uses, but saving it does not turn automatic top-up on.
- **One free scan per card.** The first live scan of a new account is free, but a card brings a free scan only once: if the first card the account saves or pays a top-up with was already used on another Space Context account (even one since deleted), the account gets no free scan. Nothing is charged either way, and `free_scans_remaining` in the wallet says whether the free scan is there.
- Scans are paid from the balance: the card is charged only by a top-up you make or an automatic top-up you turn on.
- A new card replaces the previous one. **Remove saved card** deletes it from Stripe; keys you already created keep working.

## Add funds

In the console, tick the billing terms (below), then **Billing → Add $10 / $25 / $50**. You are taken to a **Stripe Checkout** page. Pay by card, and you come back to the console. The balance updates within a few seconds, when Stripe confirms the payment.

![Billing in the console: the balance with Add $10, $25 and $50 buttons, the automatic top-up settings and the spend of the last 30 days](/docs/console/billing.jpg)

- Amounts from $10 to $500 per top-up (the API accepts any amount in that range).
- The balance never expires and is used only for API scans.
- Tick **Save the card for automatic top-ups** to allow automatic top-up later; that card is also the card on file that live keys that can scan need. The card is stored by Stripe, never by us. Saving another card later replaces it, and the previous one is removed from Stripe.

## What you accept when you add funds

Before the payment page opens, the console asks you to accept these terms; Stripe's page repeats them next to the pay button. Adding a card asks for the same acceptance, and nothing is charged on that page.

- **The credit is supplied at once.** It is added to your balance as soon as the payment succeeds, and the scans you start use it: you ask for it to be supplied now.
- **Credit already used cannot be refunded.** A scan that fails is refunded to your balance automatically (see below). Money goes back to a card only if you ask: write to support about unused credit. Statutory rights, where they apply, are not affected.
- **Unused credit never expires.**
- Payments ask your bank for **3-D Secure** when your card supports it, and show on your statement as **FINIKOS\* SPACECONTEXT**.
- The console records the time you accepted, the version of these terms and your IP address. That record, the ledger and your usage are what we show Stripe if a payment is disputed.

## Automatic top-up

With a saved card, the console can top up for you:

- **When the balance is below**: the threshold, in dollars.
- **Add**: the amount to charge, from $10 to $500.

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

Payments are processed by Stripe on behalf of Finikos S.r.l. (Italy). Every top-up comes with an **invoice**: at checkout you give your billing address and, for a business, your tax ID (VAT number). The console lists your invoices under **Billing → Invoices**, each with its page and PDF; the API returns them at `GET /v1/billing/invoices`.
