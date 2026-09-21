# FitForge membership version

This version adds:
- Email/password account creation and login
- $1.99/month Stripe subscription link
- Server-side subscription status
- Protected `/workouts` route
- Stripe webhook handling for subscription activation/cancellation

## Important setup

This is a Node/Express site, not a static-only site.

1. Upload this folder to a Node-compatible host.
2. Run `npm install`.
3. Set the environment variables from `.env.example`.
4. In Stripe, add a webhook endpoint:
   `https://YOUR-DOMAIN.com/stripe/webhook`
5. Subscribe to at least:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
6. Put the Stripe webhook signing secret into `STRIPE_WEBHOOK_SECRET`.
7. Put your Stripe secret API key into `STRIPE_SECRET_KEY` as a server environment variable. Never put it in HTML or JavaScript sent to customers.
8. Make sure your Stripe Payment Link collects the customer's email. Customers should use the same email for their FitForge account and Stripe checkout.

## Flow

Create account -> Subscribe for $1.99 -> Stripe checkout -> Stripe webhook marks account active -> Log in -> Workout Library.

For cancellation, Stripe's subscription webhook changes the user's status and `/workouts` stops serving the protected page.

The included code uses the customer's Stripe checkout email to connect the subscription to the FitForge account. If you want a stronger account-to-Stripe connection later, switch from a Payment Link to a server-created Stripe Checkout Session with the logged-in user ID as metadata.
