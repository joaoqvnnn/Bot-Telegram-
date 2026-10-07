/* ============================================================
   FORÇA SINGLE WORKER (evita erro 409 no Telegram)
   ============================================================ */
process.env.WEB_CONCURRENCY = '1';
process.env.UV_THREADPOOL_SIZE = '1';

require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const QRCode = require('qrcode');
const sharp  = require('sharp');
const PDFDocument = require('pdfkit');
const express = require('express');
const https = require('https');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/* ============================================================
   CONFIGURAÇÃO
   ============================================================ */
const BOT_TOKEN       = process.env.BOT_TOKEN;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const WEBHOOK_URL     = process.env.WEBHOOK_URL || 'http://localhost:3000';
const PORT            = process.env.PORT || 3000;
const ADMIN_CHAT_ID   = process.env.ADMIN_CHAT_ID || null;

// Saque
const WITHDRAW_PASSWORD = process.env.WITHDRAW_PASSWORD || '1234';
const MIN_WITHDRAW      = 0.01; // R$ 0,01

// Efí PIX (Gerencianet)
const EFI_CLIENT_ID     = process.env.EFI_CLIENT_ID;
const EFI_CLIENT_SECRET = process.env.EFI_CLIENT_SECRET;
const EFI_PIX_KEY       = process.env.EFI_PIX_KEY;      // chave PIX de quem envia
const EFI_CERT_BASE64   = process.env.EFI_CERT_BASE64;  // .p12 em base64
const EFI_SANDBOX       = (process.env.EFI_SANDBOX || 'true').toLowerCase() === 'true';
const EFI_BASE          = EFI_SANDBOX
  ? 'https://pix-h.api.efipay.com.br'
  : 'https://pix.api.efipay.com.br';

const HAS_EFI = !!(EFI_CLIENT_ID && EFI_CLIENT_SECRET && EFI_PIX_KEY && EFI_CERT_BASE64);

if (!BOT_TOKEN)       { console.error('❌ BOT_TOKEN não configurado'); process.exit(1); }
if (!MP_ACCESS_TOKEN) { console.error('❌ MP_ACCESS_TOKEN não configurado'); process.exit(1); }

const bot       = new Telegraf(BOT_TOKEN);
const mpClient  = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const mpPayment = new Payment(mpClient);

if (!HAS_EFI) {
  console.warn('⚠️  Efí não configurado — saque vai usar modo SIMULADO.');
} else {
  console.log(`✅ Efí configurado (${EFI_SANDBOX ? 'SANDBOX' : 'PRODUÇÃO'})`);
}

/* ============================================================
   AGENTE HTTPS COM CERTIFICADO (.p12)
   ============================================================ */
let efiAgent = null;
if (HAS_EFI) {
  try {
    const certBuffer = Buffer.from(EFI_CERT_BASE64, 'base64');
    efiAgent = new https.Agent({
      pfx: certBuffer,
      passphrase: '',
      rejectUnauthorized: !EFI_SANDBOX
    });
  } catch (e) {
    console.error('❌ Erro ao carregar certificado Efí:', e.message);
  }
}

/* ============================================================
   TRADUÇÕES
   ============================================================ */
