# ZedTickets — Setup & Go-Live Guide 🎟️🇿🇲

ZedTickets is an ORIZIS TECHNOLOGY product: a two-sided platform for **event ticketing** and **fundraising**, paid with Zambian Mobile Money. It ships working **out of the box in demo mode** (no accounts, data saved in the browser) and becomes a real product once you connect Firebase + the pawaPay backend below.

---

## ⚠️ Read first — honest notes (money handling & regulation)

These are the flags from the project brief. They are **business/legal** decisions, not code:

1. **Payouts to organizers are manual in the pilot.** All Mobile Money lands in **your** pawaPay account. You then pay each organizer their share **minus the platform fee**, by hand. True automatic split-payout needs a provider that supports it — not in the pilot.
2. **Holding third-party money (ticket revenue / donations that belong to others) can, at scale, touch money-services / money-transfer regulation** in Zambia. For the pilot: keep amounts small, keep **full transaction records** (the app logs every ticket and gift), stay transparent, and **get advice before scaling**.
3. **Church / charity donations:** full transparency, a receipt for every donor. The app records a receipt id on every gift.

The app is built to support this: every payment is verified server-side before a ticket/receipt is issued, and every transaction is logged.

---

## 1. Storefront (GitHub Pages) — already deployable

The site (`index.html`, `scan.html`) is static and runs immediately. In **demo mode** (default) it uses sample events/fundraisers and saves data in the browser's localStorage, with a simulated payment. Good for showing the product; not multi-device.

Deploy: `git push` to `main` → GitHub Pages serves it. (See README.)

---

## 2. Firebase (real accounts + shared data) — one-time console setup

Demo mode is per-device. For real organizers, tickets that scan across phones, and live fundraiser totals, connect Firebase:

1. Go to <https://console.firebase.google.com> → **Add project** (e.g. `zedtickets`).
   *(Note: this Google account is currently at its free project quota — delete an unused Firebase project first, or use a different account.)*
2. **Build → Authentication → Get started → Email/Password → Enable.** (Optional: enable Google sign-in later.)
3. **Build → Firestore Database → Create database** → Production mode → pick a location (e.g. `eur3` or nearest).
4. **Firestore → Rules** tab → paste the contents of [`firestore.rules`](firestore.rules) → **Publish**.
5. **Project settings (gear) → General → Your apps → Web (`</>`)** → register an app → copy the `firebaseConfig` object.
6. Paste that config into **`CONFIG.firebaseConfig`** in **both** `index.html` and `scan.html`.
7. Commit & push. The site now uses real accounts and shared data automatically.

> First organizer account: just use **Create an account** on the site's "Sell / Fundraise" screen.

---

## 3. Backend (pawaPay Mobile Money + signed tickets) — Vercel

The `backend/` folder is a small Express server. Without a pawaPay token it reports **simulated mode** and the site keeps simulating payments (fine for the pilot).

Deploy:
```bash
cd backend
npx vercel link --yes --project zedtickets-site
npx vercel --prod --yes
```
Then in **Vercel → Project → Settings → Environment Variables** set:

| Variable | Value | Notes |
|---|---|---|
| `PAWAPAY_TOKEN` | your pawaPay API token | leave unset = simulated mode |
| `PAWAPAY_ENV` | `production` | or `sandbox` while testing |
| `TICKET_SECRET` | a long random string | **required in production** — signs ticket QR tokens. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Redeploy after adding vars. Check `https://<project>.vercel.app/api/health` — it reports `paymentsConfigured` and `ticketSecretConfigured`.

Finally, set **`CONFIG.API_BASE_URL`** in `index.html` and `scan.html` to your Vercel URL, commit & push.

---

## 4. Before you scale (security hardening)

The pilot lets the public create ticket/contribution documents directly (they carry a server-signed token, and the scanner verifies that token — so forged tickets fail at the gate). For production integrity, move ticket & contribution **writes** into the backend using the Firebase Admin SDK, so the client cannot write them at all. The endpoints (`/api/issue-ticket`, `/api/record-contribution`) are already the right place to do it.

---

## Config quick-reference (top of `index.html`)

| Key | Meaning |
|---|---|
| `API_BASE_URL` | Vercel backend URL. `""` = demo/simulated payments |
| `PLATFORM_FEE_PERCENT` | Your revenue — fee per transaction (5–10%) |
| `WHATSAPP_SUPPORT` | Support/organizer help number (use a **business** number) |
| `firebaseConfig` | Firebase web config. Empty `apiKey` = local demo mode |

## Future (not now)
Multi-country: add ₦ Naira + Flutterwave for Nigeria + country detection. Keep Zambia pilot first. The payment layer is isolated in `backend/server.js` and the checkout in `index.html`, so a second provider slots in there.
