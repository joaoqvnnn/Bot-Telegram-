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

if (!BOT_TOKEN)       { console.error('❌ BOT_TOKEN não configurado'); process.exit(1); }
if (!MP_ACCESS_TOKEN) { console.error('❌ MP_ACCESS_TOKEN não configurado'); process.exit(1); }

const bot       = new Telegraf(BOT_TOKEN);
const mpClient  = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const mpPayment = new Payment(mpClient);

/* ============================================================
   CATÁLOGO
   ============================================================ */
const PRODUCTS = [
  { id: 'teste', name: 'Produto Teste', description: 'Produto de teste', price: 0.01 },
  { id: 'p1',    name: 'Produto A',     description: 'Descrição A',       price: 5.00 },
  { id: 'p2',    name: 'Produto B',     description: 'Descrição B',       price: 15.00 },
  { id: 'p3',    name: 'Produto C',     description: 'Descrição C',       price: 30.00 }
];

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

/* ============================================================
   E-MAIL DO PAGADOR (obrigatório e válido para o Mercado Pago)
   ============================================================ */
function buildPayerEmail(ctx) {
  const rawUser = ctx.from.username || `user${ctx.from.id}`;
  const clean = String(rawUser).replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase() || `user${ctx.from.id}`;
  return `${clean}@example.com`;
}

/* ============================================================
   🎨 QR CODE BONITO
   - Pontinhos arredondados
   - 3 "olhos" (finder patterns) estilizados
   - Fundo branco limpo
   - Bolinha verde ✅ no centro quando pago
   ============================================================ */
async function generateBeautifulQR(text, paid = false) {
  // 1) Matriz do QR
  const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
  const modules = qr.modules;
  const size = modules.size;
  const data = modules.data;

  // 2) Configurações visuais
  const moduleSize = 14;   // px por módulo
  const padding    = 3;    // margem em módulos
  const totalModules = size + padding * 2;
  const totalSize = totalModules * moduleSize;

  const fgColor = '#0f172a';  // azul-escuro quase preto (mais elegante)
  const bgColor = '#ffffff';

  // 3) Verifica se faz parte dos "olhos" (finder patterns nos 3 cantos)
  function inFinder(row, col) {
    const tl = row < 7 && col < 7;
    const tr = row < 7 && col >= size - 7;
    const bl = row >= size - 7 && col < 7;
    return tl || tr || bl;
  }

  // 4) Constrói os pontinhos
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

  // 5) "Olhos" arredondados (Finder Patterns)
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

  // 6) SVG completo com cantos arredondados
  const radius = 24;
  const svg = `
    <svg width="${totalSize}" height="${totalSize}" viewBox="0 0 ${totalSize} ${totalSize}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${totalSize}" height="${totalSize}" rx="${radius}" fill="${bgColor}"/>
      <g fill="${fgColor}">${dots}</g>
      ${finders}
    </svg>
  `;

  let png = await sharp(Buffer.from(svg)).png().toBuffer();

  // 7) Se pago → bolinha verde com check no meio
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
   TECLADO DO CATÁLOGO
   ============================================================ */
function catalogKeyboard() {
  const rows = PRODUCTS.map(p => [
    Markup.button.callback(
      `${p.name} — R$ ${p.price.toFixed(2).replace('.', ',')}`,
      `buy:${p.id}`
    )
  ]);
  return Markup.inlineKeyboard(rows);
}

/* ============================================================
   COMANDOS
   ============================================================ */
bot.start(async (ctx) => {
  const name = ctx.from.first_name || 'cliente';
  await ctx.reply(
    `👋 Olá, *${name}*!\n\n` +
    `🛒 *Bem-vindo à nossa lojinha!*\n\n` +
    `Escolha um produto abaixo para gerar o PIX:`,
    { parse_mode: 'Markdown', ...catalogKeyboard() }
  );
});

bot.command('catalogo', async (ctx) => {
  await ctx.reply(
    '🛒 *Catálogo*\n\nEscolha um produto:',
    { parse_mode: 'Markdown', ...catalogKeyboard() }
  );
});

bot.command('meuspedidos', async (ctx) => {
  const meus = Object.values(payments).filter(p => p.chatId === ctx.chat.id);
  if (!meus.length) return ctx.reply('Você ainda não fez nenhum pedido. Use /catalogo para começar.');

  const lista = meus
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)
    .map(p => {
      const icon = p.status === 'paid' ? '✅' : p.status === 'cancelled' ? '❌' : '⏳';
      return `${icon} *${p.productName}* — R$ ${p.price.toFixed(2).replace('.', ',')}`;
    })
    .join('\n');

  await ctx.reply(`📋 *Seus últimos pedidos*\n\n${lista}`, { parse_mode: 'Markdown' });
});

/* ============================================================
   COMPRAR — GERA PIX E ENVIA QR CODE
   ============================================================ */
