require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { PlaidApi, PlaidEnvironments, Configuration, Products, CountryCode } = require('plaid');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Data persistence (JSON file, works on Railway) ────────
const DATA_FILE = path.join(__dirname, 'data.json');

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { expenses: [], accessTokens: [], budgets: {}, lastSync: null };
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let appData = readData();

// ── Plaid setup ───────────────────────────────────────────
const plaidEnv = process.env.PLAID_ENV || 'sandbox';
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': plaidEnv === 'sandbox'
        ? process.env.PLAID_SANDBOX_SECRET
        : process.env.PLAID_DEVELOPMENT_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// ── Category mapping ──────────────────────────────────────
function mapCategory(plaidCat = '') {
  const c = plaidCat.toUpperCase();
  if (c.match(/FOOD|GROCER|SUPERMARKET|RESTAURANT|DINING/)) return 'groceries';
  if (c.match(/GAS|FUEL|TRANSPORT|AUTO|PARKING|VEHICLE/)) return 'gasolina';
  if (c.match(/RENT|UTIL|ELECTRIC|WATER|INSUR|MORTGAGE|PHONE|INTERNET/)) return 'renta';
  if (c.match(/ENTERTAIN|RECREATION|SPORT|TRAVEL|HOTEL|VACATION|CINEMA/)) return 'salidas';
  if (c.match(/PERSONAL|HEALTH|MEDICAL|PHARMACY|CLOTHING|BEAUTY|GYM/)) return 'personal';
  return 'otro';
}

// ── Plaid routes ──────────────────────────────────────────
app.post('/api/create_link_token', async (req, res) => {
  try {
    const r = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'jorge-rivmar' },
      client_name: 'Mi Pareja & Yo',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'es',
    });
    res.json({ link_token: r.data.link_token });
  } catch(e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.post('/api/exchange_token', async (req, res) => {
  const { public_token, institution_name } = req.body;
  try {
    const r = await plaidClient.itemPublicTokenExchange({ public_token });
    const token = { accessToken: r.data.access_token, itemId: r.data.item_id, institution: institution_name };
    const idx = appData.accessTokens.findIndex(t => t.itemId === token.itemId);
    if (idx >= 0) appData.accessTokens[idx] = token;
    else appData.accessTokens.push(token);
    writeData(appData);
    res.json({ success: true, institution: institution_name });
  } catch(e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ── Fetch transactions from Plaid ─────────────────────────
async function fetchPlaidTransactions(daysBack = 30) {
  const end = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  const all = [];
  for (const token of appData.accessTokens) {
    try {
      const r = await plaidClient.transactionsGet({
        access_token: token.accessToken,
        start_date: start, end_date: end,
        options: { count: 500, offset: 0 },
      });
      r.data.transactions.forEach(tx => {
        all.push({
          id: tx.transaction_id,
          date: tx.date,
          month: tx.date.substring(0, 7),
          desc: tx.merchant_name || tx.name,
          amount: Math.abs(tx.amount),
          cat: mapCategory(tx.personal_finance_category?.primary || tx.category?.[0] || ''),
          institution: token.institution,
          pending: tx.pending,
          source: 'bank',
        });
      });
    } catch(e) {
      console.warn('Plaid fetch error for', token.institution, e.response?.data?.error_code);
    }
  }
  return all.sort((a, b) => b.date.localeCompare(a.date));
}

app.get('/api/transactions/bank', async (req, res) => {
  try {
    const txs = await fetchPlaidTransactions(30);
    res.json({ transactions: txs, lastSync: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Expenses CRUD ─────────────────────────────────────────
app.get('/api/expenses', (req, res) => {
  res.json({ expenses: appData.expenses, lastSync: appData.lastSync });
});

app.post('/api/expenses', (req, res) => {
  const exp = req.body;
  if (!exp.id) exp.id = Date.now() + Math.random();
  if (!exp.date) exp.date = new Date().toISOString();
  if (!exp.month) exp.month = exp.date.substring(0, 7);
  appData.expenses.push(exp);
  writeData(appData);
  res.json({ success: true, expense: exp });
});

app.post('/api/expenses/bulk', (req, res) => {
  const { expenses } = req.body;
  const existingIds = new Set(appData.expenses.map(e => e.bankTxId).filter(Boolean));
  let added = 0;
  expenses.forEach(exp => {
    if (exp.bankTxId && existingIds.has(exp.bankTxId)) return;
    if (!exp.id) exp.id = Date.now() + Math.random() + added;
    appData.expenses.push(exp);
    added++;
  });
  writeData(appData);
  res.json({ success: true, added });
});

app.delete('/api/expenses/:id', (req, res) => {
  appData.expenses = appData.expenses.filter(e => String(e.id) !== req.params.id);
  writeData(appData);
  res.json({ success: true });
});

// ── Budgets ───────────────────────────────────────────────
app.get('/api/budgets', (req, res) => {
  res.json({ budgets: appData.budgets || {} });
});

app.post('/api/budgets', (req, res) => {
  appData.budgets = { ...appData.budgets, ...req.body };
  writeData(appData);
  res.json({ success: true, budgets: appData.budgets });
});

// ── Banks list ────────────────────────────────────────────
app.get('/api/banks', (req, res) => {
  res.json({ banks: appData.accessTokens.map(t => ({ institution: t.institution, itemId: t.itemId })) });
});

// ── Auto-sync every 6 hours ───────────────────────────────
cron.schedule('0 */6 * * *', async () => {
  if (!appData.accessTokens.length) return;
  console.log('⏰ Auto-sync transactions...');
  try {
    const txs = await fetchPlaidTransactions(7);
    const existingIds = new Set(appData.expenses.map(e => e.bankTxId).filter(Boolean));
    let added = 0;
    txs.forEach(tx => {
      if (tx.pending || existingIds.has(tx.id)) return;
      appData.expenses.push({ id: Date.now() + Math.random() + added, who: 'Auto', desc: tx.desc, amount: tx.amount, cat: tx.cat, date: new Date(tx.date).toISOString(), month: tx.month, bankTxId: tx.id, institution: tx.institution, source: 'bank' });
      added++;
    });
    if (added) { appData.lastSync = new Date().toISOString(); writeData(appData); }
    console.log(`✅ Auto-sync: ${added} new transactions`);
  } catch(e) { console.error('Auto-sync error:', e.message); }
});

// ── Health ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, env: plaidEnv, banks: appData.accessTokens.length, expenses: appData.expenses.length, lastSync: appData.lastSync });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n💰 Pareja Budget Backend → http://localhost:${PORT}`);
  console.log(`🏦 Plaid: ${plaidEnv} | Banks: ${appData.accessTokens.length} | Expenses: ${appData.expenses.length}\n`);
});