const translations = {
  pt: {
    welcome: '👋 Olá, *{name}*!\n\n🛒 *Bem-vindo à nossa lojinha!*\n\nEscolha um produto abaixo:',
    catalog_title: '🛒 *Catálogo*\n\nEscolha um produto:',
    choose_payment: '💳 *{product}*\n💰 Valor: *{price}*\n⭐ Stars: *{stars}*\n\nComo você quer pagar?',
    btn_pix: '⚡ Pagar com PIX',
    btn_stars: '⭐ Pagar com Stars',
    btn_back: '◀️ Voltar ao catálogo',
    generating: '⏳ Gerando pagamento...',
    pix_title: '💳 *{product}*\n💰 Valor: *{price}*\n\n📱 Escaneie o QR Code ou use o botão "Copiar PIX".\n\n⏳ *Aguardando pagamento*',
    btn_copy_pix: '📋 Copiar PIX',
    btn_check: '🔄 Verificar pagamento',
    btn_cancel: '❌ Cancelar',
    stars_title: '⭐ *{product}*\n\nVocê escolheu pagar com *{stars} Stars*.',
    paid_title: '✅ *Pagamento aprovado!*\n\n💳 Produto: *{product}*\n💰 Valor: *{price}*\n🆔 `{id}`\n\n_Obrigado pela compra!_ 🎉',
    btn_paid: '✅ Pago',
    cancelled_title: '❌ *Compra cancelada*\n\nSe quiser tentar novamente, use /catalogo.',
    still_pending: '⏳ Ainda não identificamos o pagamento.\nAguarde e tente novamente.',
    error_generic: '❌ Erro ao gerar o pagamento. Tente novamente.',
    no_orders: 'Você ainda não fez nenhum pedido. Use /catalogo para começar.',
    my_orders: '📋 *Seus últimos pedidos*\n\n{list}',
    language_set: '✅ Idioma alterado para *Português*.',
    choose_language: '🌐 Escolha o idioma / Choose your language:',
    product_not_found: '❌ Produto não encontrado',
    payment_not_found: '❌ Pagamento não encontrado',
    already_paid: '✅ Este pagamento já foi confirmado!',
    verifying: '🔍 Verificando pagamento...',
    check_error: '❌ Erro ao verificar. Tente novamente.',

    // Afiliado
    affiliate_title: '💰 *Painel de Afiliado*\n\n💵 *Saldo disponível:* R$ {balance}\n📈 *Total ganho:* R$ {earned}\n\n_Valor mínimo para saque: R$ 0,01_',
    btn_withdraw: '💸 Sacar agora',
    btn_withdraw_history: '📋 Histórico',
    withdraw_ask_key: '🔑 *Saque Afiliado*\n\nDigite sua chave PIX abaixo.\n\nFormatos aceitos:\n• CPF: `12345678900`\n• E-mail: `seu@email.com`\n• Telefone: `+5511999999999`\n• Aleatória: `chave-aleatoria-uuid`',
    withdraw_invalid_key: '❌ Chave PIX inválida. Tente novamente.',
    withdraw_confirm_title: '🔎 *Confirme os dados do saque*\n\n👤 *Nome:* {holder}\n🏦 *Banco:* {bank}\n🔑 *Chave PIX:* {pixKey}\n💵 *Valor:* R$ {amount}\n\nEstá tudo correto?',
    btn_confirm_withdraw: '✅ Confirmar saque',
    btn_cancel_withdraw: '❌ Cancelar',
    withdraw_ask_password: '🔒 *Confirmação de segurança*\n\nDigite sua senha para autorizar o saque.\n\n_Se não tiver uma senha, use a senha de teste informada pelo suporte._',
    withdraw_wrong_password: '❌ Senha incorreta. Tente novamente.',
    withdraw_processing: '⏳ *Processando pagamento...*\n\nEstamos enviando R$ {amount} para {holder}.\n\n_Aguarde, isso pode levar alguns segundos._',
    withdraw_success: '✅ *Pagamento realizado com sucesso!*\n\n💵 *Valor:* R$ {amount}\n👤 *Destinatário:* {holder}\n🏦 *Banco:* {bank}\n🔑 *Chave:* {pixKey}\n🆔 *ID:* `{id}`\n📅 *Data:* {date}\n\n_Comprovante disponível abaixo._',
    withdraw_failed: '❌ *Falha no saque*\n\nNão foi possível processar o PIX.\n\n_Motivo:_ {reason}\n\nSeu saldo não foi alterado. Tente novamente.',
    withdraw_insufficient: '❌ Saldo insuficiente para saque.\n\n💵 Você tem: R$ {balance}\n💰 Mínimo: R$ 0,01',
    withdraw_no_history: '📋 *Histórico*\n\nVocê ainda não fez nenhum saque.',
    withdraw_history_title: '📋 *Histórico de saques*',
    btn_pdf: '📄 Enviar em PDF',
    btn_new_withdraw: '💸 Novo saque',
    btn_back_affiliate: '◀️ Voltar',
    pdf_sending: '⏳ Gerando PDF...',
    pdf_ready: '📄 Comprovante em PDF gerado. Salve e guarde para seus registros.'
  },
  en: {
    welcome: '👋 Hello, *{name}*!\n\n🛒 *Welcome to our shop!*\n\nChoose a product below:',
    catalog_title: '🛒 *Catalog*\n\nChoose a product:',
    choose_payment: '💳 *{product}*\n💰 Price: *{price}*\n⭐ Stars: *{stars}*\n\nHow would you like to pay?',
    btn_pix: '⚡ Pay with PIX',
    btn_stars: '⭐ Pay with Stars',
    btn_back: '◀️ Back to catalog',
    generating: '⏳ Generating payment...',
    pix_title: '💳 *{product}*\n💰 Price: *{price}*\n\n📱 Scan the QR Code or use "Copy PIX".\n\n⏳ *Awaiting payment*',
    btn_copy_pix: '📋 Copy PIX',
    btn_check: '🔄 Check payment',
    btn_cancel: '❌ Cancel',
    stars_title: '⭐ *{product}*\n\nYou chose to pay with *{stars} Stars*.',
    paid_title: '✅ *Payment approved!*\n\n💳 Product: *{product}*\n💰 Price: *{price}*\n🆔 `{id}`\n\n_Thank you for your purchase!_ 🎉',
    btn_paid: '✅ Paid',
    cancelled_title: '❌ *Purchase cancelled*\n\nTo try again, use /catalogo.',
    still_pending: '⏳ We haven\'t detected the payment yet.\nWait a moment and try again.',
    error_generic: '❌ Error generating payment. Please try again.',
    no_orders: 'You haven\'t placed any orders yet. Use /catalogo to start.',
    my_orders: '📋 *Your recent orders*\n\n{list}',
    language_set: '✅ Language changed to *English*.',
    choose_language: '🌐 Escolha o idioma / Choose your language:',
    product_not_found: '❌ Product not found',
    payment_not_found: '❌ Payment not found',
    already_paid: '✅ This payment was already confirmed!',
    verifying: '🔍 Checking payment...',
    check_error: '❌ Error checking. Please try again.',

    affiliate_title: '💰 *Affiliate Panel*\n\n💵 *Available balance:* R$ {balance}\n📈 *Total earned:* R$ {earned}\n\n_Minimum withdrawal: R$ 0.01_',
    btn_withdraw: '💸 Withdraw now',
    btn_withdraw_history: '📋 History',
    withdraw_ask_key: '🔑 *Affiliate Withdrawal*\n\nSend your PIX key below.',
    withdraw_invalid_key: '❌ Invalid PIX key. Try again.',
    withdraw_confirm_title: '🔎 *Confirm withdrawal*\n\n👤 *Name:* {holder}\n🏦 *Bank:* {bank}\n🔑 *PIX Key:* {pixKey}\n💵 *Amount:* R$ {amount}\n\nIs everything correct?',
    btn_confirm_withdraw: '✅ Confirm',
    btn_cancel_withdraw: '❌ Cancel',
    withdraw_ask_password: '🔒 *Security confirmation*\n\nType your password to authorize the withdrawal.',
    withdraw_wrong_password: '❌ Wrong password. Try again.',
    withdraw_processing: '⏳ *Processing payment...*\n\nSending R$ {amount} to {holder}.',
    withdraw_success: '✅ *Payment successful!*\n\n💵 *Amount:* R$ {amount}\n👤 *Recipient:* {holder}\n🏦 *Bank:* {bank}\n🆔 *ID:* `{id}`\n📅 *Date:* {date}',
    withdraw_failed: '❌ *Withdrawal failed*\n\n_Reason:_ {reason}',
    withdraw_insufficient: '❌ Insufficient balance.\n\nYou have: R$ {balance}',
    withdraw_no_history: '📋 No withdrawals yet.',
    withdraw_history_title: '📋 *Withdrawal history*',
    btn_pdf: '📄 Send as PDF',
    btn_new_withdraw: '💸 New withdrawal',
    btn_back_affiliate: '◀️ Back',
    pdf_sending: '⏳ Generating PDF...',
    pdf_ready: '📄 PDF statement ready.'
  }
};

/* ============================================================
   PRODUTOS
   ============================================================ */
const PRODUCTS = [
  { id: 'teste', name: 'Produto Teste', nameEn: 'Test Product', price: 0.01, stars: 1   },
  { id: 'p1',    name: 'Produto A',     nameEn: 'Product A',    price: 5.00, stars: 50  },
  { id: 'p2',    name: 'Produto B',     nameEn: 'Product B',    price: 15.00, stars: 150 },
  { id: 'p3',    name: 'Produto C',     nameEn: 'Product C',    price: 30.00, stars: 300 }
];

/* ============================================================
   IDIOMAS
   ============================================================ */
const userLanguages = new Map();

function getUserLang(ctx) {
  if (userLanguages.has(ctx.from.id)) return userLanguages.get(ctx.from.id);
  const code = (ctx.from.language_code || 'en').toLowerCase();
  const lang = code.startsWith('pt') ? 'pt' : 'en';
  userLanguages.set(ctx.from.id, lang);
  return lang;
}

