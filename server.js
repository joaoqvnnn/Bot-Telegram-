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
const express = require('express');
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

if (!BOT_TOKEN)       { console.error('❌ BOT_TOKEN não configurado'); process.exit(1); }
if (!MP_ACCESS_TOKEN) { console.error('❌ MP_ACCESS_TOKEN não configurado'); process.exit(1); }

const bot       = new Telegraf(BOT_TOKEN);
const mpClient  = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const mpPayment = new Payment(mpClient);

/* ============================================================
   TRADUÇÕES (PT + EN)
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
    stars_title: '⭐ *{product}*\n\nVocê escolheu pagar com *{stars} Stars*.\n\nToque abaixo para abrir a fatura do Telegram:',
    btn_pay_stars: '⭐ Pagar {stars} Stars',
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
    stars_success: '✅ *Pagamento com Stars confirmado!*\n\n💳 Produto: *{product}*\n⭐ Stars: *{stars}*\n🆔 `{id}`\n\n_Obrigado pela compra!_ 🎉'
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
    stars_title: '⭐ *{product}*\n\nYou chose to pay with *{stars} Stars*.\n\nTap below to open the Telegram invoice:',
    btn_pay_stars: '⭐ Pay {stars} Stars',
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
    stars_success: '✅ *Stars payment confirmed!*\n\n💳 Product: *{product}*\n⭐ Stars: *{stars}*\n🆔 `{id}`\n\n_Thank you for your purchase!_ 🎉'
  }
};

/* ============================================================
   PRODUTOS
   price     = valor em R$ (para PIX)
   stars     = quantidade de Stars (mínimo 1)
   ============================================================ */
const PRODUCTS = [
  { id: 'teste', name: 'Produto Teste', nameEn: 'Test Product', price: 0.01, stars: 1  },
  { id: 'p1',    name: 'Produto A',     nameEn: 'Product A',    price: 5.00, stars: 50 },
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
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let payments = {};
try {
  if (fs.existsSync(DATA_FILE)) payments = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) { payments = {}; }

function savePayments() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(payments, null, 2)); } catch (e){}
}

function buildPayerEmail(ctx) {
  const rawUser = ctx.from.username || `user${ctx.from.id}`;
  const clean = String(rawUser).replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase() || `user${ctx.from.id}`;
  return `${clean}@example.com`;
}

/* ============================================================
   QR CODE BONITO
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
      const radius = (moduleSize / 2) * 0.92;
      dots += `<circle cx="${x}" cy="${y}" r="${radius}"/>`;
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
        <circle cx="${circleSize/2}" cy="${circleSize/2}" r="${circleSize/2 - 4}"
                fill="#10b981" stroke="#ffffff" stroke-width="5"/>
        <path d="M ${circleSize*0.30} ${circleSize*0.52}
                 L ${circleSize*0.45} ${circleSize*0.67}
                 L ${circleSize*0.72} ${circleSize*0.34}"
              stroke="#ffffff" stroke-width="6" fill="none"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `);
    png = await sharp(png)
      .composite([{ input: circleSvg, gravity: 'center' }])
      .png()
      .toBuffer();
  }

  return png;
}

/* ============================================================
   CATÁLOGO (teclado)
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
   NOTIFICAR ADMIN
   ============================================================ */
async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Erro ao notificar admin:', e.message);
  }
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
  await ctx.reply(
    t(ctx, 'catalog_title'),
    { parse_mode: 'Markdown', ...catalogKeyboard(ctx) }
  );
});

bot.command('language', async (ctx) => {
  await ctx.reply(
    t(ctx, 'choose_language'),
    Markup.inlineKeyboard([
      [Markup.button.callback('🇧🇷 Português', 'lang:pt')],
      [Markup.button.callback('🇺🇸 English', 'lang:en')]
    ])
  );
});

