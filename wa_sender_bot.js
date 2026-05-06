/**
 * WhatsApp Mass Sender Bot v2 — Botones
 * Controlado por Telegram · Powered by Baileys
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const QRCode      = require('qrcode');
const pino        = require('pino');
const https       = require('https');
const http        = require('http');
const fs          = require('fs');
const path        = require('path');

// ─── CONFIGURACIÓN ───────────────────────────────────────────────────────────
const TELEGRAM_TOKEN     = process.env.TELEGRAM_TOKEN     || '8718387604:AAG6ICLoEKoV96G4zCTMq_9cA0lKKmWrcvs';
const AUTHORIZED_USER    = process.env.AUTHORIZED_USER    || 'K11000K';
const MESSAGES_PER_CYCLE = 1500;
const CYCLE_HOURS        = 2;
const BATCH_SIZE         = 8;
const DELAY_MIN          = 2500;
const DELAY_MAX          = 6000;
const BATCH_DELAY_MIN    = 5000;
const BATCH_DELAY_MAX    = 10000;
const SESSION_DIR        = './wa_session';
// ─────────────────────────────────────────────────────────────────────────────

let waSocket        = null;
let waConnected     = false;
let contactList     = [];
let messageText     = '';
let isSending       = false;
let cycleTimer      = null;
let sentTotal       = 0;
let currentIndex    = 0;
let reconnectCount  = 0;
let isConnecting    = false;   // evita llamadas simultáneas a connectWhatsApp
let qrShown         = false;   // para no spam de QR

// Esperando input del usuario
let awaitingMessage  = false;
let awaitingContacts = false;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ─── UTILIDADES ──────────────────────────────────────────────────────────────
const sleep     = ms => new Promise(r => setTimeout(r, ms));
const randDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const isAuth    = msg => msg?.from?.username === AUTHORIZED_USER;

function safeSend(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, opts).catch(e => console.error('safeSend error:', e.message));
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

// Borra la carpeta de sesión para forzar QR nuevo
function clearSession() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      console.log('Sesión borrada.');
    }
  } catch (e) {
    console.error('Error borrando sesión:', e.message);
  }
}

// Cierra el socket actual limpiamente
function closeSocket() {
  if (waSocket) {
    try { waSocket.ev.removeAllListeners(); } catch {}
    try { waSocket.end(); }                   catch {}
    waSocket = null;
  }
  waConnected = false;
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
            { text: `${waConnected ? '🔄 Reconectar WA' : '📱 Conectar WhatsApp'}`, callback_data: 'conectar' },
            { text: '🗑️ Borrar sesión', callback_data: 'borrar_sesion' }
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

// ─── ENVÍO QR (imagen + fallback texto) ──────────────────────────────────────
async function sendQR(chatId, qr) {
  // Intento 1: enviar como imagen
  try {
    const buf = await QRCode.toBuffer(qr, { scale: 8 });
    await bot.sendPhoto(chatId, buf, {
      caption: '📱 *Escanea este QR con WhatsApp*\nAbre WhatsApp → Dispositivos vinculados → Vincular dispositivo\n\n⚠️ _Tienes ~20 segundos antes de que expire_',
      parse_mode: 'Markdown'
    });
    console.log('QR enviado como imagen');
    return;
  } catch (e) {
    console.error('No se pudo enviar QR como imagen:', e.message);
  }

  // Intento 2: enviar como texto ASCII
  try {
    const qrText = await QRCode.toString(qr, { type: 'utf8', small: true });
    await safeSend(chatId,
      `📱 *Escanea este QR con WhatsApp:*\n\`\`\`\n${qrText}\n\`\`\`\n_(Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo)_`,
      { parse_mode: 'Markdown' }
    );
    console.log('QR enviado como texto');
  } catch (e2) {
    console.error('No se pudo enviar QR como texto:', e2.message);
    safeSend(chatId, '⚠️ No pude generar el QR. Intenta pulsar 🗑️ Borrar sesión y luego 📱 Conectar WhatsApp.');
  }
}

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────
async function connectWhatsApp(chatId) {
  // Evitar conexiones simultáneas
  if (isConnecting) {
    safeSend(chatId, '⏳ Ya hay una conexión en curso, espera un momento...');
    return;
  }

  isConnecting = true;
  qrShown      = false;
  closeSocket();

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    waSocket = makeWASocket({
      auth:              state,
      logger:            pino({ level: 'silent' }),
      printQRInTerminal: true,
      browser:           Browsers.ubuntu('Chrome'),
      connectTimeoutMs:  60_000,
      defaultQueryTimeoutMs: 60_000,
    });

    waSocket.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;

      // ── QR recibido ──────────────────────────────────────────────────────
      if (qr) {
        reconnectCount = 0;
        qrShown        = true;
        isConnecting   = false;
        console.log('QR generado, enviando a Telegram...');
        await sendQR(chatId, qr);
      }

      // ── Conexión abierta ─────────────────────────────────────────────────
      if (connection === 'open') {
        waConnected    = true;
        reconnectCount = 0;
        isConnecting   = false;
        qrShown        = false;
        safeSend(chatId, '✅ *WhatsApp conectado!*', { parse_mode: 'Markdown' });
        mainMenu(chatId);
      }

      // ── Conexión cerrada ─────────────────────────────────────────────────
      if (connection === 'close') {
        waConnected  = false;
        isConnecting = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const message    = lastDisconnect?.error?.message || '';
        console.log(`Conexión cerrada. Código: ${statusCode}, Mensaje: ${message}`);

        // Errores que significan "sesión inválida → necesita nuevo QR"
        const needsNewQR = (
          statusCode === DisconnectReason.loggedOut       ||   // 401 - cerró sesión
          statusCode === DisconnectReason.badSession      ||   // 500 - sesión corrupta
          statusCode === 403                              ||   // forbidden
          statusCode === 515                              ||   // stream error (sesión rota)
          statusCode === 440                              ||   // connectionReplaced
          message.includes('bad session')                ||
          message.includes('QR refs attempts')           ||
          message.includes('invalid')
        );

        if (needsNewQR) {
          console.log('Sesión inválida detectada, borrando y pidiendo QR nuevo...');
          safeSend(chatId, '🔄 Sesión inválida. Borrando y generando QR nuevo...');
          clearSession();
          await sleep(2000);
          connectWhatsApp(chatId);
          return;
        }

        // Errores transitorios de red → reintentar sin borrar sesión
        reconnectCount++;
        if (reconnectCount >= 5) {
          // Demasiados fallos de red → posible sesión corrupta, borrar y pedir QR
          reconnectCount = 0;
          console.log('Demasiados reintentos, borrando sesión y pidiendo QR nuevo...');
          safeSend(chatId, '⚠️ Demasiados fallos de red. Borrando sesión y generando QR nuevo...');
          clearSession();
          await sleep(3000);
          connectWhatsApp(chatId);
        } else {
          safeSend(chatId, `🔄 Reconectando... (intento ${reconnectCount}/5)`);
          await sleep(5000 * reconnectCount); // backoff progresivo
          connectWhatsApp(chatId);
        }
      }
    });

    waSocket.ev.on('creds.update', saveCreds);

  } catch (err) {
    isConnecting = false;
    console.error('Error en connectWhatsApp:', err.message);
    safeSend(chatId, `❌ Error al conectar: ${err.message}\n\nIntenta *🗑️ Borrar sesión* y vuelve a conectar.`, { parse_mode: 'Markdown' });
  }
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
      reconnectCount = 0;
      await connectWhatsApp(chatId);
      break;

    case 'borrar_sesion':
      closeSocket();
      reconnectCount = 0;
      isConnecting   = false;
      clearSession();
      safeSend(chatId, '🗑️ Sesión borrada. Ahora pulsa *📱 Conectar WhatsApp* para escanear el QR.', { parse_mode: 'Markdown' });
      mainMenu(chatId);
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

    case 'estado': {
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
    }

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
  if (msg.document) return;

  const text   = msg.text?.trim();
  const chatId = msg.chat.id;

  if (awaitingMessage && text && !text.startsWith('/')) {
    messageText     = text;
    awaitingMessage = false;
    safeSend(chatId, `✅ *Mensaje guardado:*\n\n"${messageText}"`, { parse_mode: 'Markdown' });
    mainMenu(chatId);
    return;
  }

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
