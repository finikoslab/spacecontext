---
title: 'Console and sign-in'
description: 'The developer console: sign in with Apple, Google or an emailed code, see what your spaces hold, scan from the browser, connect assistants, manage keys, billing, webhooks and the audit log.'
---

# Console and sign-in

The [console](https://spacecontext.app/developers/console) is where you see and manage everything without writing code: your spaces, new scans, the assistants you connected, [API keys](api-keys.md), [billing](billing.md), [webhooks](../api/webhooks.md) and the audit log.

![The console overview: spaces, documented items, scans and questions this month, the balance, and 30-day charts of scans, API requests, questions and spend](/docs/console/overview.jpg)

## Sign in

Choose **Continue with Apple**, **Continue with Google**, or enter your email and the one-time code we send you (valid for 10 minutes).

It is the **same account as the Space Context iPhone app**, whichever way you signed up there: the console finds it by the email of your Apple or Google account. If you used Apple's *Hide My Email* in the app, sign in here with Apple too: you reach the same account.

## Approve a sign-in from the terminal

`spacecontext login` shows a code and sends you to **Approve a sign-in** in the console. Type the code, read what is asking (the name a terminal gives is what it said about itself), choose what the key may do and its mode, and approve: the terminal receives a key of its own, listed under **API keys** as `CLI · …`, revocable at any time. Approve only a code you are looking at in your own terminal; a code never travels in a link.

## What the console shows

| Section | What you can do |
| --- | --- |
| **Overview** | Spaces, documented items, scans and questions this month, balance; 30-day charts of scans, API requests, questions and spend; usage per key; the latest scans, updated live. A short checklist gets a new account started. |
| **Spaces** | Every space you can read, and a search across all of them. Open one for its summary, issues, key locations, how-tos and facts, the inventory by area with the **original photos**, questions answered with sources, the scan history with **before/after comparisons**, and exports (Agent Skill, JSON). |
| **New scan** | Drop a walkthrough video or photos, see the price (the first live scan is free), follow the analysis step by step, and land on the result. |
| **Connect AI** | The MCP server URL and the steps for Claude, Claude Code, ChatGPT and Cursor, with the assistants already connected. |
| **API keys** | Create test and live keys with scopes and a monthly spending cap; revoke them. Keys created by the MCP connector carry an **MCP** badge; keys approved for a terminal are named `CLI · …`. |
| **Billing** | Balance, top-ups by card through Stripe, automatic top-up, spend chart, every movement, and invoices. |
| **Webhooks** | HTTPS endpoints, events, test deliveries, delivery history. |
| **Security** | The audit log: sign-ins, keys, webhooks, payments and deletions, with who did them, kept 400 days. |

![API keys in the console: create a key with a mode, scopes and a monthly cap; your keys with their mode, scopes, last use and a Revoke button](/docs/console/keys.jpg)

The **Live / Test** switch at the top changes what the spaces, scans and overview show: **Test** is the demo space and free, instant scans that return demo content; **Live** is your real spaces. Nothing in Test mode is ever charged.

## Sessions

- A console session lasts up to 30 days and lives only in the browser tab (not in cookies, not on disk). Closing the tab ends it.
- **Sign out** revokes the session on the server, and is recorded in the audit log.
- In the console you act as the owner of the account, with every permission. A console session cannot be used on the app's API, and an API key cannot open the console: keys cannot create keys, see billing or change webhooks.

## Limits on codes

To protect your account, emailed codes are rate-limited per address and per network. If you request many codes in a short time you are asked to wait a few minutes. A wrong code can be retried a few times before a new one is needed.
