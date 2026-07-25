const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

/* =====================================================================
   ZedTickets backend — Mobile Money (pawaPay) + server-signed tickets.

   Environment variables (Vercel -> Project Settings -> Environment Variables):
     PAWAPAY_TOKEN  - optional. pawaPay API token. When absent, the payment
                      endpoints report simulated mode and the site keeps using
                      its built-in simulation (good for the pilot / demo).
     PAWAPAY_ENV    - optional. 'sandbox' (default) or 'production'.
     TICKET_SECRET  - STRONGLY recommended in production. Secret used to sign
                      ticket QR tokens (HMAC). A forged ticket that was not
                      issued by this server cannot produce a valid token, so
                      the scanner rejects it. If unset a random per-instance
                      secret is used (tokens stop validating after a redeploy —
                      fine for demo, NOT for production).
   No RapidAPI key is needed (ZedTickets sells tickets, not products).
   ===================================================================== */
const PAWAPAY_TOKEN = process.env.PAWAPAY_TOKEN;
const PAWAPAY_BASE = process.env.PAWAPAY_ENV === 'production'
    ? 'https://api.pawapay.io'
    : 'https://api.sandbox.pawapay.io';
const TICKET_SECRET = process.env.TICKET_SECRET || crypto.randomBytes(32).toString('hex');
const SECRET_IS_EPHEMERAL = !process.env.TICKET_SECRET;

/* =====================================================================
   VERIPOINTS (shared ORIZIS wallet / loyalty) — OPTIONAL server hooks.
   These stay dormant unless the central VeriPoints project is wired via
   env vars. When unset, the endpoints return { configured:false } and the
   site simply keeps working Mobile-Money-only. The client treats any
   non-success as "fall back to MoMo", so nothing ever breaks.

     VERIPOINTS_FUNCTIONS_ORIGIN - base URL of the central Cloud Functions,
                                   e.g. https://<region>-<central>.cloudfunctions.net
     VERIPOINTS_SERVER_KEY       - secret server key for this site (matches the
                                   central functions/.env for VERIPOINTS_SITE_ID)
     VERIPOINTS_SITE_ID          - this site's id in VeriPoints (default 'zedtickets')
     VERIPOINTS_PLATFORM_UID     - the ORIZIS/ZedTickets wallet uid that receives
                                   captured points (revenue recipient)
   ===================================================================== */
const VP_ORIGIN = process.env.VERIPOINTS_FUNCTIONS_ORIGIN;
const VP_KEY = process.env.VERIPOINTS_SERVER_KEY;
const VP_SITE = process.env.VERIPOINTS_SITE_ID || 'zedtickets';
const VP_PLATFORM_UID = process.env.VERIPOINTS_PLATFORM_UID;
const vpConfigured = Boolean(VP_ORIGIN && VP_KEY);

// Invoke a central VeriPoints callable function server-to-server. Callable
// functions accept a { data: {...} } envelope and return { result: {...} }.
async function vpCall(fnName, data) {
    const r = await axios.post(`${VP_ORIGIN.replace(/\/$/, '')}/${fnName}`, { data }, {
        headers: { 'Content-Type': 'application/json' }, timeout: 20000
    });
    return r.data && (r.data.result !== undefined ? r.data.result : r.data);
}

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'zedtickets-backend',
        paymentsConfigured: Boolean(PAWAPAY_TOKEN),
        paymentsEnv: process.env.PAWAPAY_ENV === 'production' ? 'production' : 'sandbox',
        ticketSecretConfigured: !SECRET_IS_EPHEMERAL,
        veripointsConfigured: vpConfigured
    });
});

// Capture points the buyer already put on hold (client-side VeriPoints.hold),
// moving them to the platform wallet. Server-authorized via the secret key.
app.post('/api/veripoints/capture', async (req, res) => {
    if (!vpConfigured || !VP_PLATFORM_UID) return res.json({ configured: false });
    const { holdId, amount } = req.body || {};
    if (!holdId || !(amount > 0)) return res.status(400).json({ error: 'INVALID_INPUT' });
    try {
        await vpCall('walletCapture', {
            holdId, siteId: VP_SITE, serverKey: VP_KEY,
            splits: [{ toUid: VP_PLATFORM_UID, amount: Math.round(amount), role: 'platform' }]
        });
        // Issue the signed ticket/receipt id here — it is gated behind a real,
        // server-verified points capture, exactly like a verified MoMo payment.
        const id = randomUUID();
        res.json({ captured: true, id, token: signTicket(id) });
    } catch (e) {
        res.status(502).json({ error: 'VP_CAPTURE_FAILED', message: e.message, response: e.response ? e.response.data : null });
    }
});