function t(ctx, key, vars = {}) {
  const lang = getUserLang(ctx);
  let text = (translations[lang] && translations[lang][key]) || translations.pt[key] || key;
  Object.keys(vars).forEach(k => {
    text = text.split(`{${k}}`).join(vars[k]);
  });
  return text;
}

function translate(lang, key, vars = {}) {
  let text = (translations[lang] && translations[lang][key]) || translations.pt[key] || key;
  Object.keys(vars).forEach(k => {
    text = text.split(`{${k}}`).join(vars[k]);
  });
  return text;
}

function productName(product, ctx) {
  const lang = getUserLang(ctx);
  return lang === 'en' ? (product.nameEn || product.name) : product.name;
}

function formatPrice(product) {
  return 'R$ ' + product.price.toFixed(2).replace('.', ',');
}

/* ============================================================
   STORAGE
   ============================================================ */
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'payments.json');
const WITHDRAW_FILE = path.join(DATA_DIR, 'withdrawals.json');
const BALANCE_FILE  = path.join(DATA_DIR, 'affiliate_balances.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return fallback;
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {}
}

let payments       = loadJSON(DATA_FILE, {});
let withdrawals    = loadJSON(WITHDRAW_FILE, {});
let affiliateBals  = loadJSON(BALANCE_FILE, {});

function savePayments()      { saveJSON(DATA_FILE, payments); }
function saveWithdrawals()   { saveJSON(WITHDRAW_FILE, withdrawals); }
function saveAffiliateBals() { saveJSON(BALANCE_FILE, affiliateBals); }

/* ============================================================
   ESTADOS POR USUÁRIO (para fluxo de conversa)
   ============================================================ */
const userStates = new Map();
// step: 'awaiting_pix_key' | 'awaiting_password'
// data: { pixKey, holderName, bankName, amount }

function setUserState(userId, step, data = {}) {
  userStates.set(userId, { step, data });
}
function getUserState(userId) {
  return userStates.get(userId) || null;
}
function clearUserState(userId) {
  userStates.delete(userId);
}

/* ============================================================
   SALDO DE AFILIADO
   ============================================================ */
function getAffiliateBalance(userId) {
  if (!affiliateBals[userId]) {
    affiliateBals[userId] = {
      balance: 0.01,   // ← R$ 0,01 de demo para testar
      totalEarned: 0.01,
      createdAt: Date.now()
    };
    saveAffiliateBals();
  }
  return affiliateBals[userId];
}

function deductBalance(userId, amount) {
  const b = getAffiliateBalance(userId);
  b.balance = Math.round((b.balance - amount) * 100) / 100;
  if (b.balance < 0) b.balance = 0;
  saveAffiliateBals();
  return b;
}

/* ============================================================
   QR CODE BONITO (mantido do código anterior)
   ============================================================ */
async function generateBeautifulQR(text, paid = false) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
  const modules = qr.modules;
  const size = modules.size;
  const data = modules.data;

  const moduleSize = 14;
  const padding    = 3;
  const totalSize = (size + padding * 2) * moduleSize;

  const fgColor = '#0f172a';
  const bgColor = '#ffffff';

  function inFinder(row, col) {
    const tl = row < 7 && col < 7;
    const tr = row < 7 && col >= size - 7;
    const bl = row >= size - 7 && col < 7;
    return tl || tr || bl;
  }

  let dots = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!data[r * size + c]) continue;
      if (inFinder(r, c)) continue;
      const x = (c + padding) * moduleSize + moduleSize / 2;
      const y = (r + padding) * moduleSize + moduleSize / 2;
      dots += `<circle cx="${x}" cy="${y}" r="${(moduleSize / 2) * 0.92}"/>`;
    }
  }

  function drawFinder(startX, startY) {
    const s = moduleSize;
    return `
      <rect x="${startX}" y="${startY}" width="${s*7}" height="${s*7}" rx="${s*1.6}" fill="${fgColor}"/>
      <rect x="${startX + s}" y="${startY + s}" width="${s*5}" height="${s*5}" rx="${s*1.0}" fill="${bgColor}"/>
      <rect x="${startX + s*2}" y="${startY + s*2}" width="${s*3}" height="${s*3}" rx="${s*0.7}" fill="${fgColor}"/>
    `;
  }

  const padPx = padding * moduleSize;
  const finders =
    drawFinder(padPx, padPx) +
    drawFinder(padPx + (size - 7) * moduleSize, padPx) +
    drawFinder(padPx, padPx + (size - 7) * moduleSize);

  const svg = `
    <svg width="${totalSize}" height="${totalSize}" viewBox="0 0 ${totalSize} ${totalSize}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${totalSize}" height="${totalSize}" rx="24" fill="${bgColor}"/>
      <g fill="${fgColor}">${dots}</g>
      ${finders}
    </svg>
  `;

  let png = await sharp(Buffer.from(svg)).png().toBuffer();

  if (paid) {
    const circleSize = Math.floor(totalSize * 0.22);
    const circleSvg = Buffer.from(`
      <svg width="${circleSize}" height="${circleSize}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${circleSize/2}" cy="${circleSize/2}" r="${circleSize/2 - 4}" fill="#10b981" stroke="#ffffff" stroke-width="5"/>
        <path d="M ${circleSize*0.30} ${circleSize*0.52} L ${circleSize*0.45} ${circleSize*0.67} L ${circleSize*0.72} ${circleSize*0.34}"
              stroke="#ffffff" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `);
    png = await sharp(png).composite([{ input: circleSvg, gravity: 'center' }]).png().toBuffer();
  }

  return png;
}

/* ============================================================
   CATÁLOGO
   ============================================================ */
function catalogKeyboard(ctx) {
  const rows = PRODUCTS.map(p => [
    Markup.button.callback(
      `${productName(p, ctx)} — R$ ${p.price.toFixed(2).replace('.', ',')} / ⭐ ${p.stars}`,
      `buy:${p.id}`
    )
  ]);
  return Markup.inlineKeyboard(rows);
}

/* ============================================================
   EFÍ — TOKEN, DICT LOOKUP, ENVIO PIX
   ============================================================ */
