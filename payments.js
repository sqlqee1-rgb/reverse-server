/* Reverse — the supporter shop: products, and server-side verification of Google Play purchases.
 *
 * A purchase only counts after the server confirms it with the Google Play Developer API, using a service account
 * (env GOOGLE_PLAY_SERVICE_ACCOUNT = the JSON key, the account needs the "View financial data / manage orders" permission
 * in Play Console). Each purchase token is recorded once, so a token can never be used twice.
 */
'use strict';
const crypto = require('crypto');

const PACKAGE = 'com.jiokim.reverse';
const PRODUCTS = [
  { sku: 'support_1', tier: 1, price: { RUB: '99 ₽', USD: '$1.99', KRW: '₩2,500' } },
  { sku: 'support_2', tier: 2, price: { RUB: '299 ₽', USD: '$4.99', KRW: '₩6,500' } },
  { sku: 'support_3', tier: 3, price: { RUB: '990 ₽', USD: '$14.99', KRW: '₩19,000' } },
];

let key = null;
try { if (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT) key = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT); } catch (e) { console.error('GOOGLE_PLAY_SERVICE_ACCOUNT is not valid JSON'); }

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
let token = null, tokenExp = 0;
async function accessToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(key.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('google auth failed: ' + JSON.stringify(j).slice(0, 200));
  token = j.access_token; tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

// true when Google says this token is a completed purchase of this product
async function verifyPlay(sku, purchaseToken) {
  if (!key) return { ok: false, reason: 'not_configured' };
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/products/${encodeURIComponent(sku)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const auth = { authorization: 'Bearer ' + await accessToken() };
  const r = await fetch(url, { headers: auth });
  if (!r.ok) return { ok: false, reason: 'http_' + r.status };
  const p = await r.json();
  if (p.purchaseState !== 0) return { ok: false, reason: 'state_' + p.purchaseState };
  if (p.acknowledgementState === 0) {
    await fetch(url + ':acknowledge', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' }).catch(() => { });
  }
  return { ok: true, order: p.orderId || null };
}

module.exports = { PRODUCTS, verifyPlay, configured: () => !!key };
