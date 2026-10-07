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
const BOT_TOKEN      = process.env.BOT_TOKEN;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const WEBHOOK_URL    = process.env.WEBHOOK_URL || 'http://localhost:3000';
const PORT           = process.env.PORT || 3000;

if (!BOT_TOKEN)       { console.error('❌ BOT_TOKEN não configurado'); process.exit(1); }
if (!MP_ACCESS_TOKEN) { console.error('❌ MP_ACCESS_TOKEN não configurado'); process.exit(1); }

const bot      = new Telegraf(BOT_TOKEN);
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const mpPayment = new Payment(mpClient);

/* ============================================================
   CATÁLOGO DE PRODUTOS
   👉 Aqui você edita seus produtos
   ============================================================ */
const PRODUCTS = [
  {
    id: 'teste',
    name: 'Produto Teste',
    description: 'Produto de teste — R$ 0,01',
    price: 0.01
  },
  {
    id: 'p1',
    name: 'Produto A',
    description: 'Descrição do produto A',
    price: 5.00
  },
  {
    id: 'p2',
    name: 'Produto B',
    description: 'Descrição do produto B',
    price: 15.00
  },
  {
    id: 'p3',
    name: 'Produto C',
    description: 'Descrição do produto C',
    price: 30.00
  }
];

/* ============================================================
   ARMAZENAMENTO SIMPLES (arquivo JSON)
   ============================================================ */
const DATA_DIR   = path.join(__dirname, 'data');
const DATA_FILE  = path.join(DATA_DIR, 'payments.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let payments = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    payments = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Erro ao ler payments.json:', e.message);
  payments = {};
}

function savePayments() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(payments, null, 2));
  } catch (e) {
    console.error('Erro ao salvar payments.json:', e.message);
  }
}

/* ============================================================
   GERAR QR CODE
   paid = true → adiciona bolinha verde no meio com ✓
   ============================================================ */
async function generateQR(pixCode, paid = false) {
  // QR code base
  const qrBuffer = await QRCode.toBuffer(pixCode, {
    width: 600,
    margin: 2,
    errorCorrectionLevel: 'H', // alta correção para aguentar a bolinha
    color: { dark: '#000000', light: '#ffffff' }
  });

  if (!paid) return qrBuffer;

  // Bolinha verde com check no centro
  const size = 140;
  const circleSvg = Buffer.from(`
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 6}"
              fill="#10b981" stroke="#ffffff" stroke-width="6"/>
      <path d="M ${size*0.28} ${size*0.52}
               L ${size*0.44} ${size*0.68}
               L ${size*0.72} ${size*0.34}"
            stroke="#ffffff" stroke-width="10" fill="none"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `);

  return await sharp(qrBuffer)
    .composite([{ input: circleSvg, gravity: 'center' }])
    .png()
    .toBuffer();
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
    `👋 Olá, ${name}!\n\n` +
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
  const userId = ctx.from.id;
  const meus = Object.values(payments).filter(p => p.chatId === ctx.chat.id);

  if (!meus.length) {
    return ctx.reply('Você ainda não fez nenhum pedido. Use /catalogo para começar.');
  }

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

  if (!product) {
    return ctx.answerCbQuery('❌ Produto não encontrado', { show_alert: true });
  }

  await ctx.answerCbQuery('⏳ Gerando PIX...');

  try {
    const idempotencyKey = `tg-${ctx.from.id}-${Date.now()}`;

    const result = await mpPayment.create({
      body: {
        transaction_amount: product.price,
        description: product.name,
        payment_method_id: 'pix',
        payer: {
          email: `user${ctx.from.id}@telegram.pix`,
          first_name: ctx.from.first_name || 'Cliente'
        },
        external_reference: idempotencyKey,
        notification_url: `${WEBHOOK_URL}/webhook`
      },
      requestOptions: { idempotencyKey }
    });

    const pixData = result.point_of_interaction?.transaction_data;
    if (!pixData || !pixData.qr_code) {
      throw new Error('Resposta sem QR Code do Mercado Pago');
    }

    // Salva o pagamento
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

    // Gera o QR Code SEM bolinha
    const qrBuffer = await generateQR(pixData.qr_code, false);

    const caption =
      `💳 *${product.name}*\n` +
      `💰 Valor: *R$ ${product.price.toFixed(2).replace('.', ',')}*\n\n` +
      `📱 Escaneie o QR Code ou copie o código PIX abaixo:\n\n` +
      `\`${pixData.qr_code}\`\n\n` +
      `⏳ Status: *Aguardando pagamento*`;

    const sent = await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⏳ Aguardando pagamento', `check:${result.id}`)],
          [Markup.button.callback('❌ Cancelar', `cancel:${result.id}`)]
        ])
      }
    );

    // Atualiza o messageId
    payments[String(result.id)].messageId = sent.message_id;
    savePayments();

  } catch (err) {
    console.error('Erro ao criar PIX:', err);
    await ctx.reply('❌ Erro ao gerar o PIX. Tente novamente em alguns segundos.');
  }
});