async function efiGetToken() {
  if (!HAS_EFI || !efiAgent) throw new Error('Efí não configurado');

  const auth = Buffer.from(`${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(`${EFI_BASE}/oauth/token`, 'grant_type=client_credentials', {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    httpsAgent: efiAgent
  });
  return res.data.access_token;
}

async function efiLookupPixKey(pixKey) {
  // Retorna { holderName, bankName } ou null se não conseguir
  if (!HAS_EFI) return null;

  try {
    const token = await efiGetToken();
    const res = await axios.get(
      `${EFI_BASE}/v2/gn/dict/${encodeURIComponent(pixKey)}`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        httpsAgent: efiAgent
      }
    );
    return {
      holderName: res.data?.nome || 'Titular não identificado',
      bankName:   res.data?.nomeFantasia || res.data?.razaoSocial || 'Banco não identificado'
    };
  } catch (e) {
    console.error('DICT lookup falhou:', e.response?.data?.mensagem || e.message);
    return null;
  }
}

async function efiSendPix({ pixKey, amount, description }) {
  if (!HAS_EFI) {
    // Modo simulador (para desenvolvimento)
    console.log('🧪 Simulando envio de PIX (Efí não configurado)');
    await new Promise(r => setTimeout(r, 1500));
    return {
      sucesso: true,
      e2eId: 'SIMULADO_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      simulated: true
    };
  }

  const token = await efiGetToken();
  const idEnvio = Date.now().toString();

  const res = await axios.put(
    `${EFI_BASE}/v2/gn/pix/${idEnvio}`,
    {
      valor: amount.toFixed(2),
      pagador: {
        chave: EFI_PIX_KEY,
        infoPagador: description || 'Saque de afiliado'
      },
      favorecido: {
        chave: pixKey
      }
    },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      httpsAgent: efiAgent
    }
  );

  return {
    sucesso: true,
    e2eId: res.data?.e2eId || idEnvio,
    raw: res.data
  };
}

/* ============================================================
   VALIDAÇÃO DE CHAVE PIX (formatos)
   ============================================================ */
function detectPixKeyType(pixKey) {
  const key = String(pixKey || '').trim();
  if (!key) return null;

  const digits = key.replace(/\D/g, '');

  // CPF: 11 dígitos
  if (/^\d{11}$/.test(digits)) return 'CPF';

  // CNPJ: 14 dígitos
  if (/^\d{14}$/.test(digits)) return 'CNPJ';

  // Telefone: +55 + DDD + número (13 dígitos com +55)
  if (/^\+?55\d{10,11}$/.test(key.replace(/\D/g, ''))) return 'PHONE';

  // E-mail
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return 'EMAIL';

  // Chave aleatória (UUID v4)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return 'EVP';

  return null;
}

function maskPixKey(pixKey, type) {
  const key = String(pixKey || '');
  if (type === 'CPF' || type === 'CNPJ') {
    return key.replace(/\d(?=\d{2})/g, '*');
  }
  if (type === 'EMAIL') {
    const [user, domain] = key.split('@');
    const maskUser = user.slice(0, 2) + '*'.repeat(Math.max(user.length - 2, 1));
    return `${maskUser}@${domain}`;
  }
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/* ============================================================
   COMPROVANTE — IMAGEM (Nubank style)
   ============================================================ */
async function generateStatementImage({
  amount, holderName, bankName, pixKey, pixKeyType, transactionId, date
}) {
  const W = 900, H = 700;

  const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="headerGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#820AD1"/>
          <stop offset="100%" stop-color="#a336e0"/>
        </linearGradient>
      </defs>

      <rect width="${W}" height="${H}" fill="#f5f5f7"/>
      <rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="24" fill="#ffffff"/>

      <path d="M 40 64 Q 40 40 64 40 L ${W - 64} 40 Q ${W - 40} 40 ${W - 40} 64 L ${W - 40} 180 L 40 180 Z" fill="url(#headerGrad)"/>

      <text x="80" y="90" font-family="Arial" font-size="22" font-weight="700" fill="#ffffff">Comprovante PIX</text>
      <text x="80" y="118" font-family="Arial" font-size="13" fill="#ffffff" opacity="0.85">Transferência realizada com sucesso</text>

      <circle cx="${W - 100}" cy="90" r="32" fill="#ffffff" opacity="0.18"/>
      <path d="M ${W - 113} 90 L ${W - 103} 100 L ${W - 87} 80" stroke="#ffffff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>

      <text x="80" y="240" font-family="Arial" font-size="13" fill="#8b8d98" letter-spacing="1">VALOR TRANSFERIDO</text>
      <text x="80" y="300" font-family="Arial" font-size="52" font-weight="800" fill="#0f172a">R$ ${amount.toFixed(2).replace('.', ',')}</text>

      <line x1="80" y1="340" x2="${W - 80}" y2="340" stroke="#e5e7eb" stroke-width="1"/>

      <text x="80" y="390" font-family="Arial" font-size="12" fill="#8b8d98">Destinatário</text>
      <text x="80" y="415" font-family="Arial" font-size="17" font-weight="600" fill="#0f172a">${escapeXml(holderName)}</text>

      <text x="${W / 2}" y="390" font-family="Arial" font-size="12" fill="#8b8d98">Instituição</text>
      <text x="${W / 2}" y="415" font-family="Arial" font-size="17" font-weight="600" fill="#0f172a">${escapeXml(bankName)}</text>

      <text x="80" y="470" font-family="Arial" font-size="12" fill="#8b8d98">Chave PIX (${pixKeyType || '—'})</text>
      <text x="80" y="495" font-family="Arial" font-size="17" font-weight="600" fill="#0f172a">${escapeXml(maskPixKey(pixKey, pixKeyType))}</text>

      <text x="${W / 2}" y="470" font-family="Arial" font-size="12" fill="#8b8d98">Data e hora</text>
      <text x="${W / 2}" y="495" font-family="Arial" font-size="17" font-weight="600" fill="#0f172a">${escapeXml(date)}</text>

      <text x="80" y="550" font-family="Arial" font-size="12" fill="#8b8d98">ID da transação (E2E)</text>
      <text x="80" y="575" font-family="Courier New" font-size="13" fill="#0f172a">${escapeXml(transactionId)}</text>

      <line x1="80" y1="620" x2="${W - 80}" y2="620" stroke="#e5e7eb" stroke-width="1"/>
      <text x="80" y="645" font-family="Arial" font-size="11" fill="#8b8d98">Comprovante gerado eletronicamente — Loja Digital</text>
    </svg>
  `;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

function escapeXml(s) {
  return String(s ?? '').replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  }[c]));
}

/* ============================================================
   COMPROVANTE — PDF
   ============================================================ */
