# ZedTickets 🎟️🇿🇲

**Event tickets & fundraising for Zambia, paid with Mobile Money.** An ORIZIS TECHNOLOGY product.

Organizers sell tickets to concerts, church events, weddings, sports and conferences — or open a fundraiser for a cause. Supporters pay in Kwacha with MTN MoMo, Airtel Money or Zamtel Kwacha. Each ticket is a **QR code** scanned once at the gate.

## What's here
| File | Purpose |
|---|---|
| `index.html` | The whole storefront: browse events & fundraisers, buy tickets, donate, Mobile Money checkout, digital QR ticket, and the **organizer dashboard** (create events/fundraisers, live sales). |
| `scan.html` | **Gate scanner** — camera QR check-in. Verifies each ticket and prevents double entry. |
| `backend/` | Express API on Vercel: pawaPay Mobile Money + server-signed ticket tokens. |
| `firestore.rules` | Firestore security rules (public listings; owner-only management; open-but-signed ticket/gift creation). |
| `manifest.json`, `sw.js` | PWA — installable to the home screen, cache name `zedtickets-v1`. |
| `SETUP.md` | **Start here** — go-live steps + honest notes on money handling. |

## Runs in two modes
- **Demo (default):** empty `firebaseConfig` + empty `API_BASE_URL`. Sample data, browser-local storage, simulated payment. Live immediately on GitHub Pages.
- **Live:** connect Firebase (real accounts, shared data, cross-device QR) and the pawaPay backend (real Mobile Money). See [`SETUP.md`](SETUP.md).

## Business model
A platform fee (`PLATFORM_FEE_PERCENT`, default 7%) is charged per transaction and shown at checkout. In the pilot, organizer payouts are **manual** (money lands in your pawaPay account; you pay organizers their share minus the fee). See the honest notes in `SETUP.md`.

## Deploy
- **Site:** `git push` to `main` → GitHub Pages.
- **Backend:** `cd backend && npx vercel --prod --yes`.

Built on the ZedGlow design shell (ORIZIS intro, Mobile Money checkout, PWA), rebuilt for ticketing + fundraising.
