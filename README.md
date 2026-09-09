# Hamro Pay sample store

A small Node.js T-shirt shop that shows how to create a Hamro Pay checkout session, redirect a customer, verify payment, and receive signed webhooks. It also includes optional **Payments for Platforms** commission configuration.

**Try it without an account.** Demo mode runs locally, simulates payment outcomes, and moves no money. The T-shirt is sample merchandise; no physical orders are created.

![The Everyday Tee](public/assets/everyday-tee.png)

## Run in two minutes

You need **Node.js 22.13 or newer** with npm. [Install Node.js](https://nodejs.org/en/download) first, then check `node --version`. The shell installer works on macOS and Linux, or Windows through WSL. It also needs curl and tar.

```sh
curl -fsSL https://raw.githubusercontent.com/hamropatro/sample-store/main/install.sh | sh
cd sample-store
npm start
```

Open **http://localhost:3000**. Choose a size, add a shirt to your bag, and check out. Pick **successful**, **failed**, or **pending** on the demo payment page.

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
| Create a session | `src/hamropay.mjs` | Signs the request with HMAC-SHA512 and sends it from the server. |
| Open checkout | `src/app.mjs` | Sends only the allowed checkout fields in a form to the gateway. |
| Confirm payment | `src/app.mjs` | Checks the transaction ID, amount, and `COMPLETED` status. |
| Receive a webhook | `src/hamropay.mjs` | Checks the signature with a constant-time comparison. |
| Share commission | `src/config.mjs` | Adds the platform merchant and percentage to `clientCommissionConfig`. |

Your browser keeps only the cart and a session cookie. Orders and checkout tokens are stored locally in `.data/`, which is excluded from Git. Paid orders remain paid if a callback repeats or an older status arrives. Repeating the same checkout request reuses its order instead of creating another session.

## Connect the Hamro Pay sandbox

The local demo is ready to run. **The sandbox adapter requires connection details from Hamro Pay and has not been tested against a live sandbox account.** The public integration reference does not specify complete backend endpoint URLs or their HTTP methods, so this sample deliberately asks you to configure them.

1. Create a test merchant in the [UAT merchant portal](https://uat-merchant.hamropatro.com/) and complete its business verification.
2. Ask Hamro Pay for your test credentials, full Create Session URL, Get Transaction URL and method, and hosted checkout gateway URL. This sample supports **POST** for Create Session; confirm that it matches your account's API contract.
3. Stop the store. Edit the `.env` created by setup:

```dotenv
PAYMENT_MODE=sandbox
HOST=127.0.0.1
PORT=3000
APP_URL=http://localhost:3000

HAMRO_MERCHANT_ID=your-test-selling-merchant-id
HAMRO_CLIENT_ID=your-test-client-id
HAMRO_API_KEY=your-test-api-key
HAMRO_CLIENT_SECRET=your-test-client-secret
HAMRO_USER_SECRET=your-test-user-secret

HAMRO_CREATE_SESSION_URL=full-https-endpoint-from-hamro-pay
HAMRO_CREATE_SESSION_METHOD=POST
HAMRO_GET_TRANSACTION_URL=full-https-endpoint-from-hamro-pay
HAMRO_GET_TRANSACTION_METHOD=confirmed-GET-or-POST
HAMRO_GATEWAY_URL=full-https-checkout-url-from-hamro-pay
```

4. Start with `npm start`, open **APP_URL**, and make a new order. Follow **Continue to Hamro Pay** to open the sandbox gateway. Get test payment details from Hamro Pay.

The gateway returns to `/payment/return` with `MerchantTxnId`. The server calls Get Transaction before showing an order as paid. A visit to the success URL, or an edited query parameter, cannot confirm payment. If verification is temporarily unavailable, use **Check payment again**.

If sandbox redirects require a public HTTPS address, use your preferred development tunnel to port 3000, set `APP_URL` to its HTTPS origin, and restart. Always open the shop at that exact origin. The same browser must keep its session cookie. Changing `APP_URL` does not create a tunnel for you.

### Add webhooks

1. Expose the store through a public HTTPS development tunnel and set `APP_URL` to that origin.
2. Ask Hamro Pay to register **`https://your-tunnel.example/api/webhooks/hamropay`** for your test merchant.
3. Set `HAMRO_WEBHOOK_SECRET` to the webhook signing secret supplied by Hamro Pay, then restart.

The endpoint is disabled without that secret. It expects JSON with `merchantTxnId`, `merchantId`, numeric `amount`, and `status`, plus a `Signature` header. It signs the comma-separated fields in this order:

```text
merchantTxnId,merchantId,status,amount
```

The algorithm is HMAC-SHA512 encoded as Base64. The server also checks that the merchant, transaction ID, and amount match before updating the order. Valid events return HTTP 200; duplicate completion events leave the paid timestamp unchanged. Confirm webhook configuration, delivery retries, and amount formatting with Hamro Pay. This sample's whole-rupee prices avoid decimal formatting differences.

### Payments for Platforms

A platform can receive commission while its seller receives the remaining amount. Add both values to `.env`:

```dotenv
HAMRO_PLATFORM_MERCHANT_ID=your-test-platform-merchant-id
HAMRO_COMMISSION_PERCENTAGE=3
```

Keep `HAMRO_MERCHANT_ID` set to the **selling merchant**. The adapter adds:

```json
{
  "clientCommissionConfig": {
    "commissionMerchantId": "your-test-platform-merchant-id",
    "commissionPercentage": 3
  }
}
```

For a NPR 1,200 order, a 3% commission is NPR 36 for the platform and NPR 1,164 for the seller, before any applicable processing fees or adjustments. Hamro Pay allocates the shares; this sample does not transfer funds itself. Ask Hamro Pay to enable and confirm the commission arrangement for your test merchants. Leave both settings empty for ordinary merchant checkout.

[Read the Payments for Platforms guide](https://hamro-pay-developers.shankaruprety.chatgpt.site/docs/platforms).

## Test and change the sample

```sh
npm test
npm run check
```

The tests cover demo checkout, server pricing, ownership and CSRF checks, duplicate requests, signed API requests, invalid payment results, webhooks, and persistence. Sandbox HTTP calls are mocked; these tests never charge money.

- Change products and prices in `src/catalog.mjs`.
- Edit the storefront in `public/index.html`, `public/style.css`, and `public/store.js`.
- Edit return-page behavior in `public/payment.js`.
- Follow the payment routes in `src/app.mjs` and provider adapter in `src/hamropay.mjs`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `node` or `npm` not found | Install Node.js, then open a new terminal. |
| Port 3000 is busy | Set `PORT=3001` and `APP_URL=http://localhost:3001` in `.env`; restart. |
| “Open the store at its configured APP_URL” | Use the exact APP_URL, including hostname and port. `localhost` and `127.0.0.1` are different origins. |
| Order not found | Return in the same browser with its session cookie. Orders belong to that browser. |
| Sandbox configuration error | Fill every required `.env` value with the confirmed test connection details. Restart after changes. |
| Session request timed out | The API may have created a session. Check the merchant portal before creating another test checkout; the sample does not automatically retry session creation. |
| Want a fresh demo | Stop the server, delete the local `.data` directory, and restart. This deletes all local sample orders. |

## Scope

This is a learning sample for a single developer process. It has no real inventory, customer accounts, shipping, taxes, refunds, or fulfillment. Its JSON order store is not suitable for multiple processes or production payment accounting. There is no live-payment mode.

Before building a real shop, use a durable transactional database, implement inventory and fulfillment idempotency, add reconciliation and operational monitoring, and validate the full flow with Hamro Pay. Keep `.env` and `.data/` private; never commit them.

[Developer guide](https://hamro-pay-developers.shankaruprety.chatgpt.site/docs/sample-store) · [API reference](https://hamro-pay-developers.shankaruprety.chatgpt.site/docs/reference) · [Original integration reference](https://hamropay.com.np/developers/)

The product photograph is an AI-generated sample asset created using built-in image generation. Its [generation prompt](docs/tshirt-image-prompt.txt) is included for reproducibility.
