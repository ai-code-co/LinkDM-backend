# LinkDM Backend (PayPal Subscriptions)

## 1) Install and run

```bash
npm install
npm run dev
```

Server starts on `http://localhost:4000` by default.

## 2) Configure environment

Copy `.env.example` to `.env` and set values.

Required:
- PayPal API credentials
- Four PayPal subscription plan ids
- Supabase URL and keys

## 3) Endpoints

- `GET /health`
- `POST /payments/paypal/subscriptions/create`
- `POST /payments/paypal/webhook`

### Create subscription request

Headers:
- `Authorization: Bearer <supabase-access-token>`

Body:

```json
{
  "tier": "pro",
  "billing": "monthly"
}
```

Response:

```json
{
  "subscriptionId": "I-XXXX",
  "approveUrl": "https://www.sandbox.paypal.com/..."
}
```

## 4) Webhook setup notes

Configure webhook URL in PayPal dashboard:

`https://<your-domain>/payments/paypal/webhook`

Subscribe to:
- `BILLING.SUBSCRIPTION.CREATED`
- `BILLING.SUBSCRIPTION.ACTIVATED`
- `BILLING.SUBSCRIPTION.CANCELLED`
- `BILLING.SUBSCRIPTION.SUSPENDED`