bot.command('meuspedidos', async (ctx) => {
  const meus = Object.values(payments).filter(p => p.chatId === ctx.chat.id);
  if (!meus.length) return ctx.reply(t(ctx, 'no_orders'));

  const lista = meus
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)
    .map(p => {
      const icon = p.status === 'paid' ? '✅' : p.status === 'cancelled' ? '❌' : '⏳';
      const method = p.method === 'stars' ? '⭐ Stars' : '⚡ PIX';
      const priceLabel = p.method === 'stars' ? `${p.stars} Stars` : p.priceLabel;
      return `${icon} *${p.productName}* — ${priceLabel} (${method})`;
    })
    .join('\n');

  await ctx.reply(t(ctx, 'my_orders', { list: lista }), { parse_mode: 'Markdown' });
});

/* ============================================================
   TROCAR IDIOMA
   ============================================================ */
bot.action(/^lang:(pt|en)$/, async (ctx) => {
  const lang = ctx.match[1];
  userLanguages.set(ctx.from.id, lang);
  await ctx.answerCbQuery();
  await ctx.editMessageText(t(ctx, 'language_set'), { parse_mode: 'Markdown' });
});

/* ============================================================
   COMPRAR → ESCOLHER MÉTODO
   ============================================================ */
bot.action(/^buy:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product   = PRODUCTS.find(p => p.id === productId);
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
    await ctx.editMessageText(caption, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows)
    });
  } catch (e) {
    await ctx.reply(caption, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows)
    });
  }
});

/* ============================================================
   PAGAR COM PIX
   ============================================================ */
bot.action(/^pay:pix:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product   = PRODUCTS.find(p => p.id === productId);
  if (!product) return ctx.answerCbQuery(t(ctx, 'product_not_found'), { show_alert: true });

  await ctx.answerCbQuery(t(ctx, 'generating'));

  try {
    const idempotencyKey = `tg-${ctx.from.id}-${Date.now()}`;

    const result = await mpPayment.create({
      body: {
        transaction_amount: product.price,
        description: product.name,
        payment_method_id: 'pix',
        payer: {
          email: buildPayerEmail(ctx),
          first_name: ctx.from.first_name || 'Cliente'
        },
        external_reference: idempotencyKey,
        notification_url: `${WEBHOOK_URL}/webhook`
      },
      requestOptions: { idempotencyKey }
    });

    const pixData = result.point_of_interaction?.transaction_data;
    if (!pixData || !pixData.qr_code) throw new Error('Resposta sem QR Code do Mercado Pago');

    const paymentId = String(result.id);

    payments[paymentId] = {
      paymentId,
      chatId: ctx.chat.id,
      messageId: null,
      userId: ctx.from.id,
      method: 'pix',
      productId: product.id,
      productName: product.name,
      price: product.price,
      priceLabel: formatPrice(product),
      pixCode: pixData.qr_code,
      status: 'pending',
      createdAt: Date.now()
    };
    savePayments();

    const qrBuffer = await generateBeautifulQR(pixData.qr_code, false);
    const caption = t(ctx, 'pix_title', {
      product: productName(product, ctx),
      price: formatPrice(product)
    });

    const buttons = [
      [{ text: t(ctx, 'btn_copy_pix'), copy_text: { text: pixData.qr_code } }],
      [Markup.button.callback(t(ctx, 'btn_check'), `check:${paymentId}`)],
      [Markup.button.callback(t(ctx, 'btn_cancel'), `cancel:${paymentId}`)]
    ];

    const sent = await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
      }
    );

    payments[paymentId].messageId = sent.message_id;
    savePayments();

  } catch (err) {
    console.error('Erro ao criar PIX:', err);
    await ctx.reply(t(ctx, 'error_generic'));
  }
});

/* ============================================================
   PAGAR COM STARS (Telegram Stars)
   ============================================================ */