function generateStatementPDF({
  amount, holderName, bankName, pixKey, pixKeyType, transactionId, date
}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width;
      const H = doc.page.height;
      const margin = 50;

      // Header roxo
      doc.rect(0, 0, W, 140).fill('#820AD1');

      // Título
      doc.fillColor('#ffffff')
         .fontSize(24).font('Helvetica-Bold')
         .text('Comprovante PIX', margin, 45);
      doc.fontSize(12).font('Helvetica')
         .text('Transferência realizada com sucesso', margin, 80);

      // Check branco (círculo + check com paths)
      doc.circle(W - margin - 30, 70, 28).fillOpacity(0.2).fill('#ffffff').fillOpacity(1);
      doc.save()
         .translate(W - margin - 30, 70)
         .lineWidth(5)
         .strokeColor('#ffffff')
         .moveTo(-13, 0)
         .lineTo(-3, 10)
         .lineTo(13, -10)
         .stroke()
         .restore();

      // Valor
      doc.fillColor('#8b8d98').fontSize(11).font('Helvetica')
         .text('VALOR TRANSFERIDO', margin, 200);
      doc.fillColor('#0f172a').fontSize(44).font('Helvetica-Bold')
         .text(`R$ ${amount.toFixed(2).replace('.', ',')}`, margin, 220);

      // Linha
      doc.strokeColor('#e5e7eb').lineWidth(1)
         .moveTo(margin, 300).lineTo(W - margin, 300).stroke();

      // Detalhes
      const col2 = W / 2;

      doc.fillColor('#8b8d98').fontSize(10).font('Helvetica')
         .text('Destinatário', margin, 330);
      doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold')
         .text(holderName, margin, 348);

      doc.fillColor('#8b8d98').fontSize(10).font('Helvetica')
         .text('Instituição', col2, 330);
      doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold')
         .text(bankName, col2, 348);

      doc.fillColor('#8b8d98').fontSize(10).font('Helvetica')
         .text(`Chave PIX (${pixKeyType || '—'})`, margin, 400);
      doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold')
         .text(maskPixKey(pixKey, pixKeyType), margin, 418);

      doc.fillColor('#8b8d98').fontSize(10).font('Helvetica')
         .text('Data e hora', col2, 400);
      doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold')
         .text(date, col2, 418);

      doc.fillColor('#8b8d98').fontSize(10).font('Helvetica')
         .text('ID da transação (E2E)', margin, 470);
      doc.fillColor('#0f172a').fontSize(12).font('Courier')
         .text(transactionId, margin, 488);

      // Rodapé
      doc.strokeColor('#e5e7eb').lineWidth(1)
         .moveTo(margin, H - 100).lineTo(W - margin, H - 100).stroke();
      doc.fillColor('#8b8d98').fontSize(9).font('Helvetica')
         .text('Comprovante gerado eletronicamente — Loja Digital', margin, H - 80);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/* ============================================================
   NOTIFICAR ADMIN
   ============================================================ */
async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'Markdown' });
  } catch (e) {}
}

/* ============================================================
   COMANDOS
   ============================================================ */
bot.start(async (ctx) => {
  const name = ctx.from.first_name || 'cliente';
  await ctx.reply(
    t(ctx, 'welcome', { name }),
    { parse_mode: 'Markdown', ...catalogKeyboard(ctx) }
  );
});

bot.command('catalogo', async (ctx) => {
  await ctx.reply(t(ctx, 'catalog_title'),
    { parse_mode: 'Markdown', ...catalogKeyboard(ctx) });
});

bot.command('language', async (ctx) => {
  await ctx.reply(t(ctx, 'choose_language'),
    Markup.inlineKeyboard([
      [Markup.button.callback('🇧🇷 Português', 'lang:pt')],
      [Markup.button.callback('🇺🇸 English', 'lang:en')]
    ])
  );
});

bot.command('meuspedidos', async (ctx) => {
  const meus = Object.values(payments).filter(p => p.chatId === ctx.chat.id);
  if (!meus.length) return ctx.reply(t(ctx, 'no_orders'));
  const lista = meus.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map(p => {
    const icon = p.status === 'paid' ? '✅' : p.status === 'cancelled' ? '❌' : '⏳';
    const method = p.method === 'stars' ? '⭐ Stars' : '⚡ PIX';
    return `${icon} *${p.productName}* — ${p.method === 'stars' ? p.stars + ' Stars' : p.priceLabel} (${method})`;
  }).join('\n');
  await ctx.reply(t(ctx, 'my_orders', { list: lista }), { parse_mode: 'Markdown' });
});

/* ============================================================
   /afiliado — Painel do afiliado
   ============================================================ */
bot.command('afiliado', async (ctx) => {
  const userId = ctx.from.id;
  const bal = getAffiliateBalance(userId);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(t(ctx, 'btn_withdraw'), 'aff:withdraw')],
    [Markup.button.callback(t(ctx, 'btn_withdraw_history'), 'aff:history')]
  ]);

  await ctx.reply(
    t(ctx, 'affiliate_title', {
      balance: bal.balance.toFixed(2).replace('.', ','),
      earned: bal.totalEarned.toFixed(2).replace('.', ',')
    }),
    { parse_mode: 'Markdown', ...keyboard }
  );
});

/* ============================================================
   SAQUE — botão inicial
   ============================================================ */
bot.action('aff:withdraw', async (ctx) => {
  const userId = ctx.from.id;
  const bal = getAffiliateBalance(userId);

  if (bal.balance < MIN_WITHDRAW) {
    return ctx.answerCbQuery(
      t(ctx, 'withdraw_insufficient', { balance: bal.balance.toFixed(2).replace('.', ',') }),
      { show_alert: true }
    );
  }

  await ctx.answerCbQuery();
  setUserState(userId, 'awaiting_pix_key', { amount: bal.balance });

  await ctx.reply(
    t(ctx, 'withdraw_ask_key'),
    { parse_mode: 'Markdown' }
  );
});

/* ============================================================
   HISTÓRICO DE SAQUES
   ============================================================ */
bot.action('aff:history', async (ctx) => {
  const userId = ctx.from.id;
  const meus = Object.values(withdrawals).filter(w => w.userId === userId);

  if (!meus.length) {
    return ctx.answerCbQuery(t(ctx, 'withdraw_no_history'), { show_alert: true });
  }

  const lista = meus.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map(w => {
    const icon = w.status === 'completed' ? '✅' : w.status === 'failed' ? '❌' : '⏳';
    const date = new Date(w.createdAt).toLocaleDateString('pt-BR');
    return `${icon} R$ ${w.amount.toFixed(2).replace('.', ',')} — ${date}\n   \`${w.transactionId}\``;
  }).join('\n\n');

  await ctx.answerCbQuery();
  await ctx.reply(
    `${t(ctx, 'withdraw_history_title')}\n\n${lista}`,
    { parse_mode: 'Markdown' }
  );
});

