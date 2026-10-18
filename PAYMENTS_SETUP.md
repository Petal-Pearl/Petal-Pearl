# Petal & Pearl payments setup

## Implemented
- Supabase table `public.payment_orders` stores order lines, server-computed total, Monobank invoice ID/status and Telegram notification status.
- Edge Function `create-monobank-invoice` validates item IDs/quantities and computes prices from `public.products`; creates a Monobank hosted invoice.
- Edge Function `monobank-webhook` verifies Monobank's ECDSA `X-Sign` signature, matches invoice and amount/currency, updates status, and sends Telegram only on a confirmed `success`.
- Storefront no longer treats Google Pay UI success or a browser confirmation as proof of payment. It redirects to Monobank's hosted payment page. Google Pay availability depends on merchant acquiring configuration.

## Required secrets (Supabase Dashboard -> Edge Functions -> Secrets)
Set these server-side only:
- `MONOBANK_TOKEN`: live internet-acquiring token from the merchant cabinet.
- `TELEGRAM_BOT_TOKEN`: token from BotFather after creating the bot.
- `TELEGRAM_CHAT_ID`: numeric Telegram chat ID to receive order alerts.

Do not commit these values or put them in `index.html`.

## Telegram bot one-time setup
1. In Telegram, open the verified `@BotFather` account and send `/newbot`.
2. Choose a display name (for example Petal & Pearl Orders) and a unique username ending in `bot`.
3. Copy the token directly into Supabase Edge Function secrets as `TELEGRAM_BOT_TOKEN`; do not send it in chat or commit it to GitHub.
4. Open the newly created bot and press Start. To notify a group, add the bot to that group and grant permission to post.
5. Obtain the destination chat ID securely and set `TELEGRAM_CHAT_ID`.

## Monobank setup
1. Obtain the live acquiring token from the Monobank merchant cabinet. Do not use the public test token for real payments.
2. Confirm internet acquiring is active and Google Pay is enabled/available for the merchant account.
3. Set `MONOBANK_TOKEN` as a Supabase Edge Function secret.
4. The webhook URL is `https://hdlkpmsnsrmwftmjnusl.supabase.co/functions/v1/monobank-webhook`.
5. Test with a small live payment only after the merchant account and secrets are configured. Never mark an order paid manually in the browser.

## Function URLs
- Create invoice: `https://hdlkpmsnsrmwftmjnusl.supabase.co/functions/v1/create-monobank-invoice`
- Payment webhook: `https://hdlkpmsnsrmwftmjnusl.supabase.co/functions/v1/monobank-webhook`

The Edge Functions are deployed but will return a configuration error until required secrets are set. This is intentional and safer than simulating payment success.