// Release a hold the buyer no longer wants to spend (e.g. they cancelled).
app.post('/api/veripoints/release', async (req, res) => {
    if (!vpConfigured) return res.json({ configured: false });
    const { holdId, reason } = req.body || {};
    if (!holdId) return res.status(400).json({ error: 'INVALID_INPUT' });
    try {
        await vpCall('walletRelease', { holdId, siteId: VP_SITE, serverKey: VP_KEY, reason: reason || 'cancelled' });
        res.json({ released: true });
    } catch (e) {
        res.status(502).json({ error: 'VP_RELEASE_FAILED', message: e.message });
    }
});

// Loyalty earn: credit the buyer points after any successful purchase. Uses a
// central credit function if the project exposes one (walletCredit). If not
// available it degrades to { credited:false } — earning is a bonus, never a
// blocker. Loyalty points are low-risk; real-money top-up stays in the central
// store under proper licensing (see SETUP.md), never minted here.
app.post('/api/veripoints/earn', async (req, res) => {
    if (!vpConfigured) return res.json({ configured: false, credited: false });
    const { uid, amount, reference } = req.body || {};
    if (!uid || !(amount > 0)) return res.status(400).json({ error: 'INVALID_INPUT' });
    try {
        await vpCall('walletCredit', {
            uid, amount: Math.round(amount), siteId: VP_SITE, serverKey: VP_KEY,
            reason: 'loyalty', reference: reference || null
        });
        res.json({ credited: true, amount: Math.round(amount) });
    } catch (e) {
        // No credit function yet / not licensed — non-fatal.
        res.json({ credited: false, reason: e.response && e.response.data ? 'unavailable' : e.message });
    }
});

/* =====================================================================
   SERVER-SIGNED TICKET TOKENS
   A ticket's QR carries "<ticketId>.<token>". The token is an HMAC of the
   ticketId with TICKET_SECRET. Only this server can produce a valid token,
   and only after a payment was verified (see /api/issue-ticket). The scanner
   calls /api/verify-ticket, which recomputes the HMAC — a forged QR fails.
   ===================================================================== */
function signTicket(ticketId) {
    return crypto.createHmac('sha256', TICKET_SECRET)
        .update(String(ticketId))
        .digest('base64url')
        .slice(0, 24);
}