bot.action(/^pay:stars:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product   = PRODUCTS.find(p => p.id === productId);
  if (!product) return ctx.answerCbQuery(t(ctx, 'product_not_found'), { show_alert: true });

  await ctx.answerCbQuery();

  try {
    const payload = JSON.stringify({
      kind: 'stars_purchase',
      userId: ctx.from.id,
      productId: product.id,
      timestamp: Date.now()
    });

    // Envia a fatura nativa do Telegram com currency XTR (Stars)
    await ctx.replyWithInvoice({
      title: productName(product, ctx),
      description: t(ctx, 'stars_title', {
        product: productName(product, ctx),
        stars: product.stars
      }).replace(/\*/g, ''), // Remove markdown da descrição
      payload: payload,
      provider_token: '',           // vazio para Stars
      currency: 'XTR',              // código oficial das Telegram Stars
      prices: [
        { label: `${product.stars} Stars`, amount: product.stars }
      ],
      start_parameter: `buy_${product.id}`
    });

  } catch (err) {
    console.error('Erro ao enviar fatura Stars:', err);
    await ctx.reply(t(ctx, 'error_generic'));
  }
});

/* ============================================================
   PRÉ-CHECKOUT (obrigatório para Stars)
   ============================================================ */
bot.on('pre_checkout_query', async (ctx) => {
  try {
    await ctx.answerPreCheckoutQuery(true);
  } catch (err) {
    console.error('Erro no pre_checkout:', err);
  }
});

/* ============================================================
   PAGAMENTO STAR CONFIRMADO
   ============================================================ */
bot.on('successful_payment', async (ctx) => {
  try {
    const sp = ctx.message.successful_payment;
    let payload = {};
    try { payload = JSON.parse(sp.invoice_payload); } catch (e) {}

    const productId = payload.productId;
    const product = PRODUCTS.find(p => p.id === productId) || { name: 'Produto', nameEn: 'Product' };
    const lang = userLanguages.get(ctx.from.id) || 'pt';

    const paymentId = `stars_${sp.telegram_payment_charge_id || Date.now()}`;

    payments[paymentId] = {
      paymentId,
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      method: 'stars',
      productId: product.id,
      productName: product.name,
      stars: sp.total_amount,
      priceLabel: `${sp.total_amount} Stars`,
      status: 'paid',
      createdAt: Date.now(),
      paidAt: Date.now(),
      chargeId: sp.telegram_payment_charge_id
    };
    savePayments();

    const caption = translate(lang, 'stars_success', {
      product: product.nameEn && lang === 'en' ? product.nameEn : product.name,
      stars: sp.total_amount,
      id: paymentId
    });

    await ctx.reply(caption, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(translate(lang, 'btn_paid'), 'noop')]
      ])
    });

    await notifyAdmin(
      `⭐ *Nova venda com Stars!*\n\n` +
      `💳 ${product.name}\n` +
      `⭐ ${sp.total_amount} Stars\n` +
      `👤 @${ctx.from.username || ctx.from.id}\n` +
      `🆔 \`${paymentId}\``
    );

    console.log(`✅ Stars: pagamento ${paymentId} confirmado (${sp.total_amount} stars)`);

  } catch (err) {
    console.error('Erro ao processar successful_payment:', err);
  }
});

/* ============================================================
   VERIFICAR PAGAMENTO PIX
   ============================================================ */
bot.action(/^check:(.+)$/, async (ctx) => {
  const paymentId = ctx.match[1];
  const info      = payments[paymentId];
  if (!info) return ctx.answerCbQuery(t(ctx, 'payment_not_found'), { show_alert: true });

  if (info.status === 'paid') {
    return ctx.answerCbQuery(t(ctx, 'already_paid'), { show_alert: true });
  }

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
          {
            type: 'photo',
            media: { source: newQr },
            caption,
            parse_mode: 'Markdown'
          },
          Markup.inlineKeyboard([
            [Markup.button.callback(t(ctx, 'btn_paid'), 'noop')]
          ])
        );
      } catch (editErr) {
        console.error('Erro ao editar mensagem:', editErr.message);
      }

      await notifyAdmin(
        `💰 *Nova venda (PIX)!*\n\n💳 ${info.productName}\n💰 ${info.priceLabel}\n🆔 \`${paymentId}\``
      );

    } else if (status === 'pending' || status === 'in_process') {
      await ctx.answerCbQuery(t(ctx, 'still_pending'), { show_alert: true });
    } else {
      await ctx.answerCbQuery(`❌ Status: ${status}`, { show_alert: true });
    }

  } catch (err) {
    console.error('Erro ao verificar:', err);
    await ctx.answerCbQuery(t(ctx, 'check_error'), { show_alert: true });
  }
});

