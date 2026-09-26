/**
 * Ayantha x MD — ALL IN ONE
 * Pair site + Admin + Owner bot (.alive / .creact / .crjid)
 * Single process · Single Heroku/GitHub deploy
 */
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const pino = require('pino');
const mongoose = require('mongoose');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

// ================= CONFIG =================
const PORT = process.env.PORT || 8000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shashen123';
const OWNER_NUMBERS = ['94753305985', '94761746579', '94761160057'];
const BOT_NAME = 'Ayantha x MD';
const OWNER_NAME = 'Shashen Dev </>';
const CHANNEL_JID = '120363430562861980@newsletter';
const ALIVE_IMG = 'https://h.uguu.se/JHKxVkuQ.jpg';
const PREFIX = '.';
const AUTO_REACT_EMOJIS = ['❤️', '🤍', '💛', '💚', '💙', '🔥', '⚡'];
const autoReactChannels = new Set([CHANNEL_JID]);

const MONGODB_URL = process.env.MONGODB_URL || '';

const adminTokens = new Set();
const activePair = new Map();
const activeSockets = new Set();
global.activeSockets = activeSockets;

// ================= DB =================
const SessionSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    creds: { type: Object, default: null },
    added_at: { type: Date, default: Date.now }
  },
  { collection: 'sessions' }
);
const Session = mongoose.models.Session || mongoose.model('Session', SessionSchema);

function mongoReady() {
  return mongoose.connection.readyState === 1;
}

function requireMongo(req, res, next) {
  if (!mongoReady()) {
    return res.status(503).json({ ok: false, error: 'MongoDB is not connected yet. Please try again shortly.' });
  }
  next();
}

const SignalSchema = new mongoose.Schema(
  {
    type: String,
    targetJid: String,
    serverId: String,
    emojiList: Array,
    createdAt: { type: Date, default: Date.now, expires: 60 }
  },
  { strict: false }
);
const Signal = mongoose.models.Signal || mongoose.model('Signal', SignalSchema);

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}
function isOwnerNumber(num) {
  const d = digitsOnly(num);
  return OWNER_NUMBERS.some((o) => d === o || d.endsWith(o) || o.endsWith(d));
}
function box(title, lines) {
  return `╭━━━〔 ${title} 〕━━━⬣\n${lines.map((l) => `┃ ${l}`).join('\n')}\n╰━━━━━━━━━━━━━━━━━━━━⬣`;
}
function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

// ================= EXPRESS (PAIR + ADMIN) =================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/ping', (req, res) => {
  res.json({
    ok: true,
    active: activePair.size,
    bots: activeSockets.size,
    mongo: mongoose.connection.readyState === 1,
    uptime: formatUptime(process.uptime())
  });
});

app.get('/api/stats', async (req, res) => {
  try {
    const count = await Session.countDocuments();
    res.json({
      online: true,
      sessions: count,
      active: activePair.size,
      bots: activeSockets.size,
      uptime: formatUptime(process.uptime()),
      mongo: mongoose.connection.readyState === 1,
      bot: BOT_NAME,
      owner: OWNER_NAME
    });
  } catch {
    res.json({ online: true, sessions: 0, active: 0, bots: activeSockets.size, uptime: formatUptime(process.uptime()), mongo: false });
  }
});

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if ((req.body || {}).password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.add(token);
    return res.json({ ok: true, token });
  }
  res.status(401).json({ ok: false, error: 'Wrong password' });
});

