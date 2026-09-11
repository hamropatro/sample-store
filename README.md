# Hamro Pay sample store

A small Node.js T-shirt shop that shows how to create a Hamro Pay checkout session, redirect a customer, verify payment, and receive signed webhooks. It also includes optional **Payments for Platforms** commission configuration.

**Try it without an account.** Demo mode runs the *complete* checkout flow against a gateway built into the sample: a signed Create Session call, a real form POST, a hosted payment page, a real redirect back with `MerchantTxnId`, server-side Get Transaction verification, and a signed webhook. Nothing is stubbed out except the counterparty, so the code you read is the code you would ship. No money moves, and the T-shirt is sample merchandise.

![The Everyday Tee](public/assets/everyday-tee.png)

## Run in two minutes

You need **Node.js 22.13 or newer** with npm. [Install Node.js](https://nodejs.org/en/download) first, then check `node --version`. The shell installer works on macOS and Linux, or Windows through WSL. It also needs curl and tar.

```sh
curl -fsSL https://raw.githubusercontent.com/hamropatro/sample-store/main/install.sh | sh
cd sample-store
npm start
```

Open **http://localhost:3000**. Choose a size, add a shirt to your bag, and check out. You will be taken to a payment page and redirected back, exactly as in production. Use these test credentials:

| Enter | Outcome |
| --- | --- |
| Number `9841414141`, T-PIN `0000`, OTP `000000` | Payment completes |
| T-PIN `1111` | Payment is declined |
| Number `9800000000` | Stays processing, then settles a few seconds later |
| **Cancel payment** | Returns to the failure URL |

The same numbers are what Hamro Pay documents for its real UAT sandbox, so the muscle memory carries over.

There are **no third-party runtime packages**, no database to install, and no build step. The installer downloads release `v1.0.0`, creates a local `.env`, and leaves your existing directories untouched. It does not install Node, run sudo, change your shell, or start the server automatically.

To inspect the installer or choose a directory:

```sh
curl -fsSL https://raw.githubusercontent.com/hamropatro/sample-store/main/install.sh -o install-hamropay.sh
less install-hamropay.sh
sh install-hamropay.sh --dir my-tshirt-store
cd my-tshirt-store
npm start
```

### Prefer Git?

This also works in Windows PowerShell with Node.js and Git installed:

```sh
git clone https://github.com/hamropatro/sample-store.git
cd sample-store
npm run setup
npm start
```

Use `npm run dev` to restart the server when you edit its source. Stop it with **Ctrl+C**.

## What you can learn

| Step | Code | What happens |
| --- | --- | --- |
| Price an order | `src/catalog.mjs` | Reads trusted prices on the server; ignores browser-supplied amounts. |
| Create a session | `src/hamropay.mjs` | Converts the total to paisa and signs the request with HMAC-SHA512, server side. |
| Open checkout | `src/app.mjs` | Generates the gateway token and posts only the allowed form fields. |
| Confirm payment | `src/app.mjs` | Checks the transaction ID, amount, and `COMPLETED` status. |
| Receive a webhook | `src/hamropay.mjs` | Checks the signature with a constant-time comparison. |
| Share commission | `src/config.mjs` | Adds the platform merchant and its share to `clientCommissionConfig`. |
| Stand in for the gateway | `src/mock-gateway.mjs` | Demo only. Implements the same protocol and rejects bad signatures, so demo and sandbox run one code path. |

### Which mode redirects where

| | `PAYMENT_MODE=demo` | `PAYMENT_MODE=sandbox` |
| --- | --- | --- |
| Needs credentials | No | Yes, four values |
| Create Session goes to | Built-in gateway | `uat-payclient.hamropatro.com` |
| Browser is redirected to | `/__hamropay/api/checkout` | **`uat-checkout-pay.hamropatro.com/api/checkout`** |
| Code that runs | Identical | Identical |

The hosted page will only open for a `session_id` that Hamro Pay issued, and issuing one requires your client ID, API key, and secret. That is why the sample ships a local gateway: so the repository runs before you have an account. It is not an alternative to the real thing, it is a stand-in for the counterparty.

### Demo mode is not a shortcut

`PAYMENT_MODE=demo` swaps the counterparty, nothing else. The store still signs a real Create Session request, still generates the gateway token itself, still redirects the browser through a form POST, and still refuses to mark an order paid until Get Transaction says `COMPLETED`. The built-in gateway verifies every signature and rejects a tampered token, an expired session, or a replayed one. Switching to sandbox changes four environment values and no code.

Demo credentials are derived from the per-install secret in `.data/`, so they are stable on your machine and never committed. The gateway lives under `/__hamropay/` and exists only when `PAYMENT_MODE=demo`.

Your browser keeps only the cart and a session cookie. Orders and checkout tokens are stored locally in `.data/`, which is excluded from Git. Paid orders remain paid if a callback repeats or an older status arrives. Repeating the same checkout request reuses its order instead of creating another session.

## Connect the Hamro Pay sandbox

1. Create a test merchant in the [UAT merchant portal](https://uat-merchant.hamropatro.com/) and complete its business verification. The registration OTP is `000000`.
2. Copy **Client ID**, **Client Secret**, **Client API Key**, and **Merchant ID** from the portal's Client Credentials page.
3. Stop the store and edit the `.env` created by setup:

```dotenv
PAYMENT_MODE=sandbox
HOST=127.0.0.1
PORT=3000
APP_URL=http://localhost:3000

HAMRO_MERCHANT_ID=your-test-selling-merchant-id
HAMRO_CLIENT_ID=your-test-client-id
HAMRO_API_KEY=your-test-api-key
HAMRO_CLIENT_SECRET=your-test-client-secret
```

That is everything required. Endpoint paths are fixed by the API, so the sample only needs base URLs and already defaults to UAT:

| Setting | Default | Used for |
| --- | --- | --- |
| `HAMRO_API_BASE_URL` | `https://uat-payclient.hamropatro.com/` | `v1/checkout/sessionId`, `v1/checkout/transaction` |
| `HAMRO_GATEWAY_BASE_URL` | `https://uat-checkout-pay.hamropatro.com/` | `api/checkout` |

Override both when Hamro Pay confirms your production base URLs.

4. Check the credentials before opening the store:

```sh
npm run preflight
```

This creates one NPR 10 UAT session and prints the exact form your browser will POST. It moves no money and opens no page. A `sessionId` means your credentials, signature, and endpoints are all correct.

5. Start with `npm start`, open **APP_URL**, and place an order. **Continue to Hamro Pay** now posts the form to `https://uat-checkout-pay.hamropatro.com/api/checkout` and your browser lands on the real hosted checkout page. Pay with the test Hamro Pay number `9841414141`, T-PIN `0000`, OTP `000000`.

Two things to know when pointing at the real gateway from a laptop:

- **`APP_URL` must be reachable by Hamro Pay** for the redirect back to work in all cases, and for `productList` images to render on their page. A `http://localhost:3000` value is fine for a first look, but use an HTTPS development tunnel for a realistic run.
- **UAT resets connections under bursts.** Rapid repeated calls get the TCP connection closed rather than an HTTP error. The adapter reports this as *"Could not reach Hamro Pay ... UND_ERR_SOCKET"*; wait a moment and retry rather than assuming your credentials are wrong.

### How the three calls fit together

| # | Call | Where it runs | What this sample sends |
| --- | --- | --- | --- |
| 1 | `POST {API_BASE_URL}v1/checkout/sessionId` | Server | Order priced from `src/catalog.mjs`, amount **in paisa**, both redirect URLs, `productList`, and `metadata`. Signed over `merchantTxnId,transactionAmount,merchantId,client_id,clientApiKey`. |
| 2 | `POST {GATEWAY_URL}api/checkout` | Browser form | `merchant_id`, `session_id`, `token`, `merchant_transaction_id`, `remarks`. |
| 3 | `POST {API_BASE_URL}v1/checkout/transaction` | Server | `merchantId` and `merchantTxnId`, signed over `merchantTxnId,merchantId,client_id,clientApiKey`. |

Two details are easy to get wrong, and both are handled in `src/hamropay.mjs`:

- **Amounts change units by direction.** Create Session takes `transactionAmount` in **paisa** (Rs.10 = `1000`), and it must be between Rs.10 and Rs.50,000. Get Transaction and the webhook return `amount` in **rupees**. `productList[].price` is in rupees too, because it is only for display.
- **The gateway `token` is generated by your server, not returned by Create Session.** The session response contains only `sessionId` and `merchantId`. The token is a second signature, over different fields in a different order: `merchant_id,merchant_transaction_id,session_id,transaction_amount,client_id,client_api_key`.

Sessions expire about 10 minutes after creation, and `merchantTxnId` must be 25 characters or fewer.

### Returning from the gateway

Hamro Pay redirects to `APP_URL/payment/success` or `APP_URL/payment/failure`, appending `?MerchantTxnId=...` (capital M and T). Both pages are informational only: the server calls Get Transaction and marks the order paid only when the status is `COMPLETED` **and** the returned `merchantTransactionId` and rupee amount match the saved order. Landing on the success URL, or editing the query string, cannot confirm payment. Unfinished transactions correctly report `amount: 0`, which is treated as "not paid yet" rather than a mismatch. If verification is briefly unavailable, use **Check payment status again**.

If sandbox redirects require a public HTTPS address, run a development tunnel to port 3000, set `APP_URL` to its HTTPS origin, and restart. Always open the shop at that exact origin, in the browser holding the session cookie. Changing `APP_URL` does not create a tunnel for you.

### Add webhooks

1. Expose the store through a public HTTPS development tunnel and set `APP_URL` to that origin.
2. In the merchant portal's Webhook Config page, register **`https://your-tunnel.example/api/webhooks/hamropay`** and save. Saving generates the `merchantWebHookSigningSecret`.
3. Set `HAMRO_WEBHOOK_SECRET` to that value and restart.

The endpoint is disabled without the secret. It expects JSON with `merchantTxnId`, `merchantId`, numeric `amount` (rupees), and `status`, plus a `Signature` header covering:

```text
merchantTxnId,merchantId,status,amount
```

The algorithm is HMAC-SHA512 encoded as Base64. Because the sender serializes `amount` as a double, the same value may arrive as `1200`, `1200.0`, or `1200.00`; the verifier signs the literal text from the raw request body and falls back to those renderings, comparing each in constant time. It then checks that the merchant, transaction ID, and amount match the saved order. Valid events return HTTP 200, and duplicate completions leave the paid timestamp unchanged.

Webhooks matter because a customer may close the checkout tab before the return redirect fires. Keep both paths: return-page verification and webhooks.

### Payments for Platforms

A platform can take commission while the seller receives the rest. Set the platform merchant plus **exactly one** of the two amounts:

```dotenv
HAMRO_PLATFORM_MERCHANT_ID=your-test-platform-merchant-id
HAMRO_COMMISSION_PERCENTAGE=3
# or, instead of a percentage, a flat amount in rupees:
# HAMRO_COMMISSION_AMOUNT=25
```

Keep `HAMRO_MERCHANT_ID` set to the **selling merchant**. The adapter adds this to the Create Session request:

```json
{
  "clientCommissionConfig": {
    "commissionMerchantId": "your-test-platform-merchant-id",
    "commissionPercentage": 3
  }
}
```

For a NPR 1,200 order, 3% is NPR 36 for the platform and NPR 1,164 for the seller, before processing fees or adjustments. Hamro Pay allocates the shares; this sample transfers nothing itself. Ask Hamro Pay to enable the arrangement for your test merchants. Leave all three settings empty for ordinary merchant checkout.

## Test and change the sample

```sh
npm test        # full demo journey, signatures, webhooks, persistence
npm run check   # syntax check every source file
npm run preflight  # sandbox only: prove real credentials work
```

The tests walk the full demo journey (checkout → gateway form → payment → redirect → verification → webhook), plus server pricing, ownership and CSRF checks, duplicate requests, signature construction, declined and still-settling payments, tampered tokens, session replay, webhook verification, and persistence. Sandbox HTTP calls are mocked; these tests never charge money.

- Change products and prices in `src/catalog.mjs`.
- Edit the storefront in `public/index.html`, `public/style.css`, and `public/store.js`.
- Edit return-page behavior in `public/payment.js`.
- Adjust demo payment outcomes and test credentials in `src/mock-gateway.mjs`.
- Follow the payment routes in `src/app.mjs` and provider adapter in `src/hamropay.mjs`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `node` or `npm` not found | Install Node.js, then open a new terminal. |
| Port 3000 is busy | Set `PORT=3001` and `APP_URL=http://localhost:3001` in `.env`; restart. |
| “Open the store at its configured APP_URL” | Use the exact APP_URL, including hostname and port. `localhost` and `127.0.0.1` are different origins. |
| Order not found | Return in the same browser with its session cookie. Orders belong to that browser. |
| Sandbox configuration error | Fill all four credential values in `.env`, then restart. Base URLs default to UAT. |
| Amount rejected by the gateway | Hamro Pay accepts NPR 10 to NPR 50,000 per transaction. |
| Session request timed out | The API may have created a session. Check the merchant portal before creating another test checkout; the sample does not automatically retry session creation. |
| Want a fresh demo | Stop the server, delete the local `.data` directory, and restart. This deletes all local sample orders and regenerates the demo credentials. |
| Payment page says the checkout could not be verified | The form was altered in transit, or the session expired after 10 minutes. Start a new checkout. |

## Scope

This is a learning sample for a single developer process. It has no real inventory, customer accounts, shipping, taxes, refunds, or fulfillment. Its JSON order store is not suitable for multiple processes or production payment accounting. There is no live-payment mode.

Before building a real shop, use a durable transactional database, implement inventory and fulfillment idempotency, add reconciliation and operational monitoring, and validate the full flow with Hamro Pay. Keep `.env` and `.data/` private; never commit them.

[Checkout quickstart](https://hamropay.com.np/checkout/developer/quickstart/) · [API reference](https://hamropay.com.np/checkout/developer/reference/) · [Hamro Pay checkout](https://hamropay.com.np/checkout/)

The product photograph is an AI-generated sample asset created using built-in image generation. Its [generation prompt](docs/tshirt-image-prompt.txt) is included for reproducibility.
