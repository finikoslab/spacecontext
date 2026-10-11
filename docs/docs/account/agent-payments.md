---
title: 'Agents that pay (x402)'
description: 'An agent with USDC on Base or Solana buys API credit and gets a live key in one HTTP call, with no account and no card: x402 v2, the network fee paid for it.'
---

# Agents that pay (x402)

An agent with a crypto wallet does not need a person to sign up, add a card or copy a key. It pays in **USDC on Base or on Solana** with [x402](https://x402.org), the HTTP payment protocol, and the same call returns **an API key and the credit**. The paying wallet is the account: no email, no password, no console.

| | |
| --- | --- |
| Endpoint | `POST https://api.spacecontext.app/v1/agent/credits` |
| Networks | Base (`eip155:8453`) and Solana (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), USDC |
| Amount | `amount_cents` from 100 (US$1) to 50 000 (US$500); without a body, US$1 |
| What it buys | Credit for live scans at **US$1.00 each**; reading, search and answers are included. The credit does not expire |
| Network fee | Paid by the facilitator: the wallet needs only USDC, no ETH or SOL |
| Key | A live key with every scope (`spaces:read`, `scans:read`, `scans:write`, `spaces:sensitive`) |

To try the API first without paying, use a [test key](api-keys.md#test-and-live): it is free and runs everything on the demo space.

## Pay with an x402 client

Any x402 v2 client works. With the official one for TypeScript, a call with no body buys **US$1, one scan**, and goes through as is: x402 clients refuse to pay more than US$1 at once unless you raise their limit (`spendControls`), as below to buy five scans.

```bash
npm install @x402/fetch @x402/evm viem          # Base
npm install @x402/fetch @x402/svm @solana/kit   # Solana
```

**Base**, with the wallet's private key (`0x…`):

```ts
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`)) }],
  spendControls: { maxAmountPerPayment: '$5' }, // the client's own cap: US$1 unless raised
});

const res = await pay('https://api.spacecontext.app/v1/agent/credits', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ amount_cents: 500 }),
});
const credit = await res.json();
// credit.api_key: store it now, it is shown only once.
```

**Solana**, with the wallet's secret key in base58 (what Phantom or Solflare export):

```ts
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactSvmScheme, toClientSvmSigner } from '@x402/svm';
import { createKeyPairSignerFromBytes, getBase58Encoder } from '@solana/kit';

const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(process.env.SOLANA_PRIVATE_KEY!));
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', client: new ExactSvmScheme(toClientSvmSigner(signer)) }],
  spendControls: { maxAmountPerPayment: '$5' },
});
// …then the same pay('https://api.spacecontext.app/v1/agent/credits', …) call as above.
```

The answer:

```json
{
  "object": "agent_credit",
  "network": "eip155:8453",
  "payer": "0x5e1f…c0de",
  "transaction": "0x8a3b…41f2",
  "livemode": true,
  "amount_cents": 500,
  "balance_cents": 500,
  "api_key": "sc_live_…",
  "api_key_prefix": "sc_live_ab12",
  "notice": "Store api_key now: it is shown only this once. …",
  "docs": "https://spacecontext.app/developers/docs/"
}
```

Then use the key like any other: `Authorization: Bearer sc_live_…` on the [API](../api/overview.md), `SPACECONTEXT_API_KEY` for the [CLI](../cli/install.md) and the [SDK](../sdk/typescript.md). Start with [Quickstart](../quickstart.md): create a space, upload a video, start the scan.

## What happens on the wire

1. `POST /v1/agent/credits` without payment answers **402** with a `PAYMENT-REQUIRED` header: base64 of a JSON whose `accepts` lists one option per network, Base first. Each names the amount in atomic USDC units (6 decimals: US$1.00 is `1000000`), the USDC contract or mint, the address to pay (`payTo`) and, on Solana, `extra.feePayer`, the facilitator account that pays the network fee. The same JSON is in the body as `error.payment_required`, so you can read it with `curl`:

   ```bash
   curl -s -X POST https://api.spacecontext.app/v1/agent/credits | jq .error.payment_required.accepts
   ```

2. The client picks one option and signs it: on Base an EIP-3009 `transferWithAuthorization`; on Solana a transaction that moves exactly that amount of USDC into the `payTo` wallet's USDC account, which the client signs and the facilitator co-signs as fee payer.
3. It sends **the same request with the same body** again, adding `PAYMENT-SIGNATURE`. The amount follows the body: a payment signed for US$5 does not buy US$10.
4. We check the payment against what we asked (network, asset, recipient, amount, signature) before anything is sent on; the facilitator verifies and settles it; the answer carries the key, the balance and a `PAYMENT-RESPONSE` header with the transaction.

The 402 also carries `extensions.bazaar`, which describes the call for x402 catalogs: agents that browse a catalog can find this endpoint without these docs.

## The account and its key

- **One wallet, one account.** Every payment from the same wallet tops up the same account. A Base wallet and a Solana wallet are two accounts. Agent accounts have no free scan.
- **The key is shown once**, in the answer of the payment that opens the account. Later payments from the wallet return only `api_key_prefix`: a signed payment can be submitted by whoever holds it, so a payment alone never hands out a key for an account that already exists.
- **Replace the key** by paying again with `{"rotate_key": true}` and `Authorization: Bearer <the current key>`: a new key comes back and the old one is revoked. Lost the key? Write to support with the paying address and one of its transactions.
- **The same payment twice** (a retry, a relay) is recognised by its transaction: nothing is credited or created twice.
- Failed scans are refunded to the balance, as for every account. Paying accepts the [Terms](https://spacecontext.app/terms/) (section 30 covers payments by agents).

## Errors

All answers use the usual [error format](../api/errors.md); `reason` says why a payment was refused. Nothing is charged in any of these cases, except where noted.

| Status | Code | When |
| --- | --- | --- |
| 400 | `PAYMENT_INVALID` | `PAYMENT-SIGNATURE` is malformed or does not match what was asked: another amount, network, asset or recipient, a Solana transaction for another fee payer, a signature that does not verify |
| 402 | `PAYMENT_REQUIRED` | No payment yet: the options are in `PAYMENT-REQUIRED` |
| 402 | `PAYMENT_FAILED` | The facilitator refused or could not settle it, e.g. not enough USDC in the wallet (`invalid_exact_evm_insufficient_balance` on Base, `invalid_exact_svm_transaction_simulation_failed` on Solana) |
| 403 | `AGENT_KEY_REQUIRED` | `rotate_key`, or a key for an account that has none, without one of the account's current keys |
| 429 | `RATE_LIMIT_EXCEEDED` | More than 5 requests a minute from one IP address |
| 500 | `INTERNAL_ERROR` | The payment settled but could not be recorded: it is reconciled by hand; keep `transaction` |
| 502 | `PAYMENT_FAILED` | The settlement could not be confirmed: it may have gone through; write to support with `nonce` (Base) or `signature` (Solana) |
| 503 | `PAYMENTS_UNAVAILABLE` | The chosen network cannot be served right now; try again later or pay on the other one |
