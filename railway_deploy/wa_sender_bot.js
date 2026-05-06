/**
 * WhatsApp Mass Sender Bot v2 — Botones
 * Controlado por Telegram · Powered by Baileys
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const QRCode      = require('qrcode');
const pino        = require('pino');
const https       = require('https');
const http        = require('http');

// ─── CONFIGURACIÓN ───────────────────────────────────────────────────────────
const TELEGRAM_TOKEN     = '8718387604:AAG6ICLoEKoV96G4zCTMq_9cA0lKKmWrcvs';
const AUTHORIZED_USER    = 'K11000K';
const MESSAGES_PER_CYCLE = 1500;
const CYCLE_HOURS        = 2;
const BATCH_SIZE         = 8;
const DELAY_MIN          = 2500;
const DELAY_MAX          = 6000;
const BATCH_DELAY_MIN    = 5000;
const BATCH_DELAY_MAX    = 10000;
// ─────────────────────────────────────────────────────────────────────────────

let waSocket     = null;
let waConnected  = false;
let contactList  = [];
let messageText  = '';
let isSending    = false;
let cycleTimer   = null;
let sentTotal    = 0;
let currentIndex = 0;

// Esperando input del usuario
let awaitingMessage  = false;
let awaitingContacts = false;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ─── UTILIDADES ──────────────────────────────────────────────────────────────
const sleep     = ms => new Promise(r => setTimeout(r, ms));
const randDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const isAuth    = msg => msg?.from?.username === AUTHORIZED_USER;

function safeSend(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, opts).catch(() => {});
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
  });
}

// ─── MENÚ PRINCIPAL (botones) ─────────────────────────────────────────────────
function mainMenu(chatId) {
  const waIcon  = waConnected ? '🟢' : '🔴';
  const sendIcon = isSending  ? '🟢' : '⚫';

  safeSend(chatId,
    `🤖 *WhatsApp Mass Sender*\n\n` +
    `${waIcon} WhatsApp: ${waConnected ? 'Conectado' : 'Desconectado'}\n` +
    `📋 Contactos: ${contactList.length}\n` +
    `💬 Mensaje: ${messageText ? '✅ Configurado' : '❌ Sin configurar'}\n` +
    `${sendIcon} Enviando: ${isSending ? 'Activo' : 'Parado'}\n` +
    `📤 Total enviados: ${sentTotal}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: `${waConnected ? '🔄 Reconectar WA' : '📱 Conectar WhatsApp'}`, callback_data: 'conectar' }
          ],
          [
            { text: '📂 Cargar lista .txt', callback_data: 'cargar' },
            { text: '✏️ Escribir mensaje',  callback_data: 'mensaje' }
          ],
          [
            { text: '▶️ Iniciar envío',     callback_data: 'iniciar' },
            { text: '⏹ Parar envío',        callback_data: 'parar'   }
          ],
          [
            { text: '📊 Ver estado',        callback_data: 'estado'  },
            { text: '🔄 Resetear',          callback_data: 'reset'   }
          ]
        ]
      }
    }
  );
}

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────
async function connectWhatsApp(chatId) {
  const { state, saveCreds } = await useMultiFileAuthState('./wa_session');

  waSocket = makeWASocket({
    auth:              state,
    logger:            pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser:           ['Chrome (Linux)', '', ''],
  });

  waSocket.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const buf = await QRCode.toBuffer(qr, { scale: 8 });
        await bot.sendPhoto(chatId, buf, {
          caption: '📱 *Escanea este QR con WhatsApp*\nAbre WhatsApp → Dispositivos vinculados → Vincular dispositivo',
          parse_mode: 'Markdown'
        });
      } catch {
        safeSend(chatId, '⚠️ No pude enviar el QR como imagen. Intenta /start de nuevo.');
      }
    }

    if (connection === 'open') {
      waConnected = true;
      safeSend(chatId, '✅ *WhatsApp conectado!*', { parse_mode: 'Markdown' });
      mainMenu(chatId);
    }

    if (connection === 'close') {
      waConnected = false;
      const code      = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      if (reconnect) {
        safeSend(chatId, '🔄 Reconectando...');
        setTimeout(() => connectWhatsApp(chatId), 5000);
      } else {
        safeSend(chatId, '❌ Sesión cerrada. Pulsa *Conectar WhatsApp* para volver a entrar.', { parse_mode: 'Markdown' });
        mainMenu(chatId);
      }
    }
  });

  waSocket.ev.on('creds.update', saveCreds);
}

// ─── ENVÍO ────────────────────────────────────────────────────────────────────
async function runSendCycle(chatId) {
  if (!waConnected)       { safeSend(chatId, '❌ WhatsApp no conectado.'); return; }
  if (!contactList.length){ safeSend(chatId, '❌ Lista vacía.');            return; }
  if (!messageText)       { safeSend(chatId, '❌ Sin mensaje.');            return; }

  if (currentIndex >= contactList.length) {
    currentIndex = 0;
    safeSend(chatId, '🔁 Lista completada, volviendo al inicio...');
  }

  const slice = contactList.slice(currentIndex, currentIndex + MESSAGES_PER_CYCLE);
  safeSend(chatId, `📤 Iniciando ciclo: *${slice.length} mensajes...*`, { parse_mode: 'Markdown' });

  let sent = 0, errors = 0;

  for (let i = 0; i < slice.length; i++) {
    if (!isSending) {
      safeSend(chatId, `⏹ Envío pausado.\n✅ ${sent} enviados | ❌ ${errors} errores`);
      break;
    }

    const raw = slice[i].trim().replace(/[\s\-\(\)]/g, '');
    if (!raw) continue;

    const jid = `${raw}@s.whatsapp.net`;
    try {
      await waSocket.sendMessage(jid, { text: messageText });
      sent++;
      currentIndex++;
    } catch {
      errors++;
      currentIndex++;
    }

    if ((i + 1) % BATCH_SIZE === 0) {
      await sleep(randDelay(BATCH_DELAY_MIN, BATCH_DELAY_MAX));
    } else {
      await sleep(randDelay(DELAY_MIN, DELAY_MAX));
    }
  }

  sentTotal += sent;
  safeSend(chatId,
    `✅ *Ciclo completado*\n📤 Enviados: ${sent}\n❌ Errores: ${errors}\n📊 Total: ${sentTotal}\n⏰ Próximo ciclo en ${CYCLE_HOURS}h`,
    { parse_mode: 'Markdown' }
  );
}

// ─── CALLBACKS DE BOTONES ─────────────────────────────────────────────────────
bot.on('callback_query', async query => {
  if (query.from.username !== AUTHORIZED_USER) {
    bot.answerCallbackQuery(query.id, { text: '⛔ No autorizado' });
    return;
  }

  const chatId = query.message.chat.id;
  bot.answerCallbackQuery(query.id);

  switch (query.data) {

    case 'conectar':
      safeSend(chatId, '🔄 Iniciando conexión con WhatsApp...');
      await connectWhatsApp(chatId);
      break;

    case 'cargar':
      awaitingContacts = true;
      awaitingMessage  = false;
      safeSend(chatId,
        '📎 *Envíame el archivo .txt* con los números (uno por línea).\n\nEjemplo:\n`34612345678`\n`34698765432`',
        { parse_mode: 'Markdown' }
      );
      break;

    case 'mensaje':
      awaitingMessage  = true;
      awaitingContacts = false;
      safeSend(chatId,
        '✏️ *Escribe el mensaje* que quieres enviar:',
        {
          parse_mode: 'Markdown',
          reply_markup: { force_reply: true }
        }
      );
      break;

    case 'iniciar':
      if (isSending) {
        safeSend(chatId, '⚠️ Ya hay un envío activo. Pulsa ⏹ Parar primero.');
        break;
      }
      if (!waConnected || !contactList.length || !messageText) {
        safeSend(chatId,
          `❌ Requisitos pendientes:\n` +
          `${waConnected       ? '✅' : '❌'} WhatsApp conectado\n` +
          `${contactList.length? '✅' : '❌'} Lista cargada (${contactList.length} contactos)\n` +
          `${messageText       ? '✅' : '❌'} Mensaje configurado`
        );
        break;
      }
      isSending = true;
      safeSend(chatId,
        `🚀 *Envío iniciado!*\n📋 ${contactList.length} contactos\n📨 ${MESSAGES_PER_CYCLE} mensajes/ciclo\n⏰ Cada ${CYCLE_HOURS}h`,
        { parse_mode: 'Markdown' }
      );
      runSendCycle(chatId);
      cycleTimer = setInterval(() => {
        if (isSending) runSendCycle(chatId);
      }, CYCLE_HOURS * 60 * 60 * 1000);
      break;

    case 'parar':
      isSending = false;
      if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
      safeSend(chatId, `⏹ *Envío detenido.*\n📊 Total enviados: ${sentTotal}`, { parse_mode: 'Markdown' });
      mainMenu(chatId);
      break;

    case 'estado':
      const preview = messageText
        ? `"${messageText.substring(0, 60)}${messageText.length > 60 ? '...' : ''}"`
        : '❌ Sin configurar';
      safeSend(chatId,
        `📊 *Estado actual:*\n\n` +
        `📱 WhatsApp: ${waConnected ? '🟢 Conectado' : '🔴 Desconectado'}\n` +
        `📋 Contactos: ${contactList.length}\n` +
        `📍 Posición: ${currentIndex} / ${contactList.length}\n` +
        `💬 Mensaje: ${preview}\n` +
        `🔄 Enviando: ${isSending ? '🟢 Activo' : '⚫ Parado'}\n` +
        `📤 Total enviados: ${sentTotal}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Volver al menú', callback_data: 'menu' }]]
          }
        }
      );
      break;

    case 'reset':
      currentIndex = 0;
      sentTotal    = 0;
      safeSend(chatId, '🔄 Índice y contador reiniciados a 0.');
      mainMenu(chatId);
      break;

    case 'menu':
      mainMenu(chatId);
      break;
  }
});

// ─── MENSAJES DE TEXTO (reply al bot) ────────────────────────────────────────
bot.on('message', async msg => {
  if (!isAuth(msg)) return;
  if (msg.document) return; // lo maneja el handler de documentos

  const text   = msg.text?.trim();
  const chatId = msg.chat.id;

  // Guardar mensaje cuando está esperando
  if (awaitingMessage && text && !text.startsWith('/')) {
    messageText     = text;
    awaitingMessage = false;
    safeSend(chatId, `✅ *Mensaje guardado:*\n\n"${messageText}"`, { parse_mode: 'Markdown' });
    mainMenu(chatId);
    return;
  }

  // /start y /menu → mostrar menú
  if (text === '/start' || text === '/menu') {
    mainMenu(chatId);
  }
});

// ─── RECEPCIÓN DE ARCHIVO TXT ─────────────────────────────────────────────────
bot.on('document', async msg => {
  if (!isAuth(msg)) return;

  const doc    = msg.document;
  const chatId = msg.chat.id;

  if (!doc.file_name?.endsWith('.txt') && !doc.mime_type?.includes('text')) {
    safeSend(chatId, '❌ Por favor envía un archivo .txt');
    return;
  }

  safeSend(chatId, '⏳ Descargando lista...');

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const content  = await downloadText(fileLink);
    const lines    = content.split('\n').map(l => l.trim()).filter(l => l.length >= 7);

    if (!lines.length) {
      safeSend(chatId, '❌ El archivo está vacío o los números no tienen formato correcto.');
      return;
    }

    contactList      = lines;
    currentIndex     = 0;
    awaitingContacts = false;

    safeSend(chatId,
      `✅ *Lista cargada!*\n\n📋 Contactos: ${contactList.length}\n👤 Primero: \`${contactList[0]}\`\n👤 Último: \`${contactList[contactList.length - 1]}\``,
      { parse_mode: 'Markdown' }
    );
    mainMenu(chatId);
  } catch (err) {
    safeSend(chatId, `❌ Error: ${err.message}`);
  }
});

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────
console.log('🤖 WhatsApp Mass Sender arrancado.');