/* ============================================================
   PROCESSAR TEXTO DO USUÁRIO (chave PIX ou senha)
   ============================================================ */
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);

  if (!state) return next(); // não é parte de um fluxo, deixa outro handler

  const text = ctx.message.text.trim();

  // ETAPA 1: Chave PIX
  if (state.step === 'awaiting_pix_key') {
    const pixType = detectPixKeyType(text);

    if (!pixType) {
      return ctx.reply(t(ctx, 'withdraw_invalid_key'));
    }

    // Tenta buscar dados do titular via DICT
    const lookup = await efiLookupPixKey(text);

    const holderName = lookup?.holderName || 'Titular da chave';
    const bankName   = lookup?.bankName   || 'Banco do destinatário';

    // Salva dados no estado
    setUserState(userId, 'awaiting_confirm', {
      ...state.data,
      pixKey: text,
      pixKeyType: pixType,
      holderName,
      bankName
    });

    const confirmText = t(ctx, 'withdraw_confirm_title', {
      holder: holderName,
      bank: bankName,
      pixKey: maskPixKey(text, pixType),
      amount: state.data.amount.toFixed(2).replace('.', ',')
    });

    await ctx.reply(
      confirmText,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(ctx, 'btn_confirm_withdraw'), 'aff:confirm')],
          [Markup.button.callback(t(ctx, 'btn_cancel_withdraw'), 'aff:cancel')]
        ])
      }
    );
    return;
  }

  // ETAPA 2: Senha
  if (state.step === 'awaiting_password') {
    if (text !== WITHDRAW_PASSWORD) {
      return ctx.reply(t(ctx, 'withdraw_wrong_password'));
    }

    // Senha correta → inicia processamento
    clearUserState(userId);
    await processWithdrawal(ctx, state.data);
    return;
  }

  return next();
});

/* ============================================================
   CONFIRMAÇÃO → PEDE SENHA
   ============================================================ */
bot.action('aff:confirm', async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);

  if (!state || state.step !== 'awaiting_confirm') {
    return ctx.answerCbQuery('❌ Sessão expirada. Comece de novo com /afiliado', { show_alert: true });
  }

  await ctx.answerCbQuery();

  // Salva os dados atuais e avança para pedir senha
  setUserState(userId, 'awaiting_password', state.data);

  try {
    await ctx.editMessageText(
      t(ctx, 'withdraw_ask_password'),
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply(
      t(ctx, 'withdraw_ask_password'),
      { parse_mode: 'Markdown' }
    );
  }
});

/* ============================================================
   CANCELAR SAQUE
   ============================================================ */
bot.action('aff:cancel', async (ctx) => {
  clearUserState(ctx.from.id);
  await ctx.answerCbQuery('❌');
  try {
    await ctx.editMessageText(
      t(ctx, 'cancelled_title'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛒 /catalogo', 'open_catalog')]
        ])
      }
    );
  } catch (e) {}
});

/* ============================================================
   PROCESSAR SAQUE (core)
   ============================================================ */
async function processWithdrawal(ctx, data) {
  const userId = ctx.from.id;
  const { pixKey, pixKeyType, holderName, bankName, amount } = data;

  // 1) Mostra mensagem "Processando..." (EDITA a mensagem anterior se possível)
  let statusMessage;
  try {
    await ctx.editMessageText(
      t(ctx, 'withdraw_processing', {
        amount: amount.toFixed(2).replace('.', ','),
        holder: holderName
      }),
      { parse_mode: 'Markdown' }
    );
    statusMessage = ctx.callbackQuery?.message;
  } catch (e) {
    statusMessage = await ctx.reply(
      t(ctx, 'withdraw_processing', {
        amount: amount.toFixed(2).replace('.', ','),
        holder: holderName
      }),
      { parse_mode: 'Markdown' }
    );
  }

  // 2) Cria registro de saque
  const withdrawalId = 'WD_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8).toUpperCase();

  withdrawals[withdrawalId] = {
    id: withdrawalId,
    userId,
    chatId: ctx.chat.id,
    amount,
    pixKey,
    pixKeyType,
    holderName,
    bankName,
    status: 'processing',
    createdAt: Date.now()
  };
  saveWithdrawals();

  // 3) Executa o envio do PIX
  let e2eId = withdrawalId;
  let success = false;
  let errorReason = '';

  try {
    const result = await efiSendPix({
      pixKey,
      amount,
      description: `Saque afiliado ${withdrawalId}`
    });

    if (result.sucesso) {
      success = true;
      e2eId = result.e2eId || withdrawalId;
    } else {
      errorReason = 'Resposta inválida do provedor';
    }
  } catch (err) {
    console.error('Erro no envio PIX:', err.response?.data || err.message);
    errorReason = err.response?.data?.mensagem
      || err.response?.data?.detail
      || err.message
      || 'Erro desconhecido';
  }

  // 4) Atualiza registro
  const withdrawal = withdrawals[withdrawalId];

  if (success) {
    withdrawal.status = 'completed';
    withdrawal.completedAt = Date.now();
    withdrawal.transactionId = e2eId;
    deductBalance(userId, amount);
    saveWithdrawals();

    // 5) Gera comprovante
    const date = new Date().toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const statementData = {
      amount,
      holderName,
      bankName,
      pixKey,
      pixKeyType,
      transactionId: e2eId,
      date
    };

    const imgBuffer = await generateStatementImage(statementData);

    const successText = t(ctx, 'withdraw_success', {
      amount: amount.toFixed(2).replace('.', ','),
      holder: holderName,
      bank: bankName,
      pixKey: maskPixKey(pixKey, pixKeyType),
      id: e2eId,
      date
    });

    // 6) EDITA a mensagem de status → mostra resultado + imagem
    try {
      await ctx.telegram.editMessageMedia(
        ctx.chat.id,
        statusMessage.message_id,
        undefined,
        {
          type: 'photo',
          media: { source: imgBuffer },
          caption: successText,
          parse_mode: 'Markdown'
        },
        Markup.inlineKeyboard([
          [Markup.button.callback(t(ctx, 'btn_pdf'), `aff:pdf:${withdrawalId}`)],
          [Markup.button.callback(t(ctx, 'btn_new_withdraw'), 'aff:withdraw')],
          [Markup.button.callback(t(ctx, 'btn_back_affiliate'), 'aff:panel')]
        ])
      );
    } catch (editErr) {
      console.error('Erro ao editar mensagem final:', editErr.message);
      // Fallback: envia nova mensagem
      await ctx.replyWithPhoto(
        { source: imgBuffer },
        {
          caption: successText,
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(t(ctx, 'btn_pdf'), `aff:pdf:${withdrawalId}`)],
            [Markup.button.callback(t(ctx, 'btn_new_withdraw'), 'aff:withdraw')]
          ])
        }
      );
    }

    await notifyAdmin(
      `💸 *Novo saque de afiliado!*\n\n` +
      `💵 Valor: R$ ${amount.toFixed(2).replace('.', ',')}\n` +
      `👤 ${holderName} (${bankName})\n` +
      `🔑 ${maskPixKey(pixKey, pixKeyType)}\n` +
      `🆔 \`${e2eId}\``
    );

    console.log(`✅ Saque ${withdrawalId} concluído: ${e2eId}`);

  } else {
    // Falha
    withdrawal.status = 'failed';
    withdrawal.failedAt = Date.now();
    withdrawal.errorReason = errorReason;
    saveWithdrawals();

    const failText = t(ctx, 'withdraw_failed', { reason: errorReason });

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        undefined,
        failText,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Tentar novamente', 'aff:withdraw')]
          ])
        }
      );
    } catch (e) {
      await ctx.reply(failText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Tentar novamente', 'aff:withdraw')]
        ])
      });
    }

    await notifyAdmin(`❌ *Saque falhou*\n\n${errorReason}\n\nID: \`${withdrawalId}\``);
  }
}

