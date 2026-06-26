// ─────────────────────────────────────────────────────────────
// Crée TOUS les produits/prix Stripe d'un coup (abonnements + packs)
// Usage (PowerShell, dans le dossier du projet) :
//   $env:STRIPE_SECRET_KEY="sk_test_xxxxx"; node setup-stripe-prices.js
// ⚠️ À lancer UNE SEULE FOIS (sinon ça crée des doublons).
// ⚠️ Utilise ta clé secrète de TEST (sk_test_...) tant qu'on est en mode test.
// ─────────────────────────────────────────────────────────────
// La clé peut être passée en argument : node setup-stripe-prices.js sk_test_xxx
const key = process.argv[2] || process.env.STRIPE_SECRET_KEY;
if (!key || !/^sk_/.test(key)) { console.error('❌ Lance : node setup-stripe-prices.js sk_test_TA_CLE'); process.exit(1); }
const stripe = require('stripe')(key);

// Montants en CENTIMES (799 = 7,99€)
const PLANS = [
  { key: 'starter',    name: 'INK.STUDIO Starter', credits: 150,   monthly: 799,   annual: 7990 },
  { key: 'pro',        name: 'INK.STUDIO Pro',      credits: 400,   monthly: 1499,  annual: 14990 },
  { key: 'studio',     name: 'INK.STUDIO Studio',   credits: 1500,  monthly: 3999,  annual: 39990 },
  { key: 'studioplus', name: 'INK.STUDIO Studio+',  credits: 4000,  monthly: 8999,  annual: 89990 },
  { key: 'atelier',    name: 'INK.STUDIO Atelier',  credits: 10000, monthly: 19999, annual: 199990 },
];
const PACKS = [
  { key: 'mini',     credits: 50,  amount: 599 },
  { key: 'standard', credits: 150, amount: 1499 },
  { key: 'maxi',     credits: 500, amount: 4499 },
];

(async () => {
  const out = {};
  for (const p of PLANS) {
    const product = await stripe.products.create({ name: p.name, metadata: { plan: p.key, credits: String(p.credits) } });
    const m = await stripe.prices.create({ product: product.id, currency: 'eur', unit_amount: p.monthly, recurring: { interval: 'month' }, nickname: `${p.key} mensuel`, metadata: { plan: p.key, period: 'monthly', credits: String(p.credits) } });
    const a = await stripe.prices.create({ product: product.id, currency: 'eur', unit_amount: p.annual, recurring: { interval: 'year' }, nickname: `${p.key} annuel`, metadata: { plan: p.key, period: 'annual', credits: String(p.credits) } });
    out[`${p.key}_monthly`] = m.id;
    out[`${p.key}_annual`] = a.id;
    console.log(`✓ ${p.name} : mensuel ${m.id} | annuel ${a.id}`);
  }
  const packProduct = await stripe.products.create({ name: 'INK.STUDIO Crédits', metadata: { type: 'pack' } });
  for (const pk of PACKS) {
    const price = await stripe.prices.create({ product: packProduct.id, currency: 'eur', unit_amount: pk.amount, nickname: `Pack ${pk.credits} crédits`, metadata: { pack: pk.key, credits: String(pk.credits) } });
    out[`pack_${pk.key}`] = price.id;
    console.log(`✓ Pack ${pk.credits} crédits : ${price.id}`);
  }
  console.log('\n========== COPIE-COLLE TOUT CECI ET ENVOIE-LE-MOI ==========\n');
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error('❌ ERREUR Stripe:', e.message); process.exit(1); });