app.get('/api/admin/sessions', requireAdmin, async (req, res) => {
  try {
    const sessions = await Session.find({}, { number: 1, added_at: 1, _id: 0 }).sort({ added_at: -1 }).limit(200);
    res.json({
      ok: true,
      sessions,
      uptime: formatUptime(process.uptime()),
      active: activePair.size,
      bots: activeSockets.size,
      mongo: mongoose.connection.readyState === 1
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/admin/sessions', requireAdmin, async (req, res) => {
  try {
    const { number } = req.body || {};
    if (!number) return res.status(400).json({ ok: false, error: 'number required' });
    await Session.deleteOne({ number });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----- PAIR CODE -----
app.get('/code', requireMongo, async (req, res) => {
  const number = String(req.query.number || '').replace(/[^0-9]/g, '');
  const force = ['1', 'true', 'yes'].includes(String(req.query.force || '').toLowerCase());

  if (!number || number.length < 10 || number.length > 15) {
    return res.status(400).json({ error: 'Enter number with country code (e.g. 94761746579)' });
  }

  // Owner-only pairing
  if (!isOwnerNumber(number)) {
    return res.status(403).json({ error: 'Only owner numbers can pair on this gateway' });
  }

  if (activePair.has(number)) {
    if (!force) {
      return res.json({ status: 'already_connected', message: 'Session active. Retry with force=1.' });
    }
    try {
      const prev = activePair.get(number);
      try { prev.socket?.end?.(); } catch (_) {}
      try { fs.removeSync(prev.sessionPath); } catch (_) {}
      activePair.delete(number);
    } catch (_) {}
  }

  const sessionPath = path.join(os.tmpdir(), `wa_pair_${number}_${Date.now()}`);
  try { fs.removeSync(sessionPath); } catch (_) {}
  fs.ensureDirSync(sessionPath);

  let responded = false;
  const sendOnce = (status, body) => {
    if (responded || res.headersSent) return;
    responded = true;
    res.status(status).json(body);
  };

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });
    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    socket.ev.on('creds.update', saveCreds);
    activePair.set(number, { socket, sessionPath });

    socket.ev.on('connection.update', async (u) => {
      const { connection } = u;
      if (connection === 'open') {
        try {
          await delay(3000);
          const credsPath = path.join(sessionPath, 'creds.json');
          if (!fs.existsSync(credsPath)) return;
          const userJid = jidNormalizedUser(socket.user.id);
          const sessionJson = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
          await Session.findOneAndUpdate(
            { number: userJid },
            { number: userJid, creds: sessionJson, added_at: new Date() },
            { upsert: true }
          );
          console.log('[PAIR OK]', userJid);
          try {
            await socket.sendMessage(userJid, {
              text:
                box(`💚 ${BOT_NAME}`, ['Status: Linked ✅', `User: ${userJid.split('@')[0]}`]) +
                `\n\n` +
                box('🌱 ꜱʜᴀꜱʜᴇɴ ɴᴏᴛᴇ', ['➤ Bot connecting...', '➤ ᴘᴏᴡᴇʀᴅ ʙʏ ꜱʜᴀꜱʜᴇɴ ᴅᴇᴠ </>'])
            });
          } catch (_) {}
          // start bot session in same process
          setTimeout(() => connectToWA({ number: userJid, creds: sessionJson }), 2000);
        } catch (e) {
          console.error('[PAIR] save:', e.message);
        } finally {
          await delay(1500);
          try { socket.end?.(); } catch (_) {}
          try { fs.removeSync(sessionPath); } catch (_) {}
          activePair.delete(number);
        }
      }
      if (connection === 'close') {
        activePair.delete(number);
        try { fs.removeSync(sessionPath); } catch (_) {}
      }
    });

    if (socket.authState?.creds?.registered) {
      return sendOnce(200, { status: 'already_registered', message: 'Already registered. Unlink device and try again.' });
    }

    let code = null;
    let errMsg = null;
    for (let i = 0; i < 3; i++) {
      try {
        await delay(i === 0 ? 1200 : 1800);
        code = await socket.requestPairingCode(number);
        if (code) break;
      } catch (e) {
        errMsg = e?.message || String(e);
      }
    }

    if (!code) {
      try { socket.end?.(); } catch (_) {}
      try { fs.removeSync(sessionPath); } catch (_) {}
      activePair.delete(number);
      return sendOnce(503, { error: 'Failed to generate code. Wait 10s and try again.', detail: errMsg });
    }

    const raw = String(code).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const pretty = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
    return sendOnce(200, {
      code: raw,
      pretty,
      message: 'WhatsApp → Linked devices → Link with phone number'
    });
  } catch (e) {
    activePair.delete(number);
    try { fs.removeSync(sessionPath); } catch (_) {}
    return sendOnce(503, { error: 'Service unavailable', detail: e.message });
  }
});

// ================= BOT =================
async function connectToWA(sessionData) {
  const userNumber = String(sessionData.number).split('@')[0];
  if (!isOwnerNumber(userNumber)) {
    console.log('[SKIP] Non-owner:', userNumber);
    return;
  }

  for (const s of activeSockets) {
    try {
      const id = digitsOnly(s.user?.id || '');
      if (id && (id.includes(userNumber) || userNumber.includes(id))) {
        console.log('[SKIP] Already active:', userNumber);
        return;
      }
    } catch (_) {}
  }

  const authPath = path.join(__dirname, 'auth', userNumber);
  fs.ensureDirSync(authPath);
  try {
    fs.writeFileSync(path.join(authPath, 'creds.json'), JSON.stringify(sessionData.creds));
  } catch (_) {}

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  let version;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch (_) {}

  const logger = pino({ level: 'silent' });
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);
  activeSockets.add(sock);

  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'open') {
      console.log('✅ Bot connected:', userNumber);
      try { await sock.newsletterFollow(CHANNEL_JID); } catch (_) {}
    }
    if (u.connection === 'close') {
      activeSockets.delete(sock);
      const code = u.lastDisconnect?.error?.output?.statusCode;
      console.log('❌ Bot closed', userNumber, code);
      if (code === 401 || code === 403) {
        try {
          await Session.deleteOne({ number: sessionData.number });
          fs.removeSync(authPath);
        } catch (_) {}
      } else {
        setTimeout(() => connectToWA(sessionData), 8000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const mek = messages?.[0];
    if (!mek?.message || mek.key.remoteJid === 'status@broadcast') return;
    const from = mek.key.remoteJid;

    // Auto react on channel posts
    if (from?.endsWith('@newsletter') && autoReactChannels.has(from)) {
      try {
        const serverId = mek.key?.server_id || mek.key?.id;
        if (serverId && sock.newsletterReactMessage) {
          const emoji = AUTO_REACT_EMOJIS[Math.floor(Math.random() * AUTO_REACT_EMOJIS.length)];
          await sock.newsletterReactMessage(from, String(serverId), emoji);
        }
      } catch (_) {}
      return;
    }

    const sender = mek.key.fromMe
      ? digitsOnly(sock.user?.id)
      : digitsOnly(mek.key.participant || mek.key.remoteJid);
    if (!mek.key.fromMe && !isOwnerNumber(sender)) return;

    let body =
      mek.message.conversation ||
      mek.message.extendedTextMessage?.text ||
      mek.message.imageMessage?.caption ||
      '';
    body = (body || '').trim();
    if (!body.startsWith(PREFIX)) return;

    const args = body.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (args.shift() || '').toLowerCase();
    const q = args.join(' ').trim();

    const reply = async (text) => {
      await sock.sendMessage(
        from,
        {
          text,
          contextInfo: {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
              newsletterJid: CHANNEL_JID,
              newsletterName: 'ꜱʜᴀꜱʜᴇɴ ᴅᴇᴠ </> 🇱🇰',
              serverMessageId: 100
            }
          }
        },
        { quoted: mek }
      );
    };

    if (cmd === 'menu') {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const date = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
      const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const memTotal = Math.round(os.totalmem() / 1024 / 1024);
      const memFree = Math.round(os.freemem() / 1024 / 1024);
      const memUsed = Math.max(0, memTotal - memFree);

      const menuText =
        box('💚 ꜱʜᴀꜱʜᴇɴ ᴍᴅ', [
          `👤 ᴜꜱᴇʀ   : ${isOwnerNumber(sender) ? 'Owner' : (mek.pushName || 'User')}`,
          `👑 ᴏᴡɴᴇʀ  : ${OWNER_NAME}`,
          `📅 ᴅᴀᴛᴇ   : ${date}`,
          `⏰ ᴛɪᴍᴇ   : ${time}`,
          `⚡ ꜱᴛᴀᴛᴜꜱ : ᴏɴʟɪɴᴇ`,
          `💾 ʀᴀᴍ    : ${memUsed} ᴍʙ`,
          `💻 ᴍᴇᴍ    : ${memUsed}/${memTotal} ᴍʙ`,
          `⏳ ᴜᴘᴛɪᴍᴇ : ${formatUptime(process.uptime())}`
        ]) + '\n\n' +
        box('🌿 ᴄᴏᴍᴍᴀɴᴅꜱ', [
          '➊ 💚 `.alive`',
          '➋ 💚 `.crjid`',
          '➌ 💚 `.autoreact`',
          '➍ 💚 `.setchannel`',
          '➎ 💚 `.creact`',
          '➏ 💚 `.chr`',
          '➐ 💚 `.massreact`'
        ]) + '\n\n' +
        box('🌱 ꜱʜᴀꜱʜᴇɴ ɴᴏᴛᴇ', [
          '➤ ᴏɴʟʏ ᴄᴜʀʀᴇɴᴛ ʙᴀꜱᴇ ᴄᴏᴍᴍᴀɴᴅꜱ',
          '➤ ᴄʟᴇᴀɴ • ꜱᴍᴏᴏᴛʜ • ᴘᴏᴡᴇʀꜰᴜʟ 💚',
          '➤ ᴘᴏᴡᴇʀᴅ ʙʏ ꜱʜᴀꜱʜᴇɴ ᴅᴇᴠ </>'
        ]);

      return reply(menuText);
    }

    if (cmd === 'alive' || cmd === 'bot') {
      const up = process.uptime();
      const h = Math.floor(up / 3600);
      const m = Math.floor((up % 3600) / 60);
      const s = Math.floor(up % 60);
      const caption =
        box(`💚 ${BOT_NAME}`, [
          `👤 User   : Owner`,
          `👑 Owner  : ${OWNER_NAME}`,
          `⚡ Status : ONLINE`,
          `⏳ Uptime : ${h}h ${m}m ${s}s`,
          `💾 Mode   : All-in-One`,
          `📢 AutoCH : ${autoReactChannels.size}`
        ]) +
        `\n\n` +
        box('🌱 ꜱʜᴀꜱʜᴇɴ ɴᴏᴛᴇ', [
          '➤ .alive',
          '➤ .creact link, qty, emoji',
          '➤ .crjid channel-link/jid',
          '➤ ᴘᴏᴡᴇʀᴅ ʙʏ ꜱʜᴀꜱʜᴇɴ ᴅᴇᴠ </>'
        ]);
      try {
        await sock.sendMessage(
          from,
          {
            image: { url: ALIVE_IMG },
            caption,
            contextInfo: {
              forwardingScore: 999,
              isForwarded: true,
              forwardedNewsletterMessageInfo: {
                newsletterJid: CHANNEL_JID,
                newsletterName: 'ꜱʜᴀꜱʜᴇɴ ᴅᴇᴠ </> 🇱🇰',
                serverMessageId: 100
              }
            }
          },
          { quoted: mek }
        );
      } catch {
        await reply(caption);
      }
      return;
    }

    if (cmd === 'crjid' || cmd === 'autoreact' || cmd === 'setchannel') {
      if (!q) {
        const list = [...autoReactChannels];
        return reply(
          box('💚 ᴄʀᴊɪᴅ', [
            'Usage: .crjid <channel-link or jid>',
            'Active:',
            ...(list.length ? list.map((j) => `• ${j}`) : ['• (none)'])
          ])
        );
      }
      try {
        let targetJid = '';
        const input = q.trim();
        if (input.includes('@newsletter')) {
          targetJid = input.replace(/\s/g, '');
        } else if (input.includes('whatsapp.com/channel/')) {
          const inviteCode = input.split('channel/')[1].split(/[/?\s]/)[0];
          const meta = await sock.newsletterMetadata('invite', inviteCode);
          if (!meta?.id) return reply(box('❌ ᴇʀʀᴏʀ', ['Could not fetch JID']));
          targetJid = meta.id;
          try { await sock.newsletterFollow(targetJid); } catch (_) {}
        } else {
          return reply(box('❌ ᴇʀʀᴏʀ', ['Use channel link or @newsletter JID']));
        }
        autoReactChannels.add(targetJid);
        return reply(
          box('✅ ᴀᴜᴛᴏ ʀᴇᴀᴄᴛ ᴏɴ', [
            `JID: ${targetJid}`,
            `Total: ${autoReactChannels.size}`
          ])
        );
      } catch (e) {
        return reply(box('❌ ᴇʀʀᴏʀ', [e.message || String(e)]));
      }
    }

    if (cmd === 'creact' || cmd === 'chr' || cmd === 'massreact') {
      if (!q || !q.includes(',')) {
        return reply(
          box('💚 ᴄʀᴇᴀᴄᴛ', [
            'Usage: .creact [post-link], [qty], [emoji]',
            'Ex: .creact https://whatsapp.com/channel/xxx/10, 20, ❤️'
          ])
        );
      }
      try {
        const parts = q.split(',');
        const linkPart = parts[0].trim();
        const qtyNum = parseInt(parts[1]?.trim(), 10) || 20;
        const emojis = parts.slice(2).map((e) => e.trim()).filter(Boolean);
        if (!linkPart.includes('whatsapp.com/channel/')) {
          return reply(box('❌ ᴇʀʀᴏʀ', ['Channel post link required']));
        }
        if (qtyNum < 1 || qtyNum > 200) {
          return reply(box('⚠️ ʟɪᴍɪᴛ', ['Qty 1 – 200']));
        }
        const urlParts = linkPart.split('/').filter(Boolean);
        const chIdx = urlParts.findIndex((p) => p === 'channel');
        const inviteCode = urlParts[chIdx + 1];
        let serverId = urlParts[chIdx + 2] || urlParts[urlParts.length - 1];
        const metadata = await sock.newsletterMetadata('invite', inviteCode);
        const targetJid = metadata?.id;
        if (!targetJid) return reply(box('❌ ᴇʀʀᴏʀ', ['Could not resolve JID']));
        if (isNaN(Number(serverId))) serverId = '100';
        const emojiList = emojis.length ? emojis : ['❤️'];
        autoReactChannels.add(targetJid);
        let ok = 0, fail = 0;
        for (let i = 0; i < qtyNum; i++) {
          try {
            await sock.newsletterReactMessage(targetJid, String(serverId), emojiList[i % emojiList.length]);
            ok++;
          } catch (_) {
            fail++;
          }
          await delay(400);
        }
        try {
          await Signal.create({ type: 'react', targetJid, serverId: String(serverId), emojiList, timestamp: Date.now() });
        } catch (_) {}
        return reply(
          box('🚀 ᴄʀᴇᴀᴄᴛ', [
            `Target: ${metadata.name || targetJid}`,
            `OK: ${ok} · Fail: ${fail}`,
            `Emojis: ${emojiList.join(' ')}`
          ])
        );
      } catch (e) {
        return reply(box('❌ ᴇʀʀᴏʀ', [e.message || String(e)]));
      }
    }
  });
}

let signalWatcher = null;
let sessionWatcher = null;
let bootstrappedSessions = false;
let mongoRetryTimer = null;

async function startChangeWatchers() {
  if (!mongoReady()) return;

  if (!signalWatcher) {
    try {
      signalWatcher = Signal.watch();
      signalWatcher.on('change', async (data) => {
        if (data.operationType !== 'insert') return;
        const doc = data.fullDocument;
        if (doc?.type !== 'react' || !doc.targetJid?.includes('@newsletter')) return;
        const emojis = doc.emojiList?.length ? doc.emojiList : ['❤️'];
        for (const sock of activeSockets) {
          try {
            if (sock?.newsletterReactMessage) {
              await sock.newsletterReactMessage(
                doc.targetJid,
                String(doc.serverId || '100'),
                emojis[Math.floor(Math.random() * emojis.length)]
              );
            }
          } catch (_) {}
        }
      });
      signalWatcher.on('error', (e) => {
        console.error('[Mongo Signal Watcher]', e.message);
        try { signalWatcher.close(); } catch (_) {}
        signalWatcher = null;
      });
    } catch (e) {
      console.error('[Mongo Signal Watcher Start]', e.message);
      signalWatcher = null;
    }
  }

  if (!sessionWatcher) {
    try {
      sessionWatcher = Session.watch();
      sessionWatcher.on('change', async (data) => {
        try {
          if (data.operationType !== 'insert' && data.operationType !== 'update') return;
          const sessionData =
            data.operationType === 'insert'
              ? data.fullDocument
              : await Session.findById(data.documentKey._id);
          if (!sessionData?.creds) return;
          const num = String(sessionData.number).split('@')[0];
          if (!isOwnerNumber(num)) return;
          console.log('♻️ Owner session update:', num);
          await connectToWA(sessionData);
        } catch (e) {
          console.error('[Session Watcher]', e.message);
        }
      });
      sessionWatcher.on('error', (e) => {
        console.error('[Mongo Session Watcher]', e.message);
        try { sessionWatcher.close(); } catch (_) {}
        sessionWatcher = null;
      });
    } catch (e) {
      console.error('[Mongo Session Watcher Start]', e.message);
      sessionWatcher = null;
    }
  }
}

async function loadSessions() {
  if (!mongoReady()) return;
  try {
    const sessions = await Session.find({});
    console.log(`📂 Sessions: ${sessions.length}`);
    for (const s of sessions) {
      if (s.creds) await connectToWA(s);
    }
    await startChangeWatchers();
    bootstrappedSessions = true;
  } catch (e) {
    console.error('[Mongo] Failed to load sessions:', e.message);
  }
}

async function connectMongo() {
  if (!MONGODB_URL) {
    console.error('❌ MONGODB_URL is missing. Add it in Railway → Variables.');
    return false;
  }

  try {
    await mongoose.connect(MONGODB_URL, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10
    });
    console.log('✅ MongoDB connected');
    await loadSessions();
    return true;
  } catch (e) {
    console.error('❌ MongoDB connection failed:', e.message);
    return false;
  }
}

mongoose.connection.on('disconnected', () => {
  console.error('⚠️ MongoDB disconnected');
  bootstrappedSessions = false;
  try { signalWatcher?.close(); } catch (_) {}
  try { sessionWatcher?.close(); } catch (_) {}
  signalWatcher = null;
  sessionWatcher = null;
});

mongoose.connection.on('error', (e) => {
  console.error('⚠️ MongoDB error:', e.message);
});

async function start() {
  // Start HTTP immediately. This prevents Railway 502s when MongoDB is temporarily unavailable.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Pair + Admin → 0.0.0.0:${PORT}`);
    console.log(`🤖 Bot worker running in same process`);
    console.log(`🩺 Health → /ping`);
  });

  const connected = await connectMongo();
  if (!connected) {
    console.log('🔄 MongoDB retry loop started (15s)');
    mongoRetryTimer = setInterval(async () => {
      if (mongoReady()) return;
      const ok = await connectMongo();
      if (ok && mongoRetryTimer) {
        clearInterval(mongoRetryTimer);
        mongoRetryTimer = null;
      }
    }, 15000);
  }
}

start().catch((e) => {
  console.error('FATAL START ERROR', e);
  // Keep the HTTP process alive so Railway can report the failure instead of returning 502.
});