/* ============================================================
   VOLTAR AO PAINEL DE AFILIADO
   ============================================================ */
bot.action('aff:panel', async (ctx) => {
  const userId = ctx.from.id;
  const bal = getAffiliateBalance(userId);
  await ctx.answerCbQuery();

  try {
    await ctx.editMessageCaption(
      t(ctx, 'affiliate_title', {
        balance: bal.balance.toFixed(2).replace('.', ','),
        earned: bal.totalEarned.toFixed(2).replace('.', ',')
      }),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(ctx, 'btn_withdraw'), 'aff:withdraw')],
          [Markup.button.callback(t(ctx, 'btn_withdraw_history'), 'aff:history')]
        ])
      }
    );
  } catch (e) {}
});

/* ============================================================
   ENVIAR PDF DO COMPROVANTE
   ============================================================ */
bot.action(/^aff:pdf:(.+)$/, async (ctx) => {
  const withdrawalId = ctx.match[1];
  const w = withdrawals[withdrawalId];
  if (!w) return ctx.answerCbQuery('❌ Comprovante não encontrado', { show_alert: true });

  await ctx.answerCbQuery(t(ctx, 'pdf_sending'));

  try {
    const date = new Date(w.completedAt || w.createdAt).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const pdfBuffer = await generateStatementPDF({
      amount: w.amount,
      holderName: w.holderName,
      bankName: w.bankName,
      pixKey: w.pixKey,
      pixKeyType: w.pixKeyType,
      transactionId: w.transactionId || w.id,
      date
    });

    await ctx.replyWithDocument(
      { source: pdfBuffer, filename: `comprovante-${withdrawalId}.pdf` },
      { caption: t(ctx, 'pdf_ready'), parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Erro ao gerar PDF:', err);
    await ctx.reply('❌ Erro ao gerar PDF. Tente novamente.');
  }
});

/* ============================================================
   COMPRA — ESCOLHER MÉTODO
   ============================================================ */
bot.action(/^buy:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return ctx.answerCbQuery(t(ctx, 'product_not_found'), { show_alert: true });

  await ctx.answerCbQuery();

  const rows = [
    [Markup.button.callback(t(ctx, 'btn_pix'), `pay:pix:${product.id}`)],
    [Markup.button.callback(t(ctx, 'btn_stars'), `pay:stars:${product.id}`)],
    [Markup.button.callback(t(ctx, 'btn_back'), 'open_catalog')]
  ];

  const caption = t(ctx, 'choose_payment', {
    product: productName(product, ctx),
    price: formatPrice(product),
    stars: product.stars
  });

  try {
    await ctx.editMessageText(caption, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  } catch (e) {
    await ctx.reply(caption, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  }
});

/* ============================================================
   PIX (compra)
   ============================================================ */
bot.action(/^pay:pix:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return ctx.answerCbQuery(t(ctx, 'product_not_found'), { show_alert: true });

  await ctx.answerCbQuery(t(ctx, 'generating'));

  try {
    const idempotencyKey = `tg-${ctx.from.id}-${Date.now()}`;
    const rawUser = ctx.from.username || `user${ctx.from.id}`;
    const clean = rawUser.replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase() || `user${ctx.from.id}`;
    const email = `${clean}@example.com`;

    const result = await mpPayment.create({
      body: {
        transaction_amount: product.price,
        description: product.name,
        payment_method_id: 'pix',
        payer: { email, first_name: ctx.from.first_name || 'Cliente' },
        external_reference: idempotencyKey,
        notification_url: `${WEBHOOK_URL}/webhook`
      },
      requestOptions: { idempotencyKey }
    });

    const pixData = result.point_of_interaction?.transaction_data;
    if (!pixData?.qr_code) throw new Error('Sem QR Code');

    const paymentId = String(result.id);
    payments[paymentId] = {
      paymentId, chatId: ctx.chat.id, messageId: null,
      userId: ctx.from.id, method: 'pix',
      productId: product.id, productName: product.name,
      price: product.price, priceLabel: formatPrice(product),
      pixCode: pixData.qr_code, status: 'pending', createdAt: Date.now()
    };
    savePayments();

    const qrBuffer = await generateBeautifulQR(pixData.qr_code, false);
    const caption = t(ctx, 'pix_title', {
      product: productName(product, ctx),
      price: formatPrice(product)
    });

    const sent = await ctx.replyWithPhoto({ source: qrBuffer }, {
      caption, parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [{ text: t(ctx, 'btn_copy_pix'), copy_text: { text: pixData.qr_code } }],
        [Markup.button.callback(t(ctx, 'btn_check'), `check:${paymentId}`)],
        [Markup.button.callback(t(ctx, 'btn_cancel'), `cancel:${paymentId}`)]
      ])
    });

    payments[paymentId].messageId = sent.message_id;
    savePayments();

  } catch (err) {
    console.error('Erro PIX:', err);
    await ctx.reply(t(ctx, 'error_generic'));
  }
});

/* ============================================================
   STARS (compra)
   ============================================================ */
bot.action(/^pay:stars:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return ctx.answerCbQuery(t(ctx, 'product_not_found'), { show_alert: true });

  await ctx.answerCbQuery();

  try {
    const payload = JSON.stringify({
      kind: 'stars_purchase',
      userId: ctx.from.id,
      productId: product.id
    });

    await ctx.replyWithInvoice({
      title: productName(product, ctx),
      description: `${product.stars} Stars`,
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: `${product.stars} Stars`, amount: product.stars }]
    });
  } catch (err) {
    console.error('Erro Stars:', err);
    await ctx.reply(t(ctx, 'error_generic'));
  }
});

bot.on('pre_checkout_query', async (ctx) => {
  try { await ctx.answerPreCheckoutQuery(true); } catch (e) {}
});