function tokenValid(ticketId, token) {
    if (!ticketId || !token) return false;
    const expected = signTicket(ticketId);
    const a = Buffer.from(String(token));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* =====================================================================
   MOBILE MONEY PAYMENTS (pawaPay — Zambia)
   ===================================================================== */
const { randomUUID } = crypto;

const PAWAPAY_PROVIDERS = {
    mtn: 'MTN_MOMO_ZMB',
    airtel: 'AIRTEL_OAPI_ZMB',
    zamtel: 'ZAMTEL_ZMB'
};

const pawapayHeaders = () => ({
    Authorization: `Bearer ${PAWAPAY_TOKEN}`,
    'Content-Type': 'application/json'
});

// Starts a mobile money deposit. The customer then approves a PIN prompt on
// their phone; the site polls /api/pay/status until it resolves.
app.post('/api/pay', async (req, res) => {
    if (!PAWAPAY_TOKEN) return res.json({ simulated: true });

    const { phone, network, amount, message } = req.body || {};
    const provider = PAWAPAY_PROVIDERS[String(network || '').toLowerCase()];
    if (!/^(9|7)\d{8}$/.test(String(phone)) || !(amount > 0) || !provider) {
        return res.status(400).json({ error: 'INVALID_INPUT' });
    }

    const depositId = randomUUID();
    try {
        const r = await axios.post(`${PAWAPAY_BASE}/v2/deposits`, {
            depositId,
            amount: String(Math.round(amount * 100) / 100),
            currency: 'ZMW',
            payer: {
                type: 'MMO',
                accountDetails: { phoneNumber: '260' + phone, provider }
            },
            customerMessage: String(message || 'ZedTickets').slice(0, 22)
        }, { headers: pawapayHeaders(), timeout: 25000 });

        res.json({ tx_ref: depositId, status: r.data && r.data.status });
    } catch (error) {
        res.status(502).json({
            error: 'PAYMENT_ERROR',
            message: error.message,
            response: error.response ? error.response.data : null
        });
    }
});

// Maps pawaPay deposit statuses onto simple states: successful/failed/pending.
async function fetchDepositStatus(txRef) {
    const r = await axios.get(`${PAWAPAY_BASE}/v2/deposits/${encodeURIComponent(txRef)}`, {
        headers: pawapayHeaders(),
        timeout: 20000
    });
    const d = r.data && (r.data.data || (Array.isArray(r.data) ? r.data[0] : r.data));
    const s = String((d && d.status) || 'pending').toUpperCase();
    return s === 'COMPLETED' ? 'successful'
        : (s === 'FAILED' || s === 'REJECTED' || s === 'CANCELLED') ? 'failed'
        : 'pending';
}

app.get('/api/pay/status', async (req, res) => {
    if (!PAWAPAY_TOKEN) return res.json({ simulated: true, status: 'successful' });
    try {
        res.json({ status: await fetchDepositStatus(req.query.tx_ref || '') });
    } catch (error) {
        // Status often 404s for a moment right after initiation — treat as pending
        res.json({ status: 'pending' });
    }
});

// pawaPay callback (webhook). pawaPay requires a callback URL to be configured
// before it will issue an API token. The site confirms payments by polling
// /api/pay/status, so this endpoint just needs to accept the notification and
// acknowledge it with 200. One URL works for all operation types
// (checkouts / deposits / payouts / refunds).
app.post('/api/pay/callback', (req, res) => {
    // (Optional future hardening: verify pawaPay's signature and reconcile
    //  the transaction here. For now we acknowledge; the client polls status.)
    console.log('pawaPay callback:', JSON.stringify(req.body || {}).slice(0, 500));
    res.status(200).json({ received: true });
});
// Some setups probe the callback URL with GET — answer 200 so validation passes.
app.get('/api/pay/callback', (req, res) => res.status(200).json({ ok: true }));

/* =====================================================================
   ISSUE TICKET — only after a verified payment.
   The site calls this once payment is confirmed. The server re-checks the
   deposit status server-side (so the client cannot fake a "paid" state) and
   only then returns a signed token the site stores on the Firestore ticket.
   In simulated mode (no PAWAPAY_TOKEN) it issues directly — pilot behaviour.
   ===================================================================== */
app.post('/api/issue-ticket', async (req, res) => {
    const { tx_ref } = req.body || {};

    if (PAWAPAY_TOKEN) {
        if (!tx_ref) return res.status(400).json({ error: 'MISSING_TX_REF' });
        try {
            const status = await fetchDepositStatus(tx_ref);
            if (status !== 'successful') {
                return res.status(402).json({ error: 'PAYMENT_NOT_CONFIRMED', status });
            }
        } catch (e) {
            return res.status(502).json({ error: 'STATUS_CHECK_FAILED', message: e.message });
        }
    }

    const ticketId = randomUUID();
    res.json({ ticketId, token: signTicket(ticketId) });
});

/* =====================================================================
   RECORD CONTRIBUTION — same idea for donations: verify payment first,
   return an ok + a receipt id the site attaches to the contribution.
   ===================================================================== */
app.post('/api/record-contribution', async (req, res) => {
    const { tx_ref } = req.body || {};

    if (PAWAPAY_TOKEN) {
        if (!tx_ref) return res.status(400).json({ error: 'MISSING_TX_REF' });
        try {
            const status = await fetchDepositStatus(tx_ref);
            if (status !== 'successful') {
                return res.status(402).json({ error: 'PAYMENT_NOT_CONFIRMED', status });
            }
        } catch (e) {
            return res.status(502).json({ error: 'STATUS_CHECK_FAILED', message: e.message });
        }
    }

    const receiptId = randomUUID();
    res.json({ receiptId, token: signTicket(receiptId) });
});

/* =====================================================================
   VERIFY TICKET — the scanner calls this. Returns whether the token is a
   genuine server-issued signature for this ticketId. Marking the ticket as
   "used" (and preventing double entry) is done in Firestore by the event's
   authenticated organizer — see firestore.rules.
   ===================================================================== */
app.post('/api/verify-ticket', (req, res) => {
    const { ticketId, token } = req.body || {};
    res.json({ valid: tokenValid(ticketId, token) });
});

module.exports = app;