bot.action(/^buy:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product   = PRODUCTS.find(p => p.id === productId);
  if (!product) return ctx.answerCbQuery('❌ Produto não encontrado', { show_alert: true });

  await ctx.answerCbQuery('⏳ Gerando PIX...');

  try {
    const idempotencyKey = `tg-${ctx.from.id}-${Date.now()}`;

    const result =Data await mpPayment.create =({
      body: {
        result transaction_amount: product.price,
        description: product.p.name,
        payment_method_id: 'ointpix',
        payer: {
          email: buildPayerEmail(ctx),
          first_name: ctx.from.first_name || 'Cliente'
        },
        external_reference: idempotencyKey,
        notification_url: `${WEBHOOK_URL}/webhook`
      },
      requestOptions: { idempotencyKey }
    });

    const pix_of_interaction?.transaction_data;
    if (!pixData || !pixData.qr_code) throw new Error('Resposta sem QR Code do Mercado Pago');

    payments[String(result.id)] = {
      paymentId: String(result.id),
      chatId: ctx.chat.id,
      messageId: null,
      productId: product.id,
      productName: product.name,
      price: product.price,
      pixCode: pixData.qr_code,
      status: 'pending',
      createdAt: Date.now()
    };
    savePayments();

    // QR bonito (sem bolinha)
    const qrBuffer = await generateBeautifulQR(pixData.qr_code, false);

    const caption =
      `💳 *${product.name}*\n` +
      `💰 Valor: *R$ ${product.price.toFixed(2).replace('.', ',')}*\n\n` +
      `📱 Escaneie o QR Code ou use o botão "Copiar PIX" abaixo.\n\n` +
      `⏳ *Aguardando pagamento*`;

    // ⚡ Botão "Copiar PIX" silencioso (copy_text)
    const buttons = [
      [{ text: '📋 Copiar PIX', copy_text: { text: pixData.qr_code } }],
      [Markup.button.callback('🔄 Verificar pagamento', `check:${result.id}`)],
      [Markup.button.callback('❌ Cancelar', `cancel:${result.id}`)]
    ];

    const sent = await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
      }
    );

    payments[String(result.id)].messageId = sent.message_id;
    savePayments();

  } catch (err) {
    console.error('Erro ao criar PIX:', err);
    await ctx.reply('❌ Erro ao gerar o PIX. Tente novamente em alguns segundos.');
  }
});

/* ============================================================
   VERIFICAR PAGAMENTO — EDITA A MENSAGEM
   ============================================================ */
bot.action(/^check:(.+)$/, async (ctx) => {
  const paymentId = ctx.match[1];
  const info      = payments[paymentId];
  if (!info) return ctx.answerCbQuery('❌ Pagamento não encontrado', { show_alert: true });

  if (info.status === 'paid') {
    return ctx.answerCbQuery('✅ Este pagamento já foi confirmado!', { show_alert: true });
  }

  await ctx.answerCbQuery('🔍 Verificando pagamento...');

  try {
    const result = await mpPayment.get({ id: paymentId });
    const status = result.status;

    if (status === 'approved' || status === 'paid') {
      info.status = 'paid';
      info.paidAt = Date.now();
      savePayments();

      const newQr = await generateBeautifulQR(info.pixCode, true);

      const newCaption =
        `✅ *Pagamento aprovado!*\n\n` +
        `💳 Produto: *${info.productName}*\n` +
        `💰 Valor: *R$ ${info.price.toFixed(2).replace('.', ',')}*\n` +
        `🆔 \`${paymentId}\`\n\n` +
        `_Obrigado pela compra!_ 🎉`;

      try {
        await ctx.editMessageMedia(
          {
            type: 'photo',
            media: { source: newQr },
            caption: newCaption,
            parse_mode: 'Markdown'
          },
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ Pago', 'noop')]
          ])
        );
      } catch (editErr) {
        console.error('Erro ao editar mensagem:', editErr.message);
      }

    } else if (status === 'pending' || status === 'in_process') {
      await ctx.answerCbQuery(
        '⏳ Ainda não identificamos o pagamento.\nAguarde alguns segundos e tente novamente.',
        { show_alert: true }
      );
    } else {
      await ctx.answerCbQuery(`❌ Status: ${status}`, { show_alert: true });
    }

  } catch (err) {
    console.error('Erro ao verificar:', err);
    await ctx.answerCbQuery('❌ Erro ao verificar. Tente novamente.', { show_alert: true });
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

  await ctx.answerCbQuery('Compra cancelada');

  try {
    await ctx.editMessageCaption(
      `❌ *Compra cancelada*\n\nSe quiser tentar novamente, use /catalogo.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Ver catálogo', 'open_catalog')]
        ])
      }
    );
  } catch (e) {}
});

bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

bot.action('open_catalog', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🛒 *Catálogo*\n\nEscolha um produto:',
    { parse_mode: 'Markdown', ...catalogKeyboard() });
});

/* ============================================================
   WEBHOOK DO MERCADO PAGO
   ============================================================ */
const app = express();
app.use(express.json());

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

          const newQr = await generateBeautifulQR(info.pixCode, true);

          const newCaption =
            `✅ *Pagamento aprovado!*\n\n` +
            `💳 Produto: *${info.productName}*\n` +
            `💰 Valor: *R$ ${info.price.toFixed(2).replace('.', ',')}*\n` +
            `🆔 \`${paymentId}\`\n\n` +
            `_Obrigado pela compra!_ 🎉`;

          try {
            await bot.telegram.editMessageMedia(
              info.chatId,
              info.messageId,
              undefined,
              {
                type: 'photo',
                media: { source: newQr },
                caption: newCaption,
                parse_mode: 'Markdown'
              },
              Markup.inlineKeyboard([
                [Markup.button.callback('✅ Pago', 'noop')]
              ])
            );
            console.log(`✅ Webhook: pagamento ${paymentId} confirmado.`);
          } catch (editErr) {
            console.error('Erro ao editar via webhook:', editErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
});

app.get('/', (req, res) => res.send('🤖 Bot rodando!'));
app.get('/health', (req, res) => res.json({ status:'ok', payments: Object.keys(payments).length }));

/* ============================================================
   INIT
   ============================================================ */
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Webhook: ${WEBHOOK_URL}/webhook`);
});

bot.launch()
  .then(() => console.log('🤖 Bot do Telegram iniciado!'))
  .catch(err => console.error('❌ Erro ao iniciar bot:', err));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