bot.on('successful_payment', async (ctx) => {
  try {
    const sp = ctx.message.successful_payment;
    let payload = {};
    try { payload = JSON.parse(sp.invoice_payload); } catch (e) {}

    const product = PRODUCTS.find(p => p.id === payload.productId) || { name: 'Produto' };
    const lang = userLanguages.get(ctx.from.id) || 'pt';

    const paymentId = `stars_${sp.telegram_payment_charge_id || Date.now()}`;

    payments[paymentId] = {
      paymentId, chatId: ctx.chat.id, userId: ctx.from.id,
      method: 'stars', productId: product.id, productName: product.name,
      stars: sp.total_amount, priceLabel: `${sp.total_amount} Stars`,
      status: 'paid', createdAt: Date.now(), paidAt: Date.now()
    };
    savePayments();

    await ctx.reply(
      `✅ *Pagamento aprovado!*\n\n💳 ${product.name}\n⭐ ${sp.total_amount} Stars\n\n_Obrigado!_ 🎉`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Erro successful_payment:', err);
  }
});

/* ============================================================
   VERIFICAR PIX (compra)
   ============================================================ */
bot.action(/^check:(.+)$/, async (ctx) => {
  const paymentId = ctx.match[1];
  const info = payments[paymentId];
  if (!info) return ctx.answerCbQuery(t(ctx, 'payment_not_found'), { show_alert: true });
  if (info.status === 'paid') return ctx.answerCbQuery(t(ctx, 'already_paid'), { show_alert: true });

  await ctx.answerCbQuery(t(ctx, 'verifying'));

  try {
    const result = await mpPayment.get({ id: paymentId });
    const status = result.status;

    if (status === 'approved' || status === 'paid') {
      info.status = 'paid';
      info.paidAt = Date.now();
      savePayments();

      const newQr = await generateBeautifulQR(info.pixCode, true);
      const caption = t(ctx, 'paid_title', {
        product: info.productName,
        price: info.priceLabel,
        id: paymentId
      });

      try {
        await ctx.editMessageMedia(
          { type: 'photo', media: { source: newQr }, caption, parse_mode: 'Markdown' },
          Markup.inlineKeyboard([[Markup.button.callback(t(ctx, 'btn_paid'), 'noop')]])
        );
      } catch (e) {}
    } else if (status === 'pending' || status === 'in_process') {
      await ctx.answerCbQuery(t(ctx, 'still_pending'), { show_alert: true });
    } else {
      await ctx.answerCbQuery(`❌ ${status}`, { show_alert: true });
    }
  } catch (err) {
    console.error('Erro check:', err);
    await ctx.answerCbQuery(t(ctx, 'check_error'), { show_alert: true });
  }
});

/* ============================================================
   CANCELAR COMPRA
   ============================================================ */
bot.action(/^cancel:(.+)$/, async (ctx) => {
  const info = payments[ctx.match[1]];
  if (info && info.status !== 'paid') {
    info.status = 'cancelled';
    savePayments();
  }
  await ctx.answerCbQuery('❌');
  try {
    await ctx.editMessageCaption(t(ctx, 'cancelled_title'), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🛒 /catalogo', 'open_catalog')]])
    });
  } catch (e) {
    try {
      await ctx.editMessageText(t(ctx, 'cancelled_title'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🛒 /catalogo', 'open_catalog')]])
      });
    } catch (e2) {}
  }
});

/* ============================================================
   IDIOMA
   ============================================================ */
bot.action(/^lang:(pt|en)$/, async (ctx) => {
  userLanguages.set(ctx.from.id, ctx.match[1]);
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(t(ctx, 'language_set'), { parse_mode: 'Markdown' });
  } catch (e) {}
});

/* ============================================================
   UTILITÁRIOS
   ============================================================ */
bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

bot.action('open_catalog', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(t(ctx, 'catalog_title'),
      { parse_mode: 'Markdown', ...catalogKeyboard(ctx) });
  } catch (e) {
    await ctx.reply(t(ctx, 'catalog_title'),
      { parse_mode: 'Markdown', ...catalogKeyboard(ctx) });
  }
});

/* ============================================================
   EXPRESS SERVER
   ============================================================ */
const app = express();
app.use(express.json());

app.use(bot.webhookCallback('/telegram'));

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { type, data } = req.body;
    if (type === 'payment' && data?.id) {
      const paymentId = String(data.id);
      const info = payments[paymentId];
      if (info && info.status !== 'paid') {
        const result = await mpPayment.get({ id: paymentId });
        if (result.status === 'approved' || result.status === 'paid') {
          info.status = 'paid';
          info.paidAt = Date.now();
          savePayments();

          const lang = userLanguages.get(info.userId) || 'pt';
          const newQr = await generateBeautifulQR(info.pixCode, true);
          const caption = translate(lang, 'paid_title', {
            product: info.productName,
            price: info.priceLabel,
            id: paymentId
          });

          try {
            await bot.telegram.editMessageMedia(
              info.chatId, info.messageId, undefined,
              { type: 'photo', media: { source: newQr }, caption, parse_mode: 'Markdown' },
              Markup.inlineKeyboard([[Markup.button.callback(translate(lang, 'btn_paid'), 'noop')]])
            );
          } catch (e) {}
        }
      }
    }
  } catch (err) { console.error('Webhook erro:', err.message); }
});

app.get('/', (req, res) => res.send('🤖 Bot rodando!'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  payments: Object.keys(payments).length,
  withdrawals: Object.keys(withdrawals).length,
  efi: HAS_EFI,
  sandbox: EFI_SANDBOX
}));

/* ============================================================
   INIT
   ============================================================ */
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Webhook MP: ${WEBHOOK_URL}/webhook`);
  console.log(`🔗 Webhook Telegram: ${WEBHOOK_URL}/telegram`);
  console.log(`💸 Saque: ${HAS_EFI ? (EFI_SANDBOX ? 'SANDBOX Efí' : 'PRODUÇÃO Efí') : 'SIMULADO'}`);

  try {
    await bot.telegram.setWebhook(`${WEBHOOK_URL}/telegram`, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'callback_query', 'pre_checkout_query']
    });
    console.log(`✅ Webhook Telegram registrado`);
  } catch (err) {
    console.error('❌ Erro webhook TG:', err.message);
  }

  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Iniciar / Start' },
      { command: 'catalogo', description: 'Catálogo / Catalog' },
      { command: 'afiliado', description: 'Painel afiliado / Affiliate' },
      { command: 'meuspedidos', description: 'Meus pedidos / Orders' },
      { command: 'language', description: 'Idioma / Language' }
    ]);
  } catch (e) {}
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