/* ============================================================
   VERIFICAR PAGAMENTO — EDITA A MENSAGEM (não envia nova)
   ============================================================ */
bot.action(/^check:(.+)$/, async (ctx) => {
  const paymentId = ctx.match[1];
  const info      = payments[paymentId];

  if (!info) {
    return ctx.answerCbQuery('❌ Pagamento não encontrado', { show_alert: true });
  }

  if (info.status === 'paid') {
    return ctx.answerCbQuery('✅ Este pagamento já foi confirmado!', { show_alert: true });
  }

  await ctx.answerCbQuery('🔍 Verificando pagamento...');

  try {
    const result = await mpPayment.get({ id: paymentId });
    const status = result.status;

    if (status === 'approved' || status === 'paid') {
      // Marca como pago
      info.status = 'paid';
      info.paidAt = Date.now();
      savePayments();

      // Gera QR com bolinha verde
      const newQr = await generateQR(info.pixCode, true);

      const newCaption =
        `✅ *Pagamento aprovado!*\n\n` +
        `💳 Produto: *${info.productName}*\n` +
        `💰 Valor pago: *R$ ${info.price.toFixed(2).replace('.', ',')}*\n` +
        `🆔 ID: \`${paymentId}\`\n\n` +
        `_Obrigado pela compra!_ 🎉`;

      // EDITA A MENSAGEM EXISTENTE (não envia nova)
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
        '⏳ Ainda não identificamos o pagamento.\nAguarde alguns segundos e toque novamente.',
        { show_alert: true }
      );
    } else {
      await ctx.answerCbQuery(
        `❌ Pagamento com status: ${status}. Tente novamente.`,
        { show_alert: true }
      );
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
  } catch (e) { /* ignora */ }
});

/* ============================================================
   BOTÕES UTILITÁRIOS
   ============================================================ */
bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action('open_catalog', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '🛒 *Catálogo*\n\nEscolha um produto:',
    { parse_mode: 'Markdown', ...catalogKeyboard() }
  );
});

/* ============================================================
   WEBHOOK DO MERCADO PAGO
   (atualiza automaticamente quando o pagamento cai)
   ============================================================ */
const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido

  try {
    const { type, data } = req.body;

    if (type === 'payment' && data && data.id) {
      const paymentId = String(data.id);
      const info      = payments[paymentId];

      if (info && info.status !== 'paid') {
        const result = await mpPayment.get({ id: paymentId });

        if (result.status === 'approved' || result.status === 'paid') {
          info.status = 'paid';
          info.paidAt = Date.now();
          savePayments();

          // Gera QR com bolinha
          const newQr = await generateQR(info.pixCode, true);

          const newCaption =
            `✅ *Pagamento aprovado!*\n\n` +
            `💳 Produto: *${info.productName}*\n` +
            `💰 Valor pago: *R$ ${info.price.toFixed(2).replace('.', ',')}*\n` +
            `🆔 ID: \`${paymentId}\`\n\n` +
            `_Obrigado pela compra!_ 🎉`;

          // Edita a mensagem via API do Telegram
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
            console.log(`✅ Webhook: pagamento ${paymentId} confirmado e mensagem editada.`);
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

app.get('/', (req, res) => {
  res.send('🤖 Bot rodando com sucesso!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', payments: Object.keys(payments).length });
});

/* ============================================================
   INICIALIZAÇÃO
   ============================================================ */
app.listen(PORT, () => {
  console.log(`🚀 Servidor web rodando na porta ${PORT}`);
  console.log(`🔗 Webhook: ${WEBHOOK_URL}/webhook`);
});

bot.launch()
  .then(() => console.log('🤖 Bot do Telegram iniciado!'))
  .catch(err => console.error('❌ Erro ao iniciar bot:', err));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
