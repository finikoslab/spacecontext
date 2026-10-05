---
title: 'Console and sign-in'
description: 'Sign in to the developer console with a one-time code sent to your email.'
---

# Console and sign-in

The [console](https://spacecontext.finikos.it/developers/console) is where you manage everything that is not a call with an API key: [API keys](api-keys.md), [billing](billing.md) and [webhooks](../api/webhooks.md).

## Sign in

1. Open the console and enter your email.
2. We email you a **one-time code**. It is valid for 10 minutes.
3. Enter the code. You are signed in for this browser tab.

There is no password. The account is the same as the Space Context iPhone app when you signed in to the app with the same email: your app spaces, and your Space Context Pro subscription, are the same.

:::note Signed in to the app with Apple's "Hide My Email"?
Then your app account uses a private relay address, and signing in to the console with your real email creates a different account. Contact [support](https://spacecontext.finikos.it/support) to link them.
:::

## Sessions

- A console session lasts up to 30 days and lives only in the browser tab (it is not stored in cookies or on disk). Closing the tab ends it.
- **Sign out** revokes the session on the server.
- A console session cannot be used as an API key, and an API key cannot open the console: keys cannot create other keys, see billing or change webhooks.

## Limits on codes

To protect your account, codes are rate-limited per address and per network. If you request many codes in a short time you are asked to wait a few minutes. A wrong code can be retried a few times before a new one is needed.

## What the console shows

| Section | What you can do |
| --- | --- |
| **API keys** | Create test and live keys with scopes and a monthly spending cap; revoke them. Keys created by the MCP connector appear with an **MCP** badge. |
| **Billing** | See the balance and the free scans left, add funds by card, set up automatic top-up, see every movement. |
| **Webhooks** | Add HTTPS endpoints, choose events, send a test event, see deliveries, turn endpoints off or delete them. |
