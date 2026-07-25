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

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'zedtickets-backend',
        paymentsConfigured: Boolean(PAWAPAY_TOKEN),
        paymentsEnv: process.env.PAWAPAY_ENV === 'production' ? 'production' : 'sandbox',
        ticketSecretConfigured: !SECRET_IS_EPHEMERAL
    });
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