/* ============================================================
   CANCELAR
   ============================================================ */
bot.action(/^cancel:(.+)$/, async (ctx) => {
  const paymentId = ctx.match[1];
  const info      = payments[paymentId];
  if (info && info.status !== 'paid') {
    info.status = 'cancelled';
    savePayments();
  }

  await ctx.answerCbQuery('❌');

  try {
    await ctx.editMessageCaption(t(ctx, 'cancelled_title'), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🛒 /catalogo', 'open_catalog')]
      ])
    });
  } catch (e) {
    try {
      await ctx.editMessageText(t(ctx, 'cancelled_title'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛒 /catalogo', 'open_catalog')]
        ])
      });
    } catch (e2) {}
  }
});

/* ============================================================
   AÇÕES UTILITÁRIAS
   ============================================================ */
bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

bot.action('open_catalog', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(
      t(ctx, 'catalog_title'),
      { parse_mode: 'Markdown', ...catalogKeyboard(ctx) }
    );
  } catch (e) {
    await ctx.reply(
      t(ctx, 'catalog_title'),
      { parse_mode: 'Markdown', ...catalogKeyboard(ctx) }
    );
  }
});

/* ============================================================
   SERVIDOR EXPRESS
   ============================================================ */
const app = express();
app.use(express.json());

/* Webhook do Telegram */
app.use(bot.webhookCallback('/telegram'));

/* Webhook do Mercado Pago (PIX) */
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const { type, data } = req.body;
    if (type === 'payment' && data && data.id) {
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
              info.chatId,
              info.messageId,
              undefined,
              {
                type: 'photo',
                media: { source: newQr },
                caption,
                parse_mode: 'Markdown'
              },
              Markup.inlineKeyboard([
                [Markup.button.callback(translate(lang, 'btn_paid'), 'noop')]
              ])
            );
            console.log(`✅ Webhook MP: pagamento ${paymentId} confirmado.`);

            await notifyAdmin(
              `💰 *Nova venda (PIX via webhook)!*\n\n💳 ${info.productName}\n💰 ${info.priceLabel}\n🆔 \`${paymentId}\``
            );
          } catch (editErr) {
            console.error('Erro ao editar via webhook:', editErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('Erro no webhook MP:', err.message);
  }
});

/* Rotas auxiliares */
app.get('/', (req, res) => res.send('🤖 Bot rodando!'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  payments: Object.keys(payments).length,
  stars: true,
  pix: true
}));

/* ============================================================
   INICIALIZAÇÃO (WEBHOOK MODE)
   ============================================================ */
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Webhook MP:  ${WEBHOOK_URL}/webhook`);
  console.log(`🔗 Webhook Telegram: ${WEBHOOK_URL}/telegram`);

  try {
    const telegramWebhookUrl = `${WEBHOOK_URL}/telegram`;
    await bot.telegram.setWebhook(telegramWebhookUrl, {
      drop_pending_updates: true,
      allowed_updates: [
        'message',
        'callback_query',
        'pre_checkout_query',
        'inline_query'
      ]
    });
    console.log(`✅ Webhook do Telegram registrado: ${telegramWebhookUrl}`);
  } catch (err) {
    console.error('❌ Erro ao registrar webhook do Telegram:', err.message);
  }

  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Iniciar / Start' },
      { command: 'catalogo', description: 'Ver catálogo / Catalog' },
      { command: 'meuspedidos', description: 'Meus pedidos / My orders' },
      { command: 'language', description: 'Trocar idioma / Change language' }
    ]);
  } catch (e) {
    console.error('Erro ao configurar comandos:', e.message);
  }
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
