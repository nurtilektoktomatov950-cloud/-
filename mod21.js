// Бот-модератор чатов + личные команды через Telegram Business + inline-РП. Cloudflare Worker + D1.
// Переменные: BOT_TOKEN (секрет), WEBHOOK_SECRET (секрет, латиница/цифры). Привязка D1: DB.

const FIVE_H = 5 * 3600;
const WARN_LIMIT = 3;
const MAX_SPAM = 20;

async function tg(env, method, body) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nameOf = (u) => ((u.first_name || '') + (u.last_name ? ' ' + u.last_name : '')).trim() || (u.username ? '@' + u.username : 'id' + u.id);
const link = (u) => '<a href="tg://user?id=' + u.id + '">' + esc(nameOf(u)) + '</a>';

// ---------- схема ----------
let schemaDone = false;
async function ensureSchema(env) {
  if (schemaDone) return;
  const q = [
    'CREATE TABLE IF NOT EXISTS m_users (chat_id INTEGER, user_id INTEGER, username TEXT, name TEXT, seen INTEGER, PRIMARY KEY (chat_id, user_id))',
    'CREATE INDEX IF NOT EXISTS m_users_un ON m_users (chat_id, username)',
    'CREATE TABLE IF NOT EXISTS m_warns (chat_id INTEGER, user_id INTEGER, n INTEGER, PRIMARY KEY (chat_id, user_id))',
    'CREATE TABLE IF NOT EXISTS m_chats (chat_id INTEGER PRIMARY KEY, rules TEXT)',
    'CREATE TABLE IF NOT EXISTS m_set (chat_id INTEGER PRIMARY KEY, links INTEGER DEFAULT 0, beg INTEGER DEFAULT 0, bots INTEGER DEFAULT 0)',
    'CREATE TABLE IF NOT EXISTS m_mutes (chat_id INTEGER, user_id INTEGER, until INTEGER, name TEXT, PRIMARY KEY (chat_id, user_id))',
    'CREATE TABLE IF NOT EXISTS m_bmsgs (conn_id TEXT, chat_id INTEGER, mid INTEGER, from_id INTEGER, name TEXT, username TEXT, text TEXT, mtype TEXT, file_id TEXT, date INTEGER, PRIMARY KEY (conn_id, chat_id, mid))',
    'CREATE TABLE IF NOT EXISTS m_bconn (id TEXT PRIMARY KEY, owner_id INTEGER, user_chat_id INTEGER, enabled INTEGER)',
    'CREATE TABLE IF NOT EXISTS m_bmutes (conn_id TEXT, chat_id INTEGER, until INTEGER, PRIMARY KEY (conn_id, chat_id))',
    'CREATE TABLE IF NOT EXISTS m_stat (chat_id INTEGER, user_id INTEGER, xp INTEGER DEFAULT 0, msgs INTEGER DEFAULT 0, ts0 INTEGER, ts1 INTEGER, PRIMARY KEY (chat_id, user_id))',
    'CREATE INDEX IF NOT EXISTS m_stat_xp ON m_stat (chat_id, xp)',
    'CREATE TABLE IF NOT EXISTS m_marry (chat_id INTEGER, a INTEGER, b INTEGER, since INTEGER, PRIMARY KEY (chat_id, a, b))',
    'CREATE TABLE IF NOT EXISTS m_ido (id TEXT PRIMARY KEY, ts INTEGER)',
    'CREATE TABLE IF NOT EXISTS m_inl (user_id INTEGER PRIMARY KEY, name TEXT, username TEXT)',
    'CREATE TABLE IF NOT EXISTS m_crp (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, key TEXT, text TEXT, UNIQUE (scope, key))',
    'CREATE TABLE IF NOT EXISTS m_join (chat_id INTEGER, ts INTEGER)',
    'CREATE TABLE IF NOT EXISTS m_rel (chat_id INTEGER, a INTEGER, b INTEGER, pts INTEGER DEFAULT 0, day INTEGER DEFAULT 0, dpts INTEGER DEFAULT 0, since INTEGER, PRIMARY KEY (chat_id, a, b))',
    'CREATE TABLE IF NOT EXISTS m_month (chat_id INTEGER, user_id INTEGER, mo INTEGER, xp INTEGER DEFAULT 0, msgs INTEGER DEFAULT 0, PRIMARY KEY (chat_id, user_id, mo))',
    'CREATE TABLE IF NOT EXISTS m_week (chat_id INTEGER, user_id INTEGER, wk INTEGER, xp INTEGER DEFAULT 0, PRIMARY KEY (chat_id, user_id, wk))',
    'CREATE TABLE IF NOT EXISTS m_daily (chat_id INTEGER, kind TEXT, day INTEGER, a INTEGER, b INTEGER, PRIMARY KEY (chat_id, kind, day))',
    'CREATE TABLE IF NOT EXISTS m_raid (chat_id INTEGER PRIMARY KEY, until INTEGER)',
    'CREATE TABLE IF NOT EXISTS m_cap (chat_id INTEGER, user_id INTEGER, msg_id INTEGER, exp INTEGER, PRIMARY KEY (chat_id, user_id))',
  ];
  for (const s of q) await env.DB.prepare(s).run();
  const cols = ((await env.DB.prepare('PRAGMA table_info(m_set)').all()).results || []).map((c) => c.name);
  for (const [c, d] of [['sys', 'INTEGER DEFAULT 0'], ['wel', 'INTEGER DEFAULT 0'], ['xp', 'INTEGER DEFAULT 1'], ['wtext', 'TEXT'], ['cap', 'INTEGER DEFAULT 0']]) {
    if (!cols.includes(c)) await env.DB.prepare('ALTER TABLE m_set ADD COLUMN ' + c + ' ' + d).run();
  }
  const wcols = ((await env.DB.prepare('PRAGMA table_info(m_week)').all()).results || []).map((c) => c.name);
  if (!wcols.includes('msgs')) await env.DB.prepare('ALTER TABLE m_week ADD COLUMN msgs INTEGER DEFAULT 0').run();
  schemaDone = true;
}

// ---------- разбор команд ----------
const CMD = {
  mute: ['мут', 'mut', 'mute', 'мути', 'замути', 'молчи', 'мьют'],
  unmute: ['размут', 'анмут', 'unmut', 'unmute', 'размьют'],
  ban: ['бан', 'ban'],
  unban: ['разбан', 'unban'],
  warn: ['варн', 'warn', 'пред'],
  unwarn: ['унварн', 'unwarn', 'разварн'],
  warns: ['варны', 'warns', 'преды'],
  rules: ['правила', 'rules'],
  diag: ['диагностика', 'diag'],
  help: ['помощь', 'help', 'команды', 'start', 'старт'],
  spam: ['спам', 'spam'],
  'rp:hug': ['обнять', 'обнимашки', 'hug'], 'rp:kiss': ['поцеловать', 'чмок', 'kiss'], 'rp:pat': ['погладить', 'pat'],
  'rp:five': ['пять', 'five', 'highfive'], 'rp:shake': ['пожать', 'handshake'], 'rp:tea': ['угостить', 'чай'], 'rp:flowers': ['цветы', 'подарить'],
};
const WORD2CMD = {};
for (const k of Object.keys(CMD)) for (const w of CMD[k]) WORD2CMD[w] = k;

const UNITS = [
  [/^(?:нед[а-яё]*|w|wk|weeks?)$/i, 604800], [/^(?:д|дн[а-яё]*|день|дня|дней|d|days?)$/i, 86400],
  [/^(?:ч|час[а-яё]*|h|hr|hrs|hours?)$/i, 3600], [/^(?:м|мин[а-яё]*|m|min|mins|minutes?)$/i, 60],
  [/^(?:с|сек[а-яё]*|s|sec|secs|seconds?)$/i, 1],
];
const unitSec = (u) => { for (const [re, s] of UNITS) if (re.test(u)) return s; return 0; };

// Забирает срок из начала строки. Возвращает { sec (null = не указан, 0 = навсегда), rest }
function parseDur(line) {
  let s = line.trim().replace(/^на\s+/i, '');
  if (/^(навсегда|forever|inf)(?![\wа-яё])/i.test(s)) return { sec: 0, rest: s.replace(/^\S+\s*/, '') };
  const re = /^(\d+)\s*([a-zа-яё]+)/i;
  let total = 0, found = false, m;
  while ((m = re.exec(s))) {
    const k = unitSec(m[2]); if (!k) break;
    total += parseInt(m[1], 10) * k; found = true; s = s.slice(m[0].length).replace(/^[\s,]+/, '');
  }
  if (found) return { sec: total, rest: s };
  m = /^(\d{1,5})(?![\d\w])\s*/.exec(s);
  if (m) return { sec: parseInt(m[1], 10) * 60, rest: s.slice(m[0].length) };
  return { sec: null, rest: s };
}
const plural = (n, a, b, c) => { const x = n % 100, y = n % 10; return x > 10 && x < 20 ? c : y === 1 ? a : y >= 2 && y <= 4 ? b : c; };
function fmtDur(sec) {
  if (!sec) return 'навсегда';
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60, out = [];
  if (d) out.push(d + ' ' + plural(d, 'день', 'дня', 'дней'));
  if (h) out.push(h + ' ' + plural(h, 'час', 'часа', 'часов'));
  if (m) out.push(m + ' ' + plural(m, 'минуту', 'минуты', 'минут'));
  if (s && !d && !h) out.push(s + ' сек.');
  return out.join(' ') || '1 минуту';
}

// text + entities -> { cmd, args(строка без упоминаний), lines, targets:{ids,names}, prefixed }
function parseCommand(text, entities, botName) {
  if (!text) return null;
  let t = text, ids = [], names = [];
  const ents = (entities || []).filter((e) => e.type === 'mention' || e.type === 'text_mention').sort((a, b) => b.offset - a.offset);
  for (const e of ents) {
    const piece = t.slice(e.offset, e.offset + e.length);
    if (e.type === 'text_mention' && e.user) ids.push(e.user.id);
    else if (e.type === 'mention') { if (botName && piece.toLowerCase() === '@' + botName.toLowerCase()) { /* это сам бот */ } else names.push(piece.slice(1).toLowerCase()); }
    t = t.slice(0, e.offset) + ' '.repeat(e.length) + t.slice(e.offset + e.length);
  }
  t = t.replace(/@([A-Za-z0-9_]{4,32})/g, (all, un) => { if (!(botName && un.toLowerCase() === botName.toLowerCase())) names.push(un.toLowerCase()); return ' '.repeat(all.length); });
  // правила: +правило / -правило
  let m = /^\s*([+\-])\s*(правил\S*|rule\S*)\s*([\s\S]*)$/i.exec(t);
  if (m) return { cmd: m[1] === '+' ? 'addrule' : 'delrule', rest: m[3].trim(), ids, names, prefixed: true };
  m = /^\s*([./!])?\s*(снять\s+варн|снять\s+пред)(?![\wа-яё])([\s\S]*)$/i.exec(t);
  if (m) return { cmd: 'unwarn', rest: m[3], ids, names, prefixed: !!m[1] };
  m = /^\s*([./!])?([a-zа-яё]+)(?:@(\w+))?([\s\S]*)$/i.exec(t);
  if (!m) return null;
  const word = m[2].toLowerCase(), cmd = WORD2CMD[word];
  if (!cmd) return null;
  if (m[3] && botName && m[3].toLowerCase() !== botName.toLowerCase()) return null;
  let rest = m[4] || '';
  // автоматически вытащим числовые id из первой строки
  rest = rest.replace(/(^|\s)(\d{6,12})(?=\s|$)/g, (all, sp, id) => { ids.push(Number(id)); return sp; });
  return { cmd, rest, ids, names, prefixed: !!m[1] };
}

// ---------- права ----------
async function member(env, chat, uid) {
  const r = await tg(env, 'getChatMember', { chat_id: chat, user_id: uid });
  return r.ok ? r.result : null;
}
function perms(m) {
  if (!m) return { admin: false };
  if (m.status === 'creator') return { admin: true, ban: true, mute: true, creator: true };
  if (m.status !== 'administrator') return { admin: false };
  return { admin: true, ban: !!m.can_restrict_members, mute: !!(m.can_restrict_members || m.can_delete_messages) };
}
let botInfo = null;
async function me(env) { if (!botInfo) { const r = await tg(env, 'getMe'); if (r.ok) botInfo = r.result; } return botInfo || { id: 0, username: '' }; }

// ---------- пользователи ----------
const seenCache = new Map();
const adminSync = new Map();
async function syncAdmins(env, chat) {
  const last = adminSync.get(chat); if (last && Date.now() - last < 600000) return;
  adminSync.set(chat, Date.now());
  const r = await tg(env, 'getChatAdministrators', { chat_id: chat });
  if (r.ok) for (const a of r.result) await rememberUser(env, chat, a.user);
}
async function rememberUser(env, chat, u) {
  if (!u || u.is_bot) return;
  const key = chat + ':' + u.id, sig = (u.username || '') + '|' + nameOf(u), prev = seenCache.get(key), now = Date.now();
  if (prev && prev.sig === sig && now - prev.t < 86400000) return;
  seenCache.set(key, { sig, t: now });
  await env.DB.prepare('INSERT INTO m_users (chat_id,user_id,username,name,seen) VALUES (?,?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET username=excluded.username,name=excluded.name,seen=excluded.seen')
    .bind(chat, u.id, (u.username || '').toLowerCase(), nameOf(u), now).run();
}
async function resolveTarget(env, msg, cmd) {
  const chat = msg.chat.id;
  const rp = msg.reply_to_message;
  if (rp && rp.from && !rp.sender_chat) return { id: rp.from.id, user: rp.from };
  if (cmd.ids.length) {
    const id = cmd.ids[0], row = await env.DB.prepare('SELECT name,username FROM m_users WHERE chat_id=? AND user_id=?').bind(chat, id).first();
    return { id, user: { id, first_name: row ? row.name : 'id' + id, username: row && row.username } };
  }
  if (cmd.names.length) {
    const un = cmd.names[0];
    const find = () => env.DB.prepare('SELECT user_id,name,username FROM m_users WHERE chat_id=? AND username=?').bind(chat, un).first();
    let row = await find();
    if (!row) { await syncAdmins(env, chat); row = await find(); }
    if (!row) {
      const r = await tg(env, 'getChat', { chat_id: '@' + un });
      if (r.ok && r.result && r.result.type === 'private') {
        const u = { id: r.result.id, first_name: r.result.first_name || un, last_name: r.result.last_name, username: r.result.username || un };
        await rememberUser(env, chat, u); row = { user_id: u.id, name: nameOf(u), username: un };
      }
    }
    if (row) return { id: row.user_id, user: { id: row.user_id, first_name: row.name, username: row.username } };
    return { unknown: un };
  }
  return null;
}

// ---------- автомодерация ----------
const FLAGS = { links: 'links', ссылки: 'links', beg: 'beg', begging: 'beg', попрошайничество: 'beg', попрошайки: 'beg', попрошайка: 'beg', приветствие: 'wel', welcome: 'wel', рейтинг: 'xp', уровни: 'xp', чистка: 'sys', системные: 'sys', капча: 'cap', captcha: 'cap', cap: 'cap' };
const FLAG_NAME = { links: 'Ссылки на Telegram', beg: 'Попрошайничество', sys: 'Системные сообщения', wel: 'Приветствие новичков', xp: 'Рейтинг и уровни', cap: 'Капча для новичков' };
const INVERT = { links: 1, beg: 1 };
function stateText(k, v) {
  if (INVERT[k]) return v ? '🛡 нельзя' : '✅ можно';
  if (k === 'sys') return v ? '🧹 удаляются' : '✅ остаются';
  if (k === 'wel') return v ? '👋 включено' : '🔕 выключено';
  if (k === 'cap') return v ? '🤖 включена' : '🔕 выключена';
  return v ? '🏆 включён' : '🔕 выключен';
}
const setCache = new Map();
async function getSet(env, chat) {
  const c = setCache.get(chat); if (c && Date.now() - c.t < 60000) return c.v;
  const v = (await env.DB.prepare('SELECT * FROM m_set WHERE chat_id=?').bind(chat).first()) || { links: 0, beg: 0, bots: 0, sys: 0, wel: 0, xp: 1, wtext: null, cap: 0 };
  if (v.xp == null) v.xp = 1;
  setCache.set(chat, { v, t: Date.now() }); return v;
}
async function setFlag(env, chat, key, v) {
  await env.DB.prepare('INSERT INTO m_set (chat_id,' + key + ') VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET ' + key + '=excluded.' + key).bind(chat, v).run();
  setCache.delete(chat);
}
const LINK_RE = /(?:https?:\/\/)?(?:t|telegram)\.me\/|telegram\.dog\/|tg:\/\/(?:join|resolve)/i;
const BEG_RE = [
  /подар(ите|и|ил|ок)[^.!?\n]{0,25}(пожалуйста|пжлст|пж|плиз|мне|премиум|звёзд|звезд|нфт|nft)/i,
  /кто[\s-]*(нибудь\s+)?(подарит|задонатит|скинет|кинет|даст)/i,
  /(дайте|скиньте|киньте|переведите|задонатьте|подарите)\s+(мне\s+)?(пожалуйста\s+)?(денег|деньги|монет|звёзд|звезд|тон|ton|нфт|nft|премиум|подарок|на\s+(еду|карту|телефон|хлеб))/i,
  /(нужны|надо)\s+деньги\s+(на|срочно)/i,
  /задонать(те)?\s+мне|донатьте\s+мне/i,
];
const hasTgLink = (msg, text) => LINK_RE.test(text) || (msg.entities || msg.caption_entities || []).some((e) => e.type === 'text_link' && e.url && LINK_RE.test(e.url));

async function autoWarn(env, msg, reason) {
  const chat = msg.chat.id, u = msg.from;
  await tg(env, 'deleteMessage', { chat_id: chat, message_id: msg.message_id });
  const n = await addWarn(env, chat, u.id, 1);
  if (n >= WARN_LIMIT) {
    await setWarns(env, chat, u.id, 0);
    const r = await doMute(env, chat, u.id, FIVE_H, nameOf(u));
    await reply(env, msg, '⚠️ ' + link(u) + ' предупреждён (' + n + '/' + WARN_LIMIT + ').\n<b>Причина:</b> ' + reason + '\n' + (r.ok ? '🔇 Лимит достигнут: мут на <b>' + fmtDur(FIVE_H) + '</b>.' : rightsMsg(r)) + '\n<i>Автомодерация</i>', r.ok ? btn('🔊 Размутить', 'um:' + u.id) : undefined);
  } else await reply(env, msg, '⚠️ ' + link(u) + ' предупреждён (' + n + '/' + WARN_LIMIT + ').\n<b>Причина:</b> ' + reason + '\n<i>Автомодерация</i>', btn('↩️ Снять варн', 'uw:' + u.id));
}
async function autoMod(env, msg, text) {
  const chat = msg.chat.id, from = msg.from;
  if (!text || msg.sender_chat) return false;
  const set = await getSet(env, chat);
  if (!set.links && !set.beg) return false;
  let reason = null;
  if (set.links && hasTgLink(msg, text)) reason = 'ссылки на Telegram запрещены';
  else if (set.beg && BEG_RE.some((re) => re.test(text))) reason = 'попрошайничество запрещено';
  if (!reason) return false;
  if (perms(await member(env, chat, from.id)).admin) return false;
  await autoWarn(env, msg, reason);
  return true;
}
function settingsView(set) {
  const rows = ['links', 'beg', 'sys', 'wel', 'cap', 'xp'].map((k) => [{ text: FLAG_NAME[k] + ': ' + stateText(k, set[k]), callback_data: 'st:' + k }]);
  return { text: '⚙️ <b>Настройки чата</b>\nНажми на пункт, чтобы переключить. За ссылки и попрошайничество человек получает варн, сообщение удаляется.', markup: { inline_keyboard: rows } };
}
async function flagCommand(env, msg, text) {
  const m = /^\s*([+\-])\s*([a-zа-яё\-]+)\s*$/i.exec(text);
  const st = /^\s*[./!]?(настройки|settings)(@\w+)?\s*$/i.test(text);
  if (!m && !st) return false;
  const key = m && FLAGS[m[2].toLowerCase()];
  if (m && !key) return false;
  if (msg.sender_chat || !msg.from) return true;
  if (!perms(await member(env, msg.chat.id, msg.from.id)).admin) return true;
  const chat = msg.chat.id;
  if (m) {
    const val = INVERT[key] ? (m[1] === '-' ? 1 : 0) : (m[1] === '+' ? 1 : 0);
    await setFlag(env, chat, key, val);
    await reply(env, msg, '<b>' + FLAG_NAME[key] + ':</b> ' + stateText(key, val));
    return true;
  }
  const v = settingsView(await getSet(env, chat));
  await reply(env, msg, v.text, v.markup);
  return true;
}

// ---------- РП-команды ----------
const RP = {
  'обнять': ['🤗 {a} крепко обнимает {b}', '🫂 {a} заключает {b} в объятия'],
  'поцеловать': ['😘 {a} целует {b} в щёчку', '💋 {a} дарит {b} воздушный поцелуй'],
  'погладить': ['🥰 {a} гладит {b} по голове', '🐱 {a} ласково гладит {b}'],
  'дать пять': ['🙌 {a} даёт пять {b}', '✋ {a} и {b} хлопают в ладоши'],
  'пожать руку': ['🤝 {a} жмёт руку {b}', '🤝 {a} уважительно пожимает руку {b}'],
  'похвалить': ['👏 {a} хвалит {b}: молодец!', '🌟 {a} говорит {b}: ты супер!'],
  'подарить машину': ['🚗 {a} дарит {b} машину. Ключи в бардачке', '🏎 {a} дарит {b} тачку мечты'],
  'подарить цветы': ['💐 {a} дарит {b} букет цветов', '🌹 {a} вручает {b} розу'],
  'подарить сердце': ['💖 {a} дарит {b} своё сердечко', '❤️ {a} отдаёт {b} сердце, берегите друг друга'],
  'подарить дом': ['🏠 {a} дарит {b} домик у моря', '🏡 {a} вручает {b} ключи от дома'],
  'угостить кофе': ['☕ {a} угощает {b} кофе', '☕ {a} ставит перед {b} чашку горячего кофе'],
  'угостить чаем': ['🍵 {a} наливает {b} горячий чай', '🫖 {a} угощает {b} чаем с печеньками'],
  'угостить пиццей': ['🍕 {a} угощает {b} пиццей', '🍕 {a} делится с {b} последним куском пиццы'],
  'угостить мороженым': ['🍦 {a} покупает {b} мороженое', '🍨 {a} угощает {b} мороженым'],
  'поддержать': ['💪 {a} поддерживает {b}: всё получится', '🤝 {a} говорит {b}: я с тобой'],
  'поздравить': ['🎉 {a} поздравляет {b}!', '🥳 {a} от души поздравляет {b}'],
  'сказать спасибо': ['🙏 {a} благодарит {b}', '💛 {a} говорит {b} большое спасибо'],
  'пригласить на танец': ['💃 {a} приглашает {b} на танец', '🕺 {a} и {b} уходят танцевать'],
  'пригласить на свидание': ['🌹 {a} зовёт {b} на свидание', '🍷 {a} приглашает {b} на ужин при свечах'],
  'признаться в любви': ['💘 {a} признаётся {b} в любви', '💌 {a} пишет {b} любовное письмо'],
  'сделать комплимент': ['✨ {a} делает комплимент {b}: ты просто огонь', '😍 {a} говорит {b}: сегодня ты в ударе'],
  'взять за руку': ['🤝 {a} берёт {b} за руку', '🫱 {a} держит {b} за руку'],
  'подмигнуть': ['😉 {a} подмигивает {b}', '😏 {a} многозначительно подмигивает {b}'],
  'дать леща': ['🖐 {a} даёт {b} шуточного леща', '😆 {a} отвешивает {b} лёгкий подзатыльник'],
  'пощекотать': ['🤭 {a} щекочет {b}', '😂 {a} щекочет {b}, а тот хохочет'],
  'кинуть снежок': ['❄️ {a} кидает снежок в {b}', '⛄ {a} метко попадает снежком в {b}'],
  'утешить': ['🫶 {a} утешает {b}: всё наладится', '🧸 {a} отдаёт {b} мягкого мишку'],
  'ударить': ['👊 {a} бьёт {b} (понарошку, но звучно)', '💥 {a} наносит {b} эпичный удар'],
  'толкнуть': ['🫸 {a} толкает {b}', '😤 {a} слегка толкает {b} плечом'],
  'пнуть': ['🦵 {a} пинает {b} под зад', '⚽ {a} отправляет {b} в полёт'],
  'прижать': ['🫂 {a} прижимает {b} к себе', '🥺 {a} крепко прижимает {b}'],
  'прижать к себе': ['🫂 {a} прижимает {b} к себе', '🥺 {a} крепко прижимает {b} и не отпускает'],
  'укусить': ['😬 {a} кусает {b} за плечо (в шутку)', '🧛 {a} грозно показывает клыки {b}'],
  'погрозить пальцем': ['☝️ {a} грозит {b} пальцем: ай-ай-ай', '😠 {a} строго смотрит на {b}'],
  'накормить': ['🍲 {a} кормит {b} вкусным обедом', '🥘 {a} накладывает {b} добавки'],
  'спеть песню': ['🎤 {a} поёт песню для {b}', '🎶 {a} исполняет для {b} хит сезона'],
  'потанцевать': ['💃 {a} кружит {b} в танце', '🕺 {a} и {b} танцуют до утра'],
  'помириться': ['🤝 {a} предлагает {b} мир', '🕊 {a} и {b} закапывают топор войны'],
  'обидеться': ['😤 {a} обиделся(ась) на {b} и отвернулся(ась)', '🙄 {a} демонстративно дуется на {b}'],
  'простить': ['🙏 {a} прощает {b}', '💞 {a} говорит {b}: забыли, всё хорошо'],
  'выгнать': ['🚪 {a} выставляет {b} за дверь', '👋 {a} провожает {b} до выхода'],
  'пригласить в кино': ['🎬 {a} зовёт {b} в кино', '🍿 {a} покупает {b} попкорн и два билета'],
  'пожелать доброго утра': ['☀️ {a} желает {b} доброго утра', '🌅 {a} говорит {b}: просыпайся, солнце уже встало'],
  'пожелать спокойной ночи': ['🌙 {a} желает {b} спокойной ночи', '😴 {a} говорит {b}: сладких снов'],
  'укрыть пледом': ['🧣 {a} укрывает {b} тёплым пледом', '🛋 {a} бережно укутывает {b} пледом'],
  'почесать за ушком': ['🐱 {a} чешет {b} за ушком', '😌 {a} гладит {b}, а тот мурлычет'],
  'подарить звезду': ['⭐ {a} дарит {b} звезду с неба', '🌠 {a} называет звезду именем {b}'],
  'подарить котика': ['🐈 {a} дарит {b} пушистого котика', '😻 {a} вручает {b} мурчащий подарок'],
  'угостить шоколадкой': ['🍫 {a} угощает {b} шоколадкой', '🍬 {a} делится с {b} сладостями'],
  'сыграть на гитаре': ['🎸 {a} играет {b} на гитаре', '🎵 {a} исполняет для {b} душевную песню'],
  'написать стих': ['📜 {a} сочиняет для {b} стих', '✍️ {a} посвящает {b} поэму'],
  'вылечить': ['💊 {a} лечит {b} мёдом и добрым словом', '🩹 {a} ставит {b} на ноги'],
  'спасти': ['🦸 {a} спасает {b} в последний момент', '🛟 {a} бросает {b} спасательный круг'],
  'защитить': ['🛡 {a} закрывает {b} щитом', '💪 {a} встаёт на защиту {b}'],
  'пожалеть': ['🥺 {a} жалеет {b}', '🫂 {a} говорит {b}: ну-ну, держись'],
  'рассмешить': ['😂 {a} рассказывает {b} анекдот', '🤣 {a} так смешит {b}, что тот падает со стула'],
  'удивить': ['😮 {a} удивляет {b} неожиданным подарком', '🎁 {a} устраивает {b} сюрприз'],
  'поддразнить': ['😜 {a} дразнит {b}', '🤪 {a} показывает {b} язык'],
  'комплимент': ['✨ {a} говорит {b}: рядом с тобой всегда тепло', '🌟 {a} признаётся {b}: ты делаешь этот чат лучше', '😍 {a} шепчет {b}: у тебя потрясающая улыбка', '💎 {a} говорит {b}: ты редкий человек', '🌸 {a} дарит {b} комплимент: с тобой легко и весело', '🔥 {a} сообщает {b}: ты горишь, и это красиво', '👑 {a} говорит {b}: ты король(ева) этого чата', '🥰 {a} говорит {b}: ты очень добрый(ая)', '🧠 {a} говорит {b}: ты умница', '😎 {a} говорит {b}: у тебя отличный стиль', '🌈 {a} говорит {b}: ты делаешь мир ярче', '💫 {a} говорит {b}: ты невероятно харизматичный(ая)'],
};
const RP_KEYS = Object.keys(RP).sort((x, y) => y.length - x.length);
async function tryRp(env, msg, text) {
  if (/^\s*[./!]?(рп|rp)(@\w+)?\s*$/i.test(text)) { await reply(env, msg, '🎭 <b>РП-команды</b>\nОтветь на сообщение одной командой, а на следующей строке можно дописать от себя.\n\n' + RP_KEYS.slice().sort().join(', ')); return true; }
  const lines = text.trim().split('\n'), comment = lines.slice(1).join(' ').trim().slice(0, 300);
  const t = lines[0].trim().toLowerCase().replace(/^[./!]/, '').replace(/\s+/g, ' ');
  const key = RP_KEYS.find((k) => t === k || t.startsWith(k + ' @'));
  if (!key) return false;
  const nm = /@([a-z0-9_]{4,32})\s*$/.exec(t);
  const tg0 = await resolveTarget(env, msg, { ids: [], names: nm ? [nm[1]] : [] });
  if (!tg0 || tg0.unknown) return false;
  const from = msg.from, a = link(from), tu = tg0.user, bot = await me(env);
  let out;
  if (tu.id === bot.id) out = '🥹 Мне? Спасибо, ' + a + '!';
  else if (tu.id === from.id) out = '🫂 ' + a + ' обращается к самому себе. Держись, мы с тобой';
  else {
    out = pick(RP[key]).replace('{a}', a).replace('{b}', link(tu));
    if (!REL_ZERO.has(key) && !tu.is_bot) {
      const w = REL_W2.has(key) ? 2 : 1, g = await relAdd(env, msg.chat.id, from.id, tu.id, w);
      if (g) {
        out += '\n<i>💞 +' + g.w + ' к отношениям</i>';
        if (g.nl > g.ol) out += '\n🎊 <b>Новый уровень отношений!</b> ' + a + ' и ' + link(tu) + ' теперь «<b>' + REL_LV[g.nl] + '</b>» (ур. ' + g.nl + ')';
      }
    }
  }
  if (comment) out += '\n💬 <i>' + esc(comment) + '</i>';
  await reply(env, msg, out);
  return true;
}

// ---------- действия ----------
const NO = { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false, can_change_info: false, can_invite_users: false, can_pin_messages: false, can_manage_topics: false };
const YES = { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true, can_invite_users: true };

async function doMute(env, chat, uid, sec, nameFor) {
  const until = sec ? Math.floor(Date.now() / 1000) + Math.max(60, Math.min(sec, 366 * 86400)) : 0;
  const r = await tg(env, 'restrictChatMember', { chat_id: chat, user_id: uid, permissions: NO, until_date: until });
  if (r.ok) {
    if (until) await env.DB.prepare('INSERT INTO m_mutes (chat_id,user_id,until,name) VALUES (?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET until=excluded.until,name=excluded.name').bind(chat, uid, until, nameFor || '').run();
    else await env.DB.prepare('DELETE FROM m_mutes WHERE chat_id=? AND user_id=?').bind(chat, uid).run();
  }
  return r;
}
const ALL = Object.fromEntries(Object.keys(NO).map((k) => [k, true]));
async function stillMuted(env, chat, uid) {
  const m = await member(env, chat, uid);
  return !!(m && m.status === 'restricted' && m.can_send_messages === false);
}
async function doUnmute(env, chat, uid) {
  await env.DB.prepare('DELETE FROM m_mutes WHERE chat_id=? AND user_id=?').bind(chat, uid).run();
  const c = await tg(env, 'getChat', { chat_id: chat });
  const p = c.ok && c.result.permissions ? Object.assign({}, YES, c.result.permissions, { can_send_messages: true }) : YES;
  let r = await tg(env, 'restrictChatMember', { chat_id: chat, user_id: uid, permissions: p, use_independent_chat_permissions: true, until_date: 0 });
  if (r.ok && (await stillMuted(env, chat, uid))) {
    r = await tg(env, 'restrictChatMember', { chat_id: chat, user_id: uid, permissions: YES, use_independent_chat_permissions: true, until_date: 0 });
    if (r.ok && (await stillMuted(env, chat, uid))) return { ok: false, description: 'STILL_MUTED' };
  }
  return r;
}
const rightsMsg = (r) => /STILL_MUTED/.test(r.description || '') ? '⚠️ Не вышло снять мут: Telegram всё ещё держит ограничение. Возможно, его поставил другой бот или админ. Сними его в настройках чата (Участники → человек → Разрешения).' : /rights|administrator|CHAT_ADMIN|not enough/i.test(r.description || '')
  ? '⚠️ У меня не хватает прав. Сделай меня админом с правами «Блокировка участников» и «Удаление сообщений».'
  : /method is available only for supergroups|supergroup/i.test(r.description || '')
    ? '⚠️ Это обычная группа. Мут и бан работают только в супергруппах (включи историю чата или преобразуй группу).'
    : /PARTICIPANT_ID_INVALID|user not found|USER_NOT_PARTICIPANT/i.test(r.description || '')
      ? '⚠️ Этого пользователя нет в чате.' : '⚠️ Не получилось: ' + esc(r.description || 'ошибка');

async function reply(env, msg, text, markup) {
  return tg(env, 'sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup, message_thread_id: msg.is_topic_message ? msg.message_thread_id : undefined });
}
const btn = (text, data) => ({ inline_keyboard: [[{ text, callback_data: data }]] });
const reasonLine = (r) => (r ? '\n<b>Причина:</b> ' + esc(r) : '');

const startKb = (un) => ({ inline_keyboard: [[{ text: '➕ Добавить в чат', url: 'https://t.me/' + un + '?startgroup=true&admin=delete_messages+restrict_members+pin_messages+invite_users' }]] });
function help(un) {
  un = un || 'GloHelperBot';
  return '🦆 <b>Кряк на связи!</b> Я модератор этого чата: слежу за порядком, считаю уровни, женю, мирю и устраиваю РП.\n\n' +
    '<b>👥 Для всех</b>\n<blockquote expandable>' +
    'топ — рейтинг чата, топ недели, топ месяца — за период (имена кликабельные), ранг — твой уровень\n' +
    'отношения — ответом на сообщение: уровень ваших отношений. Комплименты и добрые РП дают очки и поднимают уровень. топ пар — лучшие пары чата\n' +
    'комплимент — ответом на сообщение: случайный комплимент\n' +
    'пара дня, звезда дня, умник дня — раз в сутки бот выбирает активных людей. рулетка — крутани барабан\n' +
    'кто ты — ответом на сообщение: профиль человека; кто я — твой\n' +
    'репорт — ответом на сообщение: жалоба админам (причину допиши)\n' +
    'жениться — ответом или @ник; развод; мой брак; браки чата\n' +
    'рп — список РП-команд (обнять, поцеловать...), ответом на сообщение\n' +
    'правила — правила чата\n\n' +
    '💫 Из любого чата набери <b>@' + un + '</b> и выбери РП-действие: появятся кнопки «Принять» и «Отклонить», решает тот, кто нажмёт первым\n' +
    '🧮 <b>@' + un + ' 2+2*3</b> — калькулятор, результат появится сверху\n' +
    '⭐ Свои РП: <code>/addrp пнуть | пнул(а)</code> в личке со мной' +
    '</blockquote>\n\n' +
    '<b>🛡 Для админов</b> (цель: ответом, @ник или id)\n<blockquote expandable>' +
    '<b>Наказания</b>\n' +
    'мут — навсегда; мут 10 минут — на время (2ч, 1д, 1h30m); причину пиши с новой строки\n' +
    'размут, бан, разбан\n' +
    'варн — предупреждение (3 варна = мут на 5 часов); снять варн; варны\n\n' +
    '<b>Защита чата</b>\n' +
    '-ссылки / +ссылки — ссылки на Telegram\n' +
    '-попрошайничество / +попрошайничество\n' +
    '+чистка / -чистка — удалять системные сообщения (вошёл, вышел, закрепил)\n' +
    '+рейтинг / -рейтинг — уровни и опыт\n' +
    '+капча / -капча — новичок должен нажать «Я не бот» (3 минуты, иначе вылетает)\n' +
    '+приветствие / -приветствие; приветствие текст — свой ({name}, {chat})\n' +
    '/settings — всё это кнопками\n\n' +
    '<b>Правила и РП</b>\n' +
    '+правило текст, -правило 2\n' +
    '+рп название | текст — своя РП-команда для чата, -рп название\n\n' +
    'Бан — админ с правом блокировки. Мут — с правом блокировки или удаления сообщений. Варн и настройки — любой админ.' +
    '</blockquote>\n\n' +
    '<b>📱 Команды для твоего аккаунта</b> (в личке, если подключил меня к Telegram Business; пиши с точкой)\n<blockquote expandable>' +
    '<code>.mut</code>, <code>.mut 10m</code>, <code>.unmut</code> — мут собеседника\n' +
    '<code>.spam 5 слово</code> — повторить слово 5 раз\n' +
    '<code>.поцеловать</code>, <code>.обнять</code>, <code>.погладить</code> и другие РП (список: <code>.рп</code>). Вторая строка — твой комментарий\n' +
    '<code>.печатает текст</code> — текст набирается по буквам\n' +
    '<code>.загрузка название</code> — полоска загрузки\n' +
    '<code>.calc 2+2*3</code> — калькулятор\n' +
    '<code>.рандом 1 100</code> — случайное число\n' +
    '<code>.шанс вопрос</code> — вероятность в процентах\n' +
    '<code>.шар вопрос</code> — магический шар\n' +
    'Свои: <code>/addrp пнуть | пнул(а)</code> в личке со мной, потом пиши <code>.пнуть</code>\n' +
    'Удалённые собеседником сообщения я присылаю тебе в этот чат.' +
    '</blockquote>';
}

const sysWarn = new Map();
async function onGroupMessage(env, msg) {
  const chat = msg.chat.id, from = msg.from;
  if (!from) return;
  await rememberUser(env, chat, from);
  if (msg.reply_to_message && msg.reply_to_message.from) await rememberUser(env, chat, msg.reply_to_message.from);
  for (const nu of msg.new_chat_members || []) await rememberUser(env, chat, nu);
  if (msg.left_chat_member) await rememberUser(env, chat, msg.left_chat_member);
  if (msg.forward_origin && msg.forward_origin.sender_user) await rememberUser(env, chat, msg.forward_origin.sender_user);
  const text = msg.text || msg.caption;
  const set = await getSet(env, chat);
  if (msg.new_chat_members) {
    const raid = await raidCheck(env, msg);
    if (set.cap || raid) await captcha(env, msg); else if (set.wel) await welcome(env, msg, set);
  }
  if (isService(msg)) {
    if (set.sys) {
      const dr = await tg(env, 'deleteMessage', { chat_id: chat, message_id: msg.message_id });
      if (!dr.ok && Date.now() - (sysWarn.get(chat) || 0) > 600000) {
        sysWarn.set(chat, Date.now());
        await tg(env, 'sendMessage', { chat_id: chat, parse_mode: 'HTML', text: '⚠️ Не могу удалить системное сообщение: <i>' + esc(dr.description || 'неизвестная ошибка') + '</i>\nПроверь, что у меня в правах админа включено «Удаление сообщений». Напиши <code>/diag</code>, чтобы увидеть мои права.' });
      }
    }
    return;
  }
  const bot = await me(env);
  if (text && (await flagCommand(env, msg, text))) return;
  if (text && (await autoMod(env, msg, text))) return;
  if (set.xp && !msg.sender_chat) await addXp(env, msg);
  if (!text) return;
  if (await tryChatCmds(env, msg, text, bot)) return;
  if (await tryRp(env, msg, text)) return;
  if (await tryCustomRp(env, msg, text, bot)) return;
  const cmd = parseCommand(text, msg.entities || msg.caption_entities, bot.username);
  if (!cmd) return;
  const lines = cmd.rest.split('\n');
  const first = lines[0], more = lines.slice(1).join('\n');

  if (cmd.cmd === 'diag') {
    if (!perms(await member(env, chat, from.id)).admin) return;
    const bm = await member(env, chat, bot.id), st = await getSet(env, chat);
    const yn = (v) => (v ? '✅' : '❌');
    return reply(env, msg, '🔧 <b>Диагностика</b>\nСтатус бота: ' + esc(bm ? bm.status : 'не найден') + '\n' +
      yn(bm && bm.can_delete_messages) + ' Удаление сообщений\n' + yn(bm && bm.can_restrict_members) + ' Блокировка участников (мут, бан, капча)\n' + yn(bm && bm.can_pin_messages) + ' Закрепление\n\n' +
      'Чистка системных: ' + stateText('sys', st.sys) + '\nКапча: ' + stateText('cap', st.cap) + '\nПриветствие: ' + stateText('wel', st.wel) + '\nРейтинг: ' + stateText('xp', st.xp));
  }
  if (cmd.cmd === 'rules') { if (!cmd.prefixed && cmd.rest.trim()) return; return showRules(env, msg); }
  if (cmd.cmd === 'help') { if (!cmd.prefixed) return; return reply(env, msg, help(bot.username), startKb(bot.username)); }
  if (cmd.cmd === 'spam') return;

  if (cmd.cmd.startsWith('rp:')) {
    const t = await resolveTarget(env, msg, cmd);
    if (!t || t.unknown) { if (cmd.prefixed) await reply(env, msg, 'Ответь на сообщение того, к кому обращаешься.'); return; }
    const key = RP_ALIAS[cmd.cmd], self = t.id === from.id, isBot = t.id === bot.id;
    if (isBot) return reply(env, msg, '🥹 Мне? Спасибо, ' + link(from) + '!');
    if (self) return reply(env, msg, '🫂 ' + link(from) + ' обнимает сам себя. Держись, мы с тобой');
    return reply(env, msg, pick(RP[key]).replace('{a}', link(from)).replace('{b}', link(t.user)));
  }
  // Всё остальное — только для админов. Простое слово без / или . от неадмина игнорируем молча.
  if (msg.sender_chat) { return; }
  const mp = perms(await member(env, chat, from.id));
  if (!mp.admin) { if (cmd.prefixed) await reply(env, msg, '🚫 Эта команда только для админов.'); return; }

  if (cmd.cmd === 'addrule' || cmd.cmd === 'delrule') return editRules(env, msg, cmd, first + (more ? '\n' + more : ''));

  const t = await resolveTarget(env, msg, cmd);
  if (!t) { if (cmd.prefixed || msg.reply_to_message) await reply(env, msg, 'Ответь на сообщение человека или укажи @ник. Если ника нет в моей базе, пусть напишет что-нибудь в чате.'); return; }
  if (t.unknown) { await reply(env, msg, 'Не знаю @' + esc(t.unknown) + '. Ответь на его сообщение или пусть он что-нибудь напишет в чате.'); return; }
  const tu = t.user;
  if (cmd.cmd === 'warns') return showWarns(env, msg, tu);
  if (tu.id === bot.id) { await reply(env, msg, 'Себя я трогать не буду 🙂'); return; }
  if (tu.id === from.id) { await reply(env, msg, 'Себя нельзя.'); return; }

  const need = cmd.cmd === 'ban' || cmd.cmd === 'unban' ? 'ban' : cmd.cmd === 'mute' || cmd.cmd === 'unmute' ? 'mute' : 'admin';
  if (!mp[need]) {
    await reply(env, msg, need === 'ban' ? '🚫 Для бана нужно право админа «Блокировка участников».' : '🚫 Для мута нужно право «Блокировка участников» или «Удаление сообщений».');
    return;
  }
  // нельзя трогать админов (кроме снятия)
  if (['mute', 'ban', 'warn'].includes(cmd.cmd)) {
    const tm = await member(env, chat, tu.id);
    if (tm && (tm.status === 'creator' || tm.status === 'administrator')) { await reply(env, msg, '🛡 Это админ, его нельзя.'); return; }
  }
  const cleanup = () => tg(env, 'deleteMessage', { chat_id: chat, message_id: msg.message_id });

  if (cmd.cmd === 'mute') {
    const d = parseDur(first); const sec = d.sec === null ? 0 : d.sec;
    const reason = [d.rest.trim(), more.trim()].filter(Boolean).join('\n');
    const r = await doMute(env, chat, tu.id, sec, nameOf(tu));
    if (!r.ok) return reply(env, msg, rightsMsg(r));
    await reply(env, msg, '🔇 ' + link(tu) + ' получает мут ' + (sec ? 'на <b>' + fmtDur(sec) + '</b>' : '<b>навсегда</b>') + '.' + reasonLine(reason) + '\n<b>Админ:</b> ' + link(from), btn('🔊 Размутить', 'um:' + tu.id));
    return cleanup();
  }
  if (cmd.cmd === 'unmute') {
    const r = await doUnmute(env, chat, tu.id);
    if (!r.ok) return reply(env, msg, rightsMsg(r));
    await reply(env, msg, '🔔 ' + link(tu) + ', срок молчания закончился. Можно говорить, но следи за языком 😉' + '\n<b>Админ:</b> ' + link(from)); return cleanup();
  }
  if (cmd.cmd === 'ban') {
    const reason = [first.trim(), more.trim()].filter(Boolean).join('\n');
    const r = await tg(env, 'banChatMember', { chat_id: chat, user_id: tu.id });
    if (r.ok) await env.DB.prepare('DELETE FROM m_mutes WHERE chat_id=? AND user_id=?').bind(chat, tu.id).run();
    if (!r.ok) return reply(env, msg, rightsMsg(r));
    await reply(env, msg, '⛔ ' + link(tu) + ' заблокирован.' + reasonLine(reason) + '\n<b>Админ:</b> ' + link(from), btn('♻️ Разбанить', 'ub:' + tu.id));
    return cleanup();
  }
  if (cmd.cmd === 'unban') {
    const r = await tg(env, 'unbanChatMember', { chat_id: chat, user_id: tu.id, only_if_banned: true });
    if (!r.ok) return reply(env, msg, rightsMsg(r));
    await reply(env, msg, '♻️ ' + link(tu) + ' разбанен.\nПолучает второй шанс.' + '\n<b>Админ:</b> ' + link(from)); return cleanup();
  }
  if (cmd.cmd === 'warn') {
    const reason = [first.trim(), more.trim()].filter(Boolean).join('\n');
    const n = await addWarn(env, chat, tu.id, 1);
    if (n >= WARN_LIMIT) {
      await setWarns(env, chat, tu.id, 0);
      const r = await doMute(env, chat, tu.id, FIVE_H, nameOf(tu));
      await reply(env, msg, '⚠️ ' + link(tu) + ' предупреждён (' + n + '/' + WARN_LIMIT + ').' + reasonLine(reason) + '\n' +
        (r.ok ? '🔇 Лимит достигнут: мут на <b>' + fmtDur(FIVE_H) + '</b>, предупреждения обнулены.' : rightsMsg(r)) + '\n<b>Админ:</b> ' + link(from), r.ok ? btn('🔊 Размутить', 'um:' + tu.id) : undefined);
    } else {
      await reply(env, msg, '⚠️ ' + link(tu) + ' предупреждён (' + n + '/' + WARN_LIMIT + ').' + reasonLine(reason) + '\n<b>Админ:</b> ' + link(from), btn('↩️ Снять варн', 'uw:' + tu.id));
    }
    return cleanup();
  }
  if (cmd.cmd === 'unwarn') {
    const n = await addWarn(env, chat, tu.id, -1);
    await reply(env, msg, '✅ С ' + link(tu) + ' снят варн (' + n + '/' + WARN_LIMIT + ').\n<b>Админ:</b> ' + link(from)); return cleanup();
  }
}

// ---------- варны ----------
async function getWarns(env, chat, uid) { const r = await env.DB.prepare('SELECT n FROM m_warns WHERE chat_id=? AND user_id=?').bind(chat, uid).first(); return r ? r.n : 0; }
async function setWarns(env, chat, uid, n) { await env.DB.prepare('INSERT INTO m_warns (chat_id,user_id,n) VALUES (?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET n=excluded.n').bind(chat, uid, n).run(); }
async function addWarn(env, chat, uid, d) { const n = Math.max(0, (await getWarns(env, chat, uid)) + d); await setWarns(env, chat, uid, n); return n; }
async function showWarns(env, msg, tu) { const n = await getWarns(env, msg.chat.id, tu.id); return reply(env, msg, 'Предупреждения ' + link(tu) + ': <b>' + n + '/' + WARN_LIMIT + '</b>'); }

// ---------- правила ----------
async function getRules(env, chat) { const r = await env.DB.prepare('SELECT rules FROM m_chats WHERE chat_id=?').bind(chat).first(); try { return r && r.rules ? JSON.parse(r.rules) : []; } catch (e) { return []; } }
async function saveRules(env, chat, arr) { await env.DB.prepare('INSERT INTO m_chats (chat_id,rules) VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET rules=excluded.rules').bind(chat, JSON.stringify(arr)).run(); }
async function showRules(env, msg) {
  const rules = await getRules(env, msg.chat.id);
  const text = rules.length ? '📜 <b>Правила чата</b>\n\n' + rules.map((r, i) => (i + 1) + '. ' + esc(r)).join('\n') : '📜 Правил пока нет. Админ может добавить: <code>+правило текст</code>';
  return reply(env, msg, text, btn('➕ Добавить правило', 'ar'));
}
async function editRules(env, msg, cmd, body) {
  const chat = msg.chat.id, rules = await getRules(env, chat);
  if (cmd.cmd === 'addrule') {
    const t = (cmd.rest || '').trim(); if (!t) return reply(env, msg, 'Напиши так: <code>+правило Не спамить</code>');
    if (rules.length >= 30) return reply(env, msg, 'Максимум 30 правил.');
    rules.push(t.slice(0, 500)); await saveRules(env, chat, rules);
    return reply(env, msg, '✅ Правило №' + rules.length + ' добавлено.');
  }
  const n = parseInt(cmd.rest, 10);
  if (!(n >= 1 && n <= rules.length)) return reply(env, msg, 'Укажи номер: <code>-правило 2</code>');
  rules.splice(n - 1, 1); await saveRules(env, chat, rules);
  return reply(env, msg, '🗑 Правило удалено.');
}

// ---------- кнопки ----------
async function onCallback(env, cq) {
  const msg = cq.message, data = cq.data || '';
  if (cq.inline_message_id && /^ir:/.test(data)) return onInlineCallback(env, cq);
  if (!msg || !msg.chat) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const chat = msg.chat.id, from = cq.from;
  if (/^cp:/.test(data)) return onCaptchaCb(env, cq);
  if (/^mr:/.test(data)) return onMarryCb(env, cq);
  const mp = perms(await member(env, chat, from.id));
  const deny = (t) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: t, show_alert: true });
  if (data === 'ar') {
    if (!mp.admin) return deny('Только админы могут добавлять правила.');
    return deny('Напиши в чат: +правило текст правила');
  }
  const sm = /^st:(links|beg|sys|wel|cap|xp)$/.exec(data);
  if (sm) {
    if (!mp.admin) return deny('Только админы.');
    const set = await getSet(env, chat); const nv = set[sm[1]] ? 0 : 1;
    await setFlag(env, chat, sm[1], nv); set[sm[1]] = nv;
    const v = settingsView(set);
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: FLAG_NAME[sm[1]] + ': ' + stateText(sm[1], nv) });
    return tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: msg.message_id, reply_markup: v.markup });
  }
  if (/^r[wmdc]/.test(data)) return onReportCb(env, cq, mp);
  const m = /^(um|ub|uw):(\d+)$/.exec(data); if (!m) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const uid = Number(m[2]), kind = m[1];
  if (!mp.admin) return deny('Только админы.');
  if (kind === 'ub' && !mp.ban) return deny('Нужно право «Блокировка участников».');
  if (kind === 'um' && !mp.mute) return deny('Нужно право «Блокировка» или «Удаление сообщений».');
  let r, done;
  const row = await env.DB.prepare('SELECT name,username FROM m_users WHERE chat_id=? AND user_id=?').bind(chat, uid).first();
  const tu = { id: uid, first_name: row ? row.name : 'id' + uid };
  if (kind === 'um') { r = await doUnmute(env, chat, uid); done = '🔊 ' + link(tu) + ' размучен.'; }
  else if (kind === 'ub') { r = await tg(env, 'unbanChatMember', { chat_id: chat, user_id: uid, only_if_banned: true }); done = '♻️ ' + link(tu) + ' разбанен.'; }
  else { const n = await addWarn(env, chat, uid, -1); r = { ok: true }; done = '✅ С ' + link(tu) + ' снят варн (' + n + '/' + WARN_LIMIT + ').'; }
  if (!r.ok) return deny((r.description || 'Ошибка').slice(0, 150));
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Готово' });
  await tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
  await tg(env, 'sendMessage', { chat_id: chat, text: done + '\n<b>Админ:</b> ' + link(from), parse_mode: 'HTML', reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
}

// ---------- личка и Business ----------
async function onPrivate(env, msg) {
  const pm = /^\s*\/?(addrp|delrp|myrp)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(msg.text || '');
  if (pm && msg.from) return customPrivate(env, msg, pm[1].toLowerCase(), pm[2] || '');
  if (/^\s*[./!]?(settings|настройки)\s*$/i.test(msg.text || '')) return tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Настройки открываются прямо в чате. Напиши <code>/settings</code> в группе, где я админ (ты тоже должен быть админом).', parse_mode: 'HTML' });
  const bot = await me(env);
  return tg(env, 'sendMessage', { chat_id: msg.chat.id, text: help(bot.username), parse_mode: 'HTML', reply_markup: startKb(bot.username) });
}

async function onConnection(env, bc) {
  await env.DB.prepare('INSERT INTO m_bconn (id,owner_id,user_chat_id,enabled) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,user_chat_id=excluded.user_chat_id,enabled=excluded.enabled')
    .bind(bc.id, bc.user.id, bc.user_chat_id || bc.user.id, bc.is_enabled === false ? 0 : 1).run();
}
async function getConn(env, id) {
  let c = await env.DB.prepare('SELECT * FROM m_bconn WHERE id=?').bind(id).first();
  if (!c) { const r = await tg(env, 'getBusinessConnection', { business_connection_id: id }); if (r.ok) { await onConnection(env, r.result); c = await env.DB.prepare('SELECT * FROM m_bconn WHERE id=?').bind(id).first(); } }
  return c;
}
async function editCmd(env, cid, msg, text) {
  const r = await tg(env, 'editMessageText', { business_connection_id: cid, chat_id: msg.chat.id, message_id: msg.message_id, text });
  return !!r.ok;
}
function mediaOf(msg) {
  if (msg.photo && msg.photo.length) return ['photo', msg.photo[msg.photo.length - 1].file_id];
  for (const k of ['video', 'voice', 'audio', 'document', 'video_note', 'sticker', 'animation']) if (msg[k] && msg[k].file_id) return [k, msg[k].file_id];
  return ['', ''];
}
async function saveBMsg(env, cid, msg) {
  const [mt, fid] = mediaOf(msg), text = msg.text || msg.caption || '';
  if (!text && !mt) return;
  await env.DB.prepare('INSERT OR REPLACE INTO m_bmsgs (conn_id,chat_id,mid,from_id,name,username,text,mtype,file_id,date) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(cid, msg.chat.id, msg.message_id, msg.from.id, nameOf(msg.from), msg.from.username || '', text.slice(0, 3000), mt, fid, msg.date || Math.floor(Date.now() / 1000)).run();
}
const MEDIA_SEND = { photo: ['sendPhoto', 'photo'], video: ['sendVideo', 'video'], voice: ['sendVoice', 'voice'], audio: ['sendAudio', 'audio'], document: ['sendDocument', 'document'], video_note: ['sendVideoNote', 'video_note'], sticker: ['sendSticker', 'sticker'], animation: ['sendAnimation', 'animation'] };
const MEDIA_RU = { photo: 'фото', video: 'видео', voice: 'голосовое', audio: 'аудио', document: 'файл', video_note: 'кружок', sticker: 'стикер', animation: 'гифка' };
function fmtTime(sec, env) {
  try { return new Date(sec * 1000).toLocaleString('ru-RU', { timeZone: (env && env.TZ) || 'Asia/Bishkek', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return new Date(sec * 1000).toISOString(); }
}
async function onBusinessDeleted(env, d) {
  const cid = d.business_connection_id; if (!cid) return;
  const conn = await getConn(env, cid); if (!conn || !conn.enabled) return;
  const chat = d.chat && d.chat.id, now = Math.floor(Date.now() / 1000);
  for (const id of (d.message_ids || []).slice(0, 20)) {
    const m = await env.DB.prepare('SELECT * FROM m_bmsgs WHERE conn_id=? AND chat_id=? AND mid=?').bind(cid, chat, id).first();
    if (!m) continue;
    await env.DB.prepare('DELETE FROM m_bmsgs WHERE conn_id=? AND chat_id=? AND mid=?').bind(cid, chat, id).run();
    const head = '🗑 <b>Удалено сообщение</b> от ' + esc(m.name) + (m.username ? ' (@' + esc(m.username) + ')' : '') +
      '\n🕐 Написано: ' + fmtTime(m.date, env) + '  ·  Удалено: ' + fmtTime(now, env) +
      (m.mtype ? '\n📎 ' + MEDIA_RU[m.mtype] : '') + (m.text ? '\n\n«' + esc(m.text) + '»' : '');
    await tg(env, 'sendMessage', { chat_id: conn.user_chat_id, text: head, parse_mode: 'HTML' });
    if (m.mtype && MEDIA_SEND[m.mtype]) { const [meth, key] = MEDIA_SEND[m.mtype]; const body = { chat_id: conn.user_chat_id }; body[key] = m.file_id; await tg(env, meth, body); }
  }
}
async function onBusinessMessage(env, msg) {
  const cid = msg.business_connection_id; if (!cid || !msg.from) return;
  const conn = await getConn(env, cid); if (!conn || !conn.enabled) return;
  const chat = msg.chat.id, now = Math.floor(Date.now() / 1000);
  if (msg.from.id !== conn.owner_id) {
    const m = await env.DB.prepare('SELECT until FROM m_bmutes WHERE conn_id=? AND chat_id=?').bind(cid, chat).first();
    if (m && (m.until === 0 || m.until > now)) await tg(env, 'deleteBusinessMessages', { business_connection_id: cid, message_ids: [msg.message_id] });
    else {
      if (m) await env.DB.prepare('DELETE FROM m_bmutes WHERE conn_id=? AND chat_id=?').bind(cid, chat).run();
      await saveBMsg(env, cid, msg);
    }
    return;
  }
  const text = msg.text; if (!text || !/^\s*[.]/.test(text)) return;
  if (await ownerExtra(env, cid, conn, msg, text)) return;
  const m = /^\s*\.([a-zа-яё]+)([\s\S]*)$/i.exec(text); if (!m) return;
  const c = WORD2CMD[m[1].toLowerCase()]; if (!['mute', 'unmute', 'spam'].includes(c)) return;
  const del = () => tg(env, 'deleteBusinessMessages', { business_connection_id: cid, message_ids: [msg.message_id] });
  const note = (t) => tg(env, 'sendMessage', { chat_id: conn.user_chat_id, text: t, parse_mode: 'HTML' });
  const who = nameOf(msg.chat) + (msg.chat.username ? ' (@' + msg.chat.username + ')' : '');
  if (msg.chat.type !== 'private') return;
  if (c === 'mute') {
    const d = parseDur(m[2].split('\n')[0]); const sec = d.sec === null ? 0 : d.sec;
    await env.DB.prepare('INSERT INTO m_bmutes (conn_id,chat_id,until) VALUES (?,?,?) ON CONFLICT(conn_id,chat_id) DO UPDATE SET until=excluded.until').bind(cid, chat, sec ? now + sec : 0).run();
    const ok1 = await editCmd(env, cid, msg, '🔇 Пользователь ' + who + (sec ? ' замучен на ' + fmtDur(sec) : ' замучен'));
    if (!ok1) { await del(); await note('🔇 ' + esc(who) + ': его сообщения удаляются <b>' + fmtDur(sec) + '</b>. Снять: <code>.unmut</code> в том же чате.'); }
  } else if (c === 'unmute') {
    await env.DB.prepare('DELETE FROM m_bmutes WHERE conn_id=? AND chat_id=?').bind(cid, chat).run();
    const ok2 = await editCmd(env, cid, msg, '🔊 Пользователь ' + who + ' размучен');
    if (!ok2) { await del(); await note('🔊 ' + esc(who) + ': мут снят.'); }
  } else {
    const sm = /^\s*(\d{1,3})\s+([\s\S]+)$/.exec(m[2]); await del();
    if (!sm) return note('Формат: <code>.spam 5 слово</code> (до ' + MAX_SPAM + ')');
    const n = Math.min(MAX_SPAM, parseInt(sm[1], 10)), word = sm[2].trim().slice(0, 500);
    for (let i = 0; i < n; i++) { const r = await tg(env, 'sendMessage', { business_connection_id: cid, chat_id: chat, text: word }); if (!r.ok) { await note('⚠️ Остановился на ' + i + ': ' + esc(r.description || '')); break; } if (i < n - 1) await sleep(400); }
  }
}

// ---------- конец срока мута ----------
const BACK = [
  (u) => '🔔 ' + u + ', срок молчания закончился. Можно говорить, но следи за языком 😉',
];
async function notifyExpired(env) {
  await ensureSchema(env);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM m_bmsgs WHERE date<?').bind(now - 7 * 86400).run();
  await env.DB.prepare('DELETE FROM m_ido WHERE ts<?').bind(now - 7 * 86400).run();
  await env.DB.prepare('DELETE FROM m_join WHERE ts<?').bind(now - 3600).run();
  await env.DB.prepare('DELETE FROM m_week WHERE wk<?').bind(wkNow() - 8).run();
  await env.DB.prepare('DELETE FROM m_month WHERE mo<?').bind(moNow() - 3).run();
  await env.DB.prepare('DELETE FROM m_raid WHERE until<?').bind(now).run();
  await captchaExpire(env, now);
  const rows = (await env.DB.prepare('SELECT chat_id,user_id,until,name FROM m_mutes WHERE until<=? LIMIT 15').bind(now).all()).results || [];
  for (const r of rows) {
    await env.DB.prepare('DELETE FROM m_mutes WHERE chat_id=? AND user_id=?').bind(r.chat_id, r.user_id).run();
    if (r.until < now - 86400) continue;
    const m = await member(env, r.chat_id, r.user_id);
    if (!m || m.status === 'left' || m.status === 'kicked') continue;
    if (m.status === 'restricted' && m.can_send_messages === false && m.until_date && m.until_date > now + 30) continue;
    await tg(env, 'sendMessage', { chat_id: r.chat_id, text: pick(BACK)(link({ id: r.user_id, first_name: r.name || 'друг' })), parse_mode: 'HTML' });
  }
}

// ================= НОВОЕ: рейтинг, профиль, репорт, приветствие, чистка, браки, inline-РП =================
const RP_ALIAS = { 'rp:hug': 'обнять', 'rp:kiss': 'поцеловать', 'rp:pat': 'погладить', 'rp:five': 'дать пять', 'rp:shake': 'пожать руку', 'rp:tea': 'угостить чаем', 'rp:flowers': 'подарить цветы' };
const RPLIST = Object.keys(RP);
const SVC = ['new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo', 'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created', 'channel_chat_created', 'message_auto_delete_timer_changed', 'migrate_to_chat_id', 'migrate_from_chat_id', 'pinned_message', 'video_chat_scheduled', 'video_chat_started', 'video_chat_ended', 'video_chat_participants_invited', 'boost_added', 'chat_background_set'];
const isService = (m) => SVC.some((k) => m[k] != null);
const dayWord = (d) => d + ' ' + plural(d, 'день', 'дня', 'дней');
const nameById = async (env, chat, id) => { const r = await env.DB.prepare('SELECT name FROM m_users WHERE chat_id=? AND user_id=?').bind(chat, id).first(); return r && r.name ? r.name : 'id' + id; };
const linkId = (id, name) => link({ id, first_name: name });
const bar = (p) => { const n = Math.max(0, Math.min(10, Math.round(p * 10))); return '▰'.repeat(n) + '▱'.repeat(10 - n); };

// ---------- антирейд: наплыв новичков (накрутка) ----------
const RAID_N = 8, RAID_WIN = 60, RAID_MIN = 15;
async function raidCheck(env, msg) {
  const chat = msg.chat.id, now = Math.floor(Date.now() / 1000);
  const n = (msg.new_chat_members || []).filter((u) => !u.is_bot).length;
  for (let i = 0; i < Math.min(n, 20); i++) await env.DB.prepare('INSERT INTO m_join (chat_id,ts) VALUES (?,?)').bind(chat, now).run();
  const r = await env.DB.prepare('SELECT until FROM m_raid WHERE chat_id=?').bind(chat).first();
  if (r && r.until > now) return true;
  const c = (await env.DB.prepare('SELECT COUNT(*) AS c FROM m_join WHERE chat_id=? AND ts>?').bind(chat, now - RAID_WIN).first()).c;
  if (c < RAID_N) return false;
  await env.DB.prepare('INSERT OR REPLACE INTO m_raid (chat_id,until) VALUES (?,?)').bind(chat, now + RAID_MIN * 60).run();
  await tg(env, 'sendMessage', { chat_id: chat, parse_mode: 'HTML', text: '🚨 <b>Подозрительный наплыв новичков</b> (' + c + ' за минуту). На ' + RAID_MIN + ' минут включаю капчу: кто не нажмёт «Я не бот», будет удалён.' });
  return true;
}

// ---------- капча ----------
const NOPERM = { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false };
async function captcha(env, msg) {
  const chat = msg.chat.id;
  for (const u of msg.new_chat_members || []) {
    if (u.is_bot) continue;
    const m = await member(env, chat, u.id);
    if (!m || m.status !== 'member') continue;
    const r = await tg(env, 'restrictChatMember', { chat_id: chat, user_id: u.id, permissions: NOPERM });
    if (!r.ok) continue;
    const sent = await tg(env, 'sendMessage', {
      chat_id: chat, parse_mode: 'HTML', message_thread_id: msg.is_topic_message ? msg.message_thread_id : undefined,
      text: '🤖 ' + link(u) + ', добро пожаловать! Нажми кнопку ниже, чтобы подтвердить, что ты не бот. Время: 3 минуты, иначе придётся уйти.',
      reply_markup: { inline_keyboard: [[{ text: '✅ Я не бот', callback_data: 'cp:' + u.id }]] },
    });
    await env.DB.prepare('INSERT OR REPLACE INTO m_cap (chat_id,user_id,msg_id,exp) VALUES (?,?,?,?)').bind(chat, u.id, sent.ok ? sent.result.message_id : 0, Math.floor(Date.now() / 1000) + 180).run();
  }
}
async function onCaptchaCb(env, cq) {
  const ans = (t, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: t, show_alert: !!alert });
  const msg = cq.message; if (!msg || !msg.chat) return ans();
  const uid = Number((cq.data || '').slice(3)), chat = msg.chat.id;
  if (cq.from.id !== uid) return ans('Эта кнопка не для тебя 🙂', true);
  const row = await env.DB.prepare('SELECT 1 AS x FROM m_cap WHERE chat_id=? AND user_id=?').bind(chat, uid).first();
  const gc = await tg(env, 'getChat', { chat_id: chat });
  const dp = (gc.ok && gc.result.permissions) || {};
  const perm = {}; for (const k of Object.keys(NOPERM)) perm[k] = dp[k] !== undefined ? !!dp[k] : true;
  await tg(env, 'restrictChatMember', { chat_id: chat, user_id: uid, permissions: perm });
  await env.DB.prepare('DELETE FROM m_cap WHERE chat_id=? AND user_id=?').bind(chat, uid).run();
  await tg(env, 'deleteMessage', { chat_id: chat, message_id: msg.message_id });
  await ans('Готово, добро пожаловать! 🎉');
  if (row) { const set = await getSet(env, chat); if (set.wel) await welcome(env, { chat: msg.chat, new_chat_members: [cq.from], is_topic_message: msg.is_topic_message, message_thread_id: msg.message_thread_id }, set); }
}
async function captchaExpire(env, now) {
  const rows = (await env.DB.prepare('SELECT chat_id,user_id,msg_id FROM m_cap WHERE exp<=? LIMIT 10').bind(now).all()).results || [];
  for (const r of rows) {
    await env.DB.prepare('DELETE FROM m_cap WHERE chat_id=? AND user_id=?').bind(r.chat_id, r.user_id).run();
    await tg(env, 'banChatMember', { chat_id: r.chat_id, user_id: r.user_id });
    await tg(env, 'unbanChatMember', { chat_id: r.chat_id, user_id: r.user_id, only_if_banned: true });
    if (r.msg_id) await tg(env, 'deleteMessage', { chat_id: r.chat_id, message_id: r.msg_id });
  }
}

// ---------- приветствие ----------
async function welcome(env, msg, set) {
  const users = (msg.new_chat_members || []).filter((u) => !u.is_bot);
  if (!users.length) return;
  const tpl = set.wtext || '👋 Добро пожаловать, {name}!\nПрочитай правила командой <code>правила</code> и чувствуй себя как дома.';
  await reply(env, msg, tpl.replace(/\{name\}/g, users.map(link).join(', ')).replace(/\{chat\}/g, esc(msg.chat.title || 'чат')));
}

// ---------- рейтинг и уровни ----------
const xpCool = new Map();
const XP_K = 25;
const lvlOf = (xp) => Math.floor(Math.sqrt(xp / XP_K));
const needFor = (l) => XP_K * l * l;
const TITLES = ['Новичок', 'Заглянул', 'Знакомый', 'Свой', 'Участник', 'Болтун', 'Активист', 'Балагур', 'Душа компании', 'Весельчак', 'Завсегдатай', 'Тусовщик', 'Старожил', 'Знаток', 'Эксперт', 'Мастер общения', 'Говорун', 'Оратор', 'Знаменитость', 'Авторитет', 'Ветеран', 'Хранитель чата', 'Страж', 'Наставник', 'Мудрец', 'Гуру', 'Титан', 'Лорд чата', 'Легенда', 'Мифический', 'Император чата'];
const titleOf = (l) => (l >= 40 ? 'Абсолют' : l >= 35 ? 'Бессмертный' : TITLES[Math.min(TITLES.length - 1, l)]);
const msgPend = new Map(), topCool = new Map();
function topBusy(chat, kind) {
  const k = chat + ':' + kind, now = Date.now();
  if (now - (topCool.get(k) || 0) < 30000) return true;
  if (topCool.size > 3000) topCool.clear();
  topCool.set(k, now); return false;
}
const moNow = () => { const d = new Date(Date.now() + 6 * 3600000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const wkNow = () => Math.floor((Date.now() / 86400000 + 3) / 7);
async function addXp(env, msg) {
  const chat = msg.chat.id, u = msg.from;
  if (!u || u.is_bot) return;
  const now = Math.floor(Date.now() / 1000), key = chat + ':' + u.id, last = xpCool.get(key) || 0;
  if (now - last < 60) { if (msgPend.size > 5000) msgPend.clear(); msgPend.set(key, (msgPend.get(key) || 0) + 1); return; }
  const gain = 5 + Math.floor(Math.random() * 6), add = (msgPend.get(key) || 0) + 1;
  msgPend.delete(key);
  if (xpCool.size > 5000) xpCool.clear(); xpCool.set(key, now);
  const r = await env.DB.prepare('INSERT INTO m_stat (chat_id,user_id,xp,msgs,ts0,ts1) VALUES (?,?,?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET xp=xp+?, msgs=msgs+?, ts1=? RETURNING xp')
    .bind(chat, u.id, gain, add, now, now, gain, add, now).first();
  await env.DB.prepare('INSERT INTO m_week (chat_id,user_id,wk,xp,msgs) VALUES (?,?,?,?,?) ON CONFLICT(chat_id,user_id,wk) DO UPDATE SET xp=xp+excluded.xp, msgs=msgs+excluded.msgs').bind(chat, u.id, wkNow(), gain, add).run();
  await env.DB.prepare('INSERT INTO m_month (chat_id,user_id,mo,xp,msgs) VALUES (?,?,?,?,?) ON CONFLICT(chat_id,user_id,mo) DO UPDATE SET xp=xp+excluded.xp, msgs=msgs+excluded.msgs').bind(chat, u.id, moNow(), gain, add).run();
  if (r && lvlOf(r.xp) > lvlOf(r.xp - gain)) {
    const l = lvlOf(r.xp);
    await reply(env, msg, '🎉 ' + link(u) + ' достиг(ла) уровня <b>' + l + '</b> — «' + titleOf(l) + '»');
  }
}
async function placeOf(env, chat, xp) {
  const r = await env.DB.prepare('SELECT COUNT(*)+1 AS c FROM m_stat WHERE chat_id=? AND xp>?').bind(chat, xp).first();
  const t = await env.DB.prepare('SELECT COUNT(*) AS c FROM m_stat WHERE chat_id=?').bind(chat).first();
  return { place: r ? r.c : 1, total: t ? t.c : 1 };
}
async function showTop(env, msg) {
  const chat = msg.chat.id;
  const rows = (await env.DB.prepare('SELECT s.user_id AS id, s.xp AS xp, s.msgs AS msgs, u.name AS name FROM m_stat s LEFT JOIN m_users u ON u.chat_id=s.chat_id AND u.user_id=s.user_id WHERE s.chat_id=? ORDER BY s.xp DESC LIMIT 10').bind(chat).all()).results || [];
  if (!rows.length) return reply(env, msg, '🏆 Рейтинг пока пуст. Пишите в чат, и опыт начнёт копиться.');
  const medal = ['🥇', '🥈', '🥉'];
  return reply(env, msg, '🏆 <b>Топ чата</b>\n' + rows.map((r, i) => (medal[i] || (i + 1) + '.') + ' ' + linkId(r.id, r.name || 'Игрок') + ' — ур. <b>' + lvlOf(r.xp) + '</b> · ' + r.xp + ' XP · ' + r.msgs + ' сообщ.').join('\n'));
}
const numFmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
async function showRank(env, msg, tu) {
  const chat = msg.chat.id, LINE = '━━━━━━━━━━━━━━';
  const st = await env.DB.prepare('SELECT xp,msgs FROM m_stat WHERE chat_id=? AND user_id=?').bind(chat, tu.id).first();
  if (!st) return reply(env, msg, link(tu) + ' пока без опыта. Нужно написать хотя бы одно сообщение.');
  const l = lvlOf(st.xp), next = needFor(l + 1), base = needFor(l), pl = await placeOf(env, chat, st.xp);
  const wk = await env.DB.prepare('SELECT xp FROM m_week WHERE chat_id=? AND user_id=? AND wk=?').bind(chat, tu.id, wkNow()).first();
  let nt = null; for (let k = l + 1; k <= l + 12; k++) if (titleOf(k) !== titleOf(l)) { nt = titleOf(k); break; }
  const L = ['🏆 ' + linkId(tu.id, nameOf(tu)), LINE,
    '⭐ <b>Уровень ' + l + '</b> · «' + titleOf(l) + '»',
    bar((st.xp - base) / (next - base)) + ' ' + numFmt(st.xp) + '/' + numFmt(next) + ' XP',
    'До уровня ' + (l + 1) + ' осталось: <b>' + numFmt(next - st.xp) + ' XP</b>', LINE,
    '📊 Место в топе: <b>#' + pl.place + '</b> из ' + pl.total,
    '💬 Сообщений: <b>' + numFmt(st.msgs) + '</b>',
    '📅 За неделю: <b>+' + numFmt(wk ? wk.xp : 0) + ' XP</b>'];
  if (nt) L.push(LINE, '🔜 Следующий титул: «' + nt + '»');
  return reply(env, msg, L.join('\n'));
}

// ---------- профиль «кто ты» ----------
async function showWho(env, msg, tu, bot) {
  const chat = msg.chat.id;
  if (tu.id === bot.id) return reply(env, msg, '🤖 Я бот-модератор этого чата: наказания, правила, рейтинг, браки и РП. Список команд: <code>помощь</code>');
  const [row, st, mem, warns, mr] = await Promise.all([
    env.DB.prepare('SELECT name,username FROM m_users WHERE chat_id=? AND user_id=?').bind(chat, tu.id).first(),
    env.DB.prepare('SELECT xp,msgs,ts0,ts1 FROM m_stat WHERE chat_id=? AND user_id=?').bind(chat, tu.id).first(),
    member(env, chat, tu.id), getWarns(env, chat, tu.id), getMarriage(env, chat, tu.id),
  ]);
  const un = tu.username || (row && row.username) || '';
  const status = !mem ? '—' : mem.status === 'creator' ? '👑 Создатель чата' : mem.status === 'administrator' ? '🛡 Админ' + (mem.custom_title ? ' («' + esc(mem.custom_title) + '»)' : '') : mem.status === 'restricted' ? '🔇 Ограничен' : mem.status === 'left' ? 'вышел из чата' : mem.status === 'kicked' ? '⛔ заблокирован' : '👤 Участник';
  const LINE = '━━━━━━━━━━━━━━', num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const L = [];
  L.push('👤 ' + linkId(tu.id, nameOf(tu)) + (tu.is_bot ? ' 🤖' : '') + (un ? ' · @' + esc(un) : ''));
  L.push('🆔 <code>' + tu.id + '</code>');
  L.push(LINE);
  L.push('🎖 <b>Статус:</b> ' + status);
  if (st) {
    const l = lvlOf(st.xp), base = needFor(l), nxt = needFor(l + 1), pl = await placeOf(env, chat, st.xp);
    L.push('🏆 <b>Уровень ' + l + '</b> · «' + titleOf(l) + '»');
    L.push(bar((st.xp - base) / (nxt - base)) + ' ' + st.xp + '/' + nxt + ' XP');
    L.push('📊 Место в топе: <b>#' + pl.place + '</b> из ' + pl.total);
    L.push(LINE);
    L.push('💬 Сообщений: <b>' + num(st.msgs) + '</b>');
    L.push('📅 Замечен впервые: ' + fmtTime(st.ts0, env));
    L.push('🕐 Последняя активность: ' + fmtTime(st.ts1, env));
  } else { L.push('📊 Активность: пока нет данных'); }
  L.push(LINE);
  if (mr) { const pid = mr.a === tu.id ? mr.b : mr.a; L.push('💍 В браке с ' + linkId(pid, await nameById(env, chat, pid)) + ' · ' + daysText(mr.since)); } else L.push('💍 Не в браке');
  const bp = await env.DB.prepare('SELECT a,b,pts FROM m_rel WHERE chat_id=? AND (a=? OR b=?) ORDER BY pts DESC LIMIT 1').bind(chat, tu.id, tu.id).first();
  if (bp && bp.pts > 0) { const pid = bp.a === tu.id ? bp.b : bp.a; L.push('💞 Лучшая пара: ' + linkId(pid, await nameById(env, chat, pid)) + ' · «' + REL_LV[relLvl(bp.pts)] + '»'); }
  L.push('⚠️ Варны: ' + warns + '/' + WARN_LIMIT);
  return reply(env, msg, L.join('\n'));
}

// ---------- браки ----------
const getMarriage = (env, chat, uid) => env.DB.prepare('SELECT a,b,since FROM m_marry WHERE chat_id=? AND (a=? OR b=?) LIMIT 1').bind(chat, uid, uid).first();
function daysText(since) { const d = Math.floor((Date.now() / 1000 - since) / 86400); return d <= 0 ? 'поженились сегодня' : dayWord(d) + ' вместе'; }
async function showMarriage(env, msg, tu) {
  const chat = msg.chat.id, mr = await getMarriage(env, chat, tu.id);
  if (!mr) return reply(env, msg, '💔 ' + link(tu) + ' не в браке.\nПредложить: ответь на сообщение человека и напиши <code>жениться</code>');
  const pid = mr.a === tu.id ? mr.b : mr.a;
  return reply(env, msg, '💍 ' + link(tu) + ' в браке с ' + linkId(pid, await nameById(env, chat, pid)) + '\n💞 ' + daysText(mr.since) + '\n📅 Свадьба: ' + fmtTime(mr.since, env));
}
async function showMarriages(env, msg) {
  const chat = msg.chat.id;
  const rows = (await env.DB.prepare('SELECT a,b,since FROM m_marry WHERE chat_id=? ORDER BY since LIMIT 30').bind(chat).all()).results || [];
  if (!rows.length) return reply(env, msg, '💍 В этом чате пока нет браков. Предложи: ответь на сообщение и напиши <code>жениться</code>');
  const ids = [...new Set(rows.flatMap((r) => [r.a, r.b]))];
  const names = new Map((await env.DB.prepare('SELECT user_id,name FROM m_users WHERE chat_id=? AND user_id IN (' + ids.map(() => '?').join(',') + ')').bind(chat, ...ids).all()).results.map((r) => [r.user_id, r.name]));
  const nm = (id) => linkId(id, names.get(id) || 'Игрок');
  return reply(env, msg, '💍 <b>Браки чата</b> (' + rows.length + ')\n' + rows.map((r, i) => (i + 1) + '. ' + nm(r.a) + ' 💞 ' + nm(r.b) + ' — ' + daysText(r.since)).join('\n'));
}
async function proposeMarriage(env, msg, bot, mentions) {
  const chat = msg.chat.id, from = msg.from;
  const t = await resolveTarget(env, msg, { ids: [], names: mentions });
  if (!t || t.unknown) return reply(env, msg, 'Ответь на сообщение того, с кем хочешь пожениться, или укажи @ник.');
  const tu = t.user;
  if (tu.id === from.id) return reply(env, msg, 'Жениться на себе нельзя 🙂');
  if (tu.id === bot.id || tu.is_bot) return reply(env, msg, 'Боты вне брачного рынка 🤖');
  const m1 = await getMarriage(env, chat, from.id);
  if (m1) return reply(env, msg, 'Ты уже в браке с ' + linkId(m1.a === from.id ? m1.b : m1.a, await nameById(env, chat, m1.a === from.id ? m1.b : m1.a)) + '. Сначала <code>развод</code>.');
  const m2 = await getMarriage(env, chat, tu.id);
  if (m2) return reply(env, msg, link(tu) + ' уже в браке.');
  const d = ':' + from.id + ':' + tu.id;
  return reply(env, msg, '💍 ' + link(from) + ' делает предложение ' + link(tu) + '!\nОтвет даёт только ' + link(tu) + '.', { inline_keyboard: [[{ text: '✅ Принять', callback_data: 'mr:y' + d }, { text: '❌ Отклонить', callback_data: 'mr:n' + d }], [{ text: '↩️ Отозвать', callback_data: 'mr:c' + d }]] });
}
async function divorce(env, msg) {
  const chat = msg.chat.id, from = msg.from, mr = await getMarriage(env, chat, from.id);
  if (!mr) return reply(env, msg, 'Ты не в браке.');
  await env.DB.prepare('DELETE FROM m_marry WHERE chat_id=? AND a=? AND b=?').bind(chat, mr.a, mr.b).run();
  const pid = mr.a === from.id ? mr.b : mr.a;
  return reply(env, msg, '💔 ' + link(from) + ' и ' + linkId(pid, await nameById(env, chat, pid)) + ' больше не в браке (' + daysText(mr.since).replace(' вместе', '') + ').');
}
async function onMarryCb(env, cq) {
  const msg = cq.message, chat = msg.chat.id, from = cq.from;
  const m = /^mr:([ync]):(\d+):(\d+)$/.exec(cq.data || '');
  const ans = (t, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: t, show_alert: !!alert });
  if (!m) return ans();
  const act = m[1], a = Number(m[2]), b = Number(m[3]);
  const A = linkId(a, await nameById(env, chat, a)), B = linkId(b, await nameById(env, chat, b));
  const edit = (t) => tg(env, 'editMessageText', { chat_id: chat, message_id: msg.message_id, text: t, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
  if (act === 'c') {
    if (from.id !== a) return ans('Отозвать может только тот, кто сделал предложение.', true);
    await ans(); return edit('↩️ ' + A + ' отозвал(а) предложение для ' + B + '.');
  }
  if (from.id !== b) return ans('Это предложение не для тебя.', true);
  if (act === 'n') { await ans(); return edit('💔 ' + B + ' отклонил(а) предложение от ' + A + '.'); }
  if (await getMarriage(env, chat, a)) { await ans(); return edit('⚠️ ' + A + ' уже в браке, предложение недействительно.'); }
  if (await getMarriage(env, chat, b)) { await ans(); return edit('⚠️ ' + B + ' уже в браке, предложение недействительно.'); }
  await env.DB.prepare('INSERT OR IGNORE INTO m_marry (chat_id,a,b,since) VALUES (?,?,?,?)').bind(chat, Math.min(a, b), Math.max(a, b), Math.floor(Date.now() / 1000)).run();
  await ans('Поздравляем! 💍');
  return edit('💒 <b>Свадьба!</b>\n' + A + ' и ' + B + ' теперь в браке 💞\nУзнать: <code>мой брак</code>, список: <code>браки чата</code>');
}

// ---------- репорт ----------
const repCool = new Map();
async function doReport(env, msg, reasonText, prefixed) {
  const chat = msg.chat.id, from = msg.from, rp = msg.reply_to_message;
  if (!rp || !rp.from || rp.sender_chat) { if (prefixed) await reply(env, msg, 'Ответь командой <code>репорт</code> на сообщение нарушителя. Причину можно дописать.'); return true; }
  const tu = rp.from;
  if (tu.is_bot || tu.id === from.id) return true;
  const key = chat + ':' + from.id, now = Date.now();
  if (now - (repCool.get(key) || 0) < 60000) { await reply(env, msg, 'Подожди минуту перед следующей жалобой.'); return true; }
  const tm = await member(env, chat, tu.id);
  if (tm && (tm.status === 'creator' || tm.status === 'administrator')) { await reply(env, msg, '🛡 На админа пожаловаться нельзя.'); return true; }
  repCool.set(key, now);
  const ar = await tg(env, 'getChatAdministrators', { chat_id: chat });
  const admins = ar.ok ? ar.result.filter((a) => !a.user.is_bot).slice(0, 10) : [];
  const ping = admins.map((a) => '<a href="tg://user?id=' + a.user.id + '">⁣</a>').join('');
  const url = msg.chat.username ? 'https://t.me/' + msg.chat.username + '/' + rp.message_id : String(chat).startsWith('-100') ? 'https://t.me/c/' + String(chat).slice(4) + '/' + rp.message_id : '';
  const text = '🚨 <b>Жалоба</b>\n<b>От:</b> ' + link(from) + '\n<b>На:</b> ' + link(tu) + reasonLine(reasonText.trim().slice(0, 300)) + (url ? '\n<a href="' + url + '">Перейти к сообщению</a>' : '') + ping;
  await tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_to_message_id: rp.message_id, allow_sending_without_reply: true,
    reply_markup: { inline_keyboard: [[{ text: '⚠️ Варн', callback_data: 'rw:' + tu.id }, { text: '🔇 Мут 1ч', callback_data: 'rm:' + tu.id }], [{ text: '🗑 Удалить сообщение', callback_data: 'rd:' + rp.message_id }, { text: '✅ Закрыть', callback_data: 'rc' }]] } });
  await tg(env, 'deleteMessage', { chat_id: chat, message_id: msg.message_id });
  return true;
}
async function onReportCb(env, cq, mp) {
  const msg = cq.message, chat = msg.chat.id, from = cq.from, data = cq.data;
  const ans = (t, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: t, show_alert: !!alert });
  if (!mp.admin) return ans('Только админы.', true);
  const close = () => tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
  const note = (t) => tg(env, 'sendMessage', { chat_id: chat, text: t + '\n<b>Админ:</b> ' + link(from), parse_mode: 'HTML', reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
  if (data === 'rc') { await ans('Закрыто'); await close(); return; }
  let m = /^rd:(\d+)$/.exec(data);
  if (m) {
    const r = await tg(env, 'deleteMessage', { chat_id: chat, message_id: Number(m[1]) });
    if (!r.ok) return ans((r.description || 'Не вышло удалить').slice(0, 150), true);
    await ans('Удалено'); await close(); return note('🗑 Сообщение нарушителя удалено.');
  }
  m = /^r([wm]):(\d+)$/.exec(data); if (!m) return ans();
  const uid = Number(m[2]), tm = await member(env, chat, uid);
  if (tm && (tm.status === 'creator' || tm.status === 'administrator')) return ans('Это админ.', true);
  const row = await env.DB.prepare('SELECT name FROM m_users WHERE chat_id=? AND user_id=?').bind(chat, uid).first();
  const tu = { id: uid, first_name: row ? row.name : 'id' + uid };
  if (m[1] === 'm') {
    if (!mp.mute) return ans('Нужно право «Блокировка» или «Удаление сообщений».', true);
    const r = await doMute(env, chat, uid, 3600, nameOf(tu));
    if (!r.ok) return ans(rightsMsg(r).slice(0, 190), true);
    await ans('Готово'); await close(); return note('🔇 ' + link(tu) + ' получает мут на <b>1 час</b> по жалобе.');
  }
  const n = await addWarn(env, chat, uid, 1);
  await ans('Готово'); await close();
  if (n >= WARN_LIMIT) {
    await setWarns(env, chat, uid, 0);
    const r = await doMute(env, chat, uid, FIVE_H, nameOf(tu));
    return note('⚠️ ' + link(tu) + ' предупреждён (' + n + '/' + WARN_LIMIT + ') по жалобе.\n' + (r.ok ? '🔇 Лимит достигнут: мут на <b>' + fmtDur(FIVE_H) + '</b>.' : rightsMsg(r)));
  }
  return note('⚠️ ' + link(tu) + ' предупреждён (' + n + '/' + WARN_LIMIT + ') по жалобе.');
}

// ---------- общие текстовые команды группы ----------
async function tryChatCmds(env, msg, text, bot) {
  const chat = msg.chat.id, from = msg.from;
  if (!from || msg.sender_chat) return false;
  const whole = text.trim().replace(/^[./!]\s*/, ''), prefixed = /^\s*[./!]/.test(text);
  let m = /^([+\-])\s*рп(?![a-zа-яё])\s*([\s\S]*)$/i.exec(text.trim());
  if (m) return chatCustomCmd(env, msg, m);
  m = /^(репорт|report|жалоба|пожаловаться)(?![a-zа-яё])\s*([\s\S]*)$/i.exec(whole);
  if (m) { if (!prefixed && !msg.reply_to_message) return false; return doReport(env, msg, m[2] || '', prefixed); }
  m = /^приветствие(?:@\w+)?(?![a-zа-яё])\s*([\s\S]*)$/i.exec(whole);
  if (m && prefixed) {
    if (!perms(await member(env, chat, from.id)).admin) return true;
    const arg = m[1].trim();
    if (!arg) { const s = await getSet(env, chat); await reply(env, msg, '👋 Приветствие: ' + stateText('wel', s.wel) + '\n<blockquote>' + (s.wtext || 'стандартный текст') + '</blockquote>\nЗадать: <code>/приветствие Привет, {name}! Добро пожаловать в {chat}</code>\nВкл/выкл: <code>+приветствие</code> / <code>-приветствие</code>'); return true; }
    await env.DB.prepare('INSERT INTO m_set (chat_id,wtext) VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET wtext=excluded.wtext').bind(chat, esc(arg).slice(0, 1000)).run();
    setCache.delete(chat);
    await reply(env, msg, '✅ Текст приветствия сохранён. Не забудь включить: <code>+приветствие</code>'); return true;
  }
  const first = text.trim().split('\n')[0].trim(), mentions = [];
  const n = first.toLowerCase().replace(/^[./!]\s*/, '').replace(/@([a-z0-9_]{4,32})/g, (a, un) => { if (un !== (bot.username || '').toLowerCase()) mentions.push(un); return ''; }).replace(/[?!.,…]+$/, '').replace(/\s+/g, ' ').trim();
  if (!n || (!prefixed && /^[a-z0-9 ]+$/.test(n))) return false;
  const rp = msg.reply_to_message && msg.reply_to_message.from && !msg.reply_to_message.sender_chat ? msg.reply_to_message.from : null;
  const is = (...a) => a.includes(n);
  if (is('топ', 'top', 'рейтинг', 'топ чата', 'рейтинг чата')) { if (!topBusy(chat, 'all')) await showTop(env, msg); return true; }
  if (is('ранг', 'rank', 'мой ранг', 'уровень', 'мой уровень', 'мой рейтинг', 'lvl', 'level')) { await showRank(env, msg, rp && !rp.is_bot ? rp : from); return true; }
  if (is('кто я', 'профиль', 'me', 'инфо', 'info')) { await showWho(env, msg, n === 'кто я' ? from : rp || from, bot); return true; }
  if (is('кто ты', 'кто это', 'кто он', 'кто она', 'who', 'whois')) {
    if (rp) { await showWho(env, msg, rp, bot); return true; }
    if (n === 'кто ты') { await showWho(env, msg, bot, bot); return true; }
    if (prefixed) await reply(env, msg, 'Ответь этой командой на сообщение человека.');
    return prefixed;
  }
  if (is('отношения', 'отношение', 'совместимость')) {
    const t = await resolveTarget(env, msg, { ids: [], names: mentions });
    if (!t || t.unknown || t.user.is_bot) { if (prefixed || rp) await reply(env, msg, 'Ответь этой командой на сообщение человека или добавь @ник.'); return prefixed || !!rp; }
    await showRelation(env, msg, t.user); return true;
  }
  if (DAILY[n]) { await showDaily(env, msg, DAILY[n]); return true; }
  if (is('топ недели', 'топ неделя', 'топ неделі', 'недельный топ', 'топ за неделю', 'топ на неделю', 'неделя', 'топ недельный', 'weekly', 'top week')) { if (!topBusy(chat, 'week')) await showPeriodTop(env, msg, 'week'); return true; }
  if (is('топ месяца', 'топ месяц', 'месячный топ', 'топ за месяц', 'топ на месяц', 'топ месячный', 'месяц', 'monthly', 'top month')) { if (!topBusy(chat, 'month')) await showPeriodTop(env, msg, 'month'); return true; }
  if (is('топ пар', 'лучшие пары', 'пары чата')) { await showTopPairs(env, msg); return true; }
  if (is('рулетка', 'русская рулетка')) { await showRoulette(env, msg); return true; }
  if (is('жениться', 'пожениться', 'выйти замуж', 'предложить брак', 'marry')) { await proposeMarriage(env, msg, bot, mentions); return true; }
  if (is('развод', 'развестись', 'divorce')) { await divorce(env, msg); return true; }
  if (is('мой брак', 'моя пара', 'моя семья', 'marriage')) { await showMarriage(env, msg, from); return true; }
  if (is('брак', 'его брак', 'её брак', 'ее брак')) { if (!rp && !prefixed) return false; await showMarriage(env, msg, rp || from); return true; }
  if (is('браки', 'браки чата', 'все браки', 'marriages', 'свадьбы')) { await showMarriages(env, msg); return true; }
  return false;
}

// ---------- отношения, события дня, топ недели, рулетка ----------
function pairPct(a, b) {
  const x = Math.min(a, b) % 4294967291, y = (Math.max(a, b) * 2654435761) % 4294967291;
  let h = (x ^ y) >>> 0; h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; h ^= h >>> 16;
  return (h >>> 0) % 101;
}
// очки отношений: добрые РП и комплименты поднимают уровень отношений пары
const REL_ZERO = new Set(['ударить', 'толкнуть', 'пнуть', 'укусить', 'выгнать', 'обидеться', 'погрозить пальцем', 'дать леща', 'поддразнить', 'кинуть снежок']);
const REL_W2 = new Set(['комплимент', 'сделать комплимент', 'похвалить', 'признаться в любви', 'подарить сердце']);
const REL_STEPS = [0, 5, 15, 35, 70, 120, 200, 350];
const REL_LV = ['Незнакомцы', 'Знакомые', 'Приятели', 'Друзья', 'Близкие друзья', 'Лучшие друзья', 'Родственные души', 'Неразлучные'];
const relLvl = (p) => { let l = 0; for (let i = 0; i < REL_STEPS.length; i++) if (p >= REL_STEPS[i]) l = i; return l; };
const REL_DAILY_CAP = 15, relCool = new Map();
async function relAdd(env, chat, x, y, w) {
  const a = Math.min(x, y), b = Math.max(x, y), ck = chat + ':' + x + ':' + y, now = Math.floor(Date.now() / 1000);
  if (now - (relCool.get(ck) || 0) < 120) return null;
  if (relCool.size > 5000) relCool.clear();
  const day = dayNow();
  const r = await env.DB.prepare('SELECT pts,day,dpts FROM m_rel WHERE chat_id=? AND a=? AND b=?').bind(chat, a, b).first();
  const pts = r ? r.pts : 0, dpts = r && r.day === day ? r.dpts : 0;
  if (dpts >= REL_DAILY_CAP) return null;
  const add = Math.min(w, REL_DAILY_CAP - dpts);
  relCool.set(ck, now);
  await env.DB.prepare('INSERT INTO m_rel (chat_id,a,b,pts,day,dpts,since) VALUES (?,?,?,?,?,?,?) ON CONFLICT(chat_id,a,b) DO UPDATE SET pts=?, day=?, dpts=?')
    .bind(chat, a, b, pts + add, day, dpts + add, now, pts + add, day, dpts + add).run();
  return { w: add, ol: relLvl(pts), nl: relLvl(pts + add), pts: pts + add };
}
async function showRelation(env, msg, other) {
  const chat = msg.chat.id, me0 = msg.from;
  if (other.id === me0.id) return reply(env, msg, '🪞 Отношения с самим собой лучшие: ты точно себя понимаешь');
  const a = Math.min(me0.id, other.id), b = Math.max(me0.id, other.id);
  const r = await env.DB.prepare('SELECT pts FROM m_rel WHERE chat_id=? AND a=? AND b=?').bind(chat, a, b).first();
  const pts = r ? r.pts : 0, l = relLvl(pts), nx = REL_STEPS[l + 1];
  const mr = await getMarriage(env, chat, me0.id), wed = mr && (mr.a === other.id || mr.b === other.id);
  const pct = pairPct(me0.id, other.id);
  const prog = nx ? bar((pts - REL_STEPS[l]) / (nx - REL_STEPS[l])) + ' ' + pts + '/' + nx : bar(1) + ' ' + pts + ' (максимум)';
  return reply(env, msg, '💞 <b>Отношения</b>\n' + link(me0) + ' и ' + link(other) + '\nУровень <b>' + l + '</b> — «' + REL_LV[l] + '»\n' + prog + '\n🔮 Совместимость: ' + pct + '%' + (wed ? '\n💍 В браке: ' + daysText(mr.since) : '') + '\n\n<i>Очки дают добрые РП и комплименты.</i>');
}
async function showTopPairs(env, msg) {
  const chat = msg.chat.id;
  const rows = (await env.DB.prepare('SELECT a,b,pts FROM m_rel WHERE chat_id=? AND pts>0 ORDER BY pts DESC LIMIT 10').bind(chat).all()).results || [];
  if (!rows.length) return reply(env, msg, '💞 Пока нет пар. Дарите комплименты и добрые РП, и очки отношений начнут копиться.');
  const medal = ['🥇', '🥈', '🥉'];
  const out = [];
  for (let i = 0; i < rows.length; i++) { const r = rows[i]; out.push((medal[i] || (i + 1) + '.') + ' ' + linkId(r.a, await nameById(env, chat, r.a)) + ' + ' + linkId(r.b, await nameById(env, chat, r.b)) + ' — ' + REL_LV[relLvl(r.pts)] + ' · ' + r.pts); }
  return reply(env, msg, '💞 <b>Лучшие пары чата</b>\n' + out.join('\n'));
}
const dayNow = () => Math.floor((Date.now() / 1000 + 21600) / 86400);
const DAILY = { 'пара дня': 'pair', 'звезда дня': 'star', 'умник дня': 'smart' };
async function showDaily(env, msg, kind) {
  const chat = msg.chat.id, day = dayNow();
  let row = await env.DB.prepare('SELECT a,b FROM m_daily WHERE chat_id=? AND kind=? AND day=?').bind(chat, kind, day).first();
  if (!row) {
    const pool = ((await env.DB.prepare('SELECT user_id FROM m_stat WHERE chat_id=? AND ts1>? ORDER BY RANDOM() LIMIT 2').bind(chat, Math.floor(Date.now() / 1000) - 7 * 86400).all()).results || []).map((r) => r.user_id);
    if (pool.length < (kind === 'pair' ? 2 : 1)) return reply(env, msg, 'Пока мало активных людей. Пишите в чат, и бот выберет!');
    row = { a: pool[0], b: kind === 'pair' ? pool[1] : 0 };
    await env.DB.prepare('INSERT OR IGNORE INTO m_daily (chat_id,kind,day,a,b) VALUES (?,?,?,?,?)').bind(chat, kind, day, row.a, row.b).run();
    await env.DB.prepare('DELETE FROM m_daily WHERE day<?').bind(day - 3).run();
  }
  const A = linkId(row.a, await nameById(env, chat, row.a));
  if (kind === 'pair') { const B = linkId(row.b, await nameById(env, chat, row.b)); return reply(env, msg, '💞 <b>Пара дня</b>\n' + A + ' + ' + B + '\nСовместимость: <b>' + pairPct(row.a, row.b) + '%</b> ' + bar(pairPct(row.a, row.b) / 100) + '\nСледующая пара будет завтра.'); }
  return reply(env, msg, kind === 'star' ? '🌟 <b>Звезда дня</b> — ' + A + '\nСегодня все аплодисменты ему(ей)!' : '🧠 <b>Умник дня</b> — ' + A + '\nСамый мудрый в чате сегодня.');
}
async function showPeriodTop(env, msg, period) {
  const chat = msg.chat.id, medal = ['🥇', '🥈', '🥉'], isW = period === 'week';
  const tbl = isW ? 'm_week' : 'm_month', col = isW ? 'wk' : 'mo', cur = isW ? wkNow() : moNow();
  const rows = (await env.DB.prepare('SELECT w.user_id AS id, w.xp AS xp, w.msgs AS msgs, u.name AS name FROM ' + tbl + ' w LEFT JOIN m_users u ON u.chat_id=w.chat_id AND u.user_id=w.user_id WHERE w.chat_id=? AND w.' + col + '=? ORDER BY w.xp DESC LIMIT 10').bind(chat, cur).all()).results || [];
  if (!rows.length) return reply(env, msg, (isW ? '📅 На этой неделе' : '🗓 В этом месяце') + ' пока тихо. Пишите в чат, и опыт начнёт копиться.');
  return reply(env, msg, (isW ? '📅 <b>Топ недели</b> (сбрасывается каждый понедельник)' : '🗓 <b>Топ месяца</b> (сбрасывается 1 числа)') + '\n' + rows.map((r, i) => (medal[i] || (i + 1) + '.') + ' ' + linkId(r.id, r.name || 'Игрок') + ' — ' + r.xp + ' XP · ' + (r.msgs || 0) + ' сообщ.').join('\n'));
}
async function showRoulette(env, msg) {
  const hit = Math.floor(Math.random() * 6) === 0;
  return reply(env, msg, hit ? '💥 <b>Бах!</b> ' + link(msg.from) + ' выбывает из раунда (понарошку). Следующий?' : '🔫 Щёлк... ' + link(msg.from) + ' повезло. Крути ещё!');
}

// ---------- inline: РП с кнопками «Принять / Отклонить» ----------
const inlCache = new Map();
async function rememberInline(env, u) {
  if (!u || u.is_bot) return;
  const sig = (u.username || '') + '|' + nameOf(u), prev = inlCache.get(u.id);
  if (prev === sig) return;
  inlCache.set(u.id, sig);
  await env.DB.prepare('INSERT INTO m_inl (user_id,name,username) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,username=excluded.username').bind(u.id, nameOf(u), (u.username || '').toLowerCase()).run();
}
async function onInlineQuery(env, iq) {
  const u = iq.from; await rememberInline(env, u);
  const raw = (iq.query || '').trim(), q = raw.toLowerCase();
  const answer = (results) => tg(env, 'answerInlineQuery', { inline_query_id: iq.id, results: results.slice(0, 50), cache_time: 1, is_personal: true });
  // калькулятор: если это пример — показываем только ответ, если нет и это не РП — ничего
  if (raw && /[0-9]/.test(raw) && /[+\-*/%^×÷xх:]/.test(raw.replace(/^\s*[+\-]/, ''))) {
    const r = calc(raw.replace(/:/g, '/'));
    if (r !== null) {
      const shown = raw.replace(/\s+/g, ' ');
      return answer([{ type: 'article', id: 'calc', title: '= ' + r, description: shown + ' = ' + r, input_message_content: { message_text: esc(shown) + ' = <b>' + r + '</b>', parse_mode: 'HTML' } }]);
    }
  }
  const results = [];
  const kbd = (code) => ({ inline_keyboard: [[{ text: '✅ Принять', callback_data: 'ir:y:' + code + ':' + u.id }, { text: '❌ Отклонить', callback_data: 'ir:n:' + code + ':' + u.id }]] });
  const card = (id, emo, key, code) => ({
    type: 'article', id, title: emo + ' ' + key.charAt(0).toUpperCase() + key.slice(1), description: 'Предложить: ' + key,
    input_message_content: { message_text: '💫 ' + link(u) + ' хочет «<b>' + esc(key) + '</b>».\nЖдём ответа: решает тот, кто нажмёт первым.', parse_mode: 'HTML' },
    reply_markup: kbd(code),
  });
  const mine = (await env.DB.prepare('SELECT id,key FROM m_crp WHERE scope=? ORDER BY id').bind('u:' + u.id).all()).results || [];
  for (const c of mine) if (!q || c.key.includes(q)) results.push(card('c' + c.id, '⭐', c.key, 'c' + c.id));
  const POP = ['обнять', 'поцеловать', 'погладить', 'дать пять', 'признаться в любви', 'пригласить на свидание', 'подарить цветы', 'угостить кофе', 'сделать комплимент', 'похвалить', 'поддержать', 'поздравить', 'сказать спасибо', 'взять за руку', 'подмигнуть'];
  const order = [...POP.filter((k) => RP[k]), ...RPLIST.filter((k) => !POP.includes(k))];
  for (const k of order) {
    if (q && !k.includes(q)) continue;
    const idx = RPLIST.indexOf(k);
    results.push(card('rp' + idx, RP[k][0].split(' ')[0], k, String(idx)));
  }
  return answer(results);
}
async function onInlineCallback(env, cq) {
  const ans = (t, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: t, show_alert: !!alert });
  const m = /^ir:([yn]):(c?\d+):(\d+)$/.exec(cq.data || '');
  if (!m) return ans();
  let key, tpl;
  if (m[2][0] === 'c') {
    const row = await env.DB.prepare('SELECT key,text FROM m_crp WHERE id=?').bind(Number(m[2].slice(1))).first();
    if (!row) return ans('Эта команда удалена.', true);
    key = row.key; tpl = row.text;
  } else {
    key = RPLIST[Number(m[2])]; if (!key) return ans();
    tpl = pick(RP[key]);
  }
  const sid = Number(m[3]), presser = cq.from;
  if (presser.id === sid) return ans('Это твоё предложение. Ждём ответа 🙂', true);
  const r = await env.DB.prepare('INSERT OR IGNORE INTO m_ido (id,ts) VALUES (?,?)').bind(cq.inline_message_id, Math.floor(Date.now() / 1000)).run();
  if (!(r && r.meta && r.meta.changes)) return ans('Уже решено.', true);
  const row = await env.DB.prepare('SELECT name FROM m_inl WHERE user_id=?').bind(sid).first();
  const A = linkId(sid, row ? row.name : 'Игрок'), B = link(presser);
  const text = m[1] === 'y' ? tpl.replace('{a}', A).replace('{b}', B) + '\n✅ Принято!' : '💔 ' + B + ' отклоняет «' + esc(key) + '» от ' + A + '.';
  await ans(m[1] === 'y' ? 'Принято 💫' : 'Отклонено');
  return tg(env, 'editMessageText', { inline_message_id: cq.inline_message_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
}

// ---------- свои РП-команды ----------
const crpCache = new Map();
function parseTpl(raw) {
  const m = /^([^|]{1,30})\|([\s\S]{1,200})$/.exec((raw || '').trim());
  if (!m) return null;
  const key = m[1].trim().toLowerCase().replace(/\s+/g, ' ').replace(/^[./!]/, '');
  let tpl = m[2].trim();
  if (!key || /[@{}]/.test(key) || !tpl) return null;
  if (!tpl.includes('{a}') && !tpl.includes('{b}')) tpl = '💫 {a} ' + tpl + ' {b}';
  return { key, tpl: esc(tpl) };
}
async function addCustom(env, scope, raw) {
  const p = parseTpl(raw);
  if (!p) return 'Формат: <code>название | текст</code>\nПримеры:\n<code>пнуть | пнул(а)</code>\n<code>ударить | 👊 {a} ударил(а) {b}</code>\nВ тексте {a} — кто делает, {b} — кому. Если их нет, бот сам поставит.';
  if (RP[p.key]) return 'Такая команда уже есть встроенная. Придумай другое название.';
  const n = (await env.DB.prepare('SELECT COUNT(*) AS c FROM m_crp WHERE scope=?').bind(scope).first()).c;
  const ex = await env.DB.prepare('SELECT 1 AS x FROM m_crp WHERE scope=? AND key=?').bind(scope, p.key).first();
  if (!ex && n >= 20) return 'Максимум 20 своих команд. Удали лишние: <code>-рп название</code> (в личке <code>/delrp название</code>).';
  await env.DB.prepare('INSERT INTO m_crp (scope,key,text) VALUES (?,?,?) ON CONFLICT(scope,key) DO UPDATE SET text=excluded.text').bind(scope, p.key, p.tpl).run();
  crpCache.clear();
  return '✅ Команда «<b>' + esc(p.key) + '</b>» сохранена.\nПример: ' + p.tpl.replace('{a}', 'Аня').replace('{b}', 'Борис');
}
async function delCustom(env, scope, key) {
  const k = (key || '').trim().toLowerCase().replace(/^[./!]/, '').replace(/\s+/g, ' ');
  if (!k) return 'Напиши название: <code>-рп название</code>';
  const r = await env.DB.prepare('DELETE FROM m_crp WHERE scope=? AND key=?').bind(scope, k).run();
  crpCache.clear();
  return r.meta && r.meta.changes ? '🗑 Команда «' + esc(k) + '» удалена.' : 'Такой команды нет.';
}
async function listCustom(env, scope) {
  const rows = (await env.DB.prepare('SELECT key,text FROM m_crp WHERE scope=? ORDER BY id').bind(scope).all()).results || [];
  return rows.length ? '⭐ <b>Свои команды</b>\n' + rows.map((r) => '• ' + esc(r.key) + ' — ' + r.text.replace('{a}', 'Аня').replace('{b}', 'Борис')).join('\n') : 'Своих команд пока нет. Добавить: <code>/addrp название | текст</code>';
}
async function customPrivate(env, msg, cmd, arg) {
  const scope = 'u:' + msg.from.id;
  const text = cmd === 'addrp' ? await addCustom(env, scope, arg) : cmd === 'delrp' ? await delCustom(env, scope, arg) : await listCustom(env, scope);
  return tg(env, 'sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML' });
}
async function customRows(env, chat, uid) {
  const key = chat + ':' + uid, c = crpCache.get(key);
  if (c && Date.now() - c.t < 60000) return c.v;
  const v = (await env.DB.prepare('SELECT key,text FROM m_crp WHERE scope IN (?,?)').bind('c:' + chat, 'u:' + uid).all()).results || [];
  if (crpCache.size > 2000) crpCache.clear();
  crpCache.set(key, { v, t: Date.now() });
  return v;
}
async function tryCustomRp(env, msg, text, bot) {
  const chat = msg.chat.id, from = msg.from;
  const rows = await customRows(env, chat, from.id);
  if (!rows.length) return false;
  const lines = text.trim().split('\n'), comment = lines.slice(1).join(' ').trim().slice(0, 300);
  const t0 = lines[0].trim().toLowerCase().replace(/^[./!]/, '').replace(/\s+/g, ' ');
  const nm = /@([a-z0-9_]{4,32})\s*$/.exec(t0), base = nm ? t0.slice(0, nm.index).trim() : t0;
  const row = rows.find((r) => r.key === base);
  if (!row) return false;
  const t = await resolveTarget(env, msg, { ids: [], names: nm ? [nm[1]] : [] });
  if (!t || t.unknown) return false;
  const tu = t.user;
  let out;
  if (tu.id === bot.id) out = '🥹 Мне? Спасибо, ' + link(from) + '!';
  else if (tu.id === from.id) out = '🫂 ' + link(from) + ' обращается к самому себе. Держись, мы с тобой';
  else out = row.text.replace('{a}', link(from)).replace('{b}', link(tu));
  if (comment) out += '\n💬 <i>' + esc(comment) + '</i>';
  await reply(env, msg, out);
  return true;
}
async function chatCustomCmd(env, msg, m) {
  if (!perms(await member(env, msg.chat.id, msg.from.id)).admin) return true;
  const scope = 'c:' + msg.chat.id;
  const text = m[1] === '+' ? await addCustom(env, scope, m[2]) : await delCustom(env, scope, m[2]);
  await reply(env, msg, text);
  return true;
}

// ---------- личка (Business): РП, анимации, калькулятор ----------
function calc(src) {
  const s = src.replace(/(\d)\s*[xх]\s*(?=[\d(])/gi, '$1*').replace(/\s+/g, '').replace(/,/g, '.').replace(/[×·]/g, '*').replace(/÷/g, '/');
  if (!s || s.length > 80 || !/^[0-9+\-*/%^().]+$/.test(s)) return null;
  let i = 0;
  const num = () => { const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(s.slice(i)); if (!m) throw 0; i += m[0].length; return parseFloat(m[0]); };
  const prim = () => { if (s[i] === '(') { i++; const v = expr(); if (s[i] !== ')') throw 0; i++; return v; } return num(); };
  const un = () => { if (s[i] === '-') { i++; return -un(); } if (s[i] === '+') { i++; return un(); } return pw(); };
  const pw = () => { const b = prim(); if (s[i] === '^') { i++; const e = un(); return Math.pow(b, e); } return b; };
  const term = () => { let v = un(); while (s[i] === '*' || s[i] === '/' || s[i] === '%') { const o = s[i++]; const r = un(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; };
  const expr = () => { let v = term(); while (s[i] === '+' || s[i] === '-') { const o = s[i++]; const r = term(); v = o === '+' ? v + r : v - r; } return v; };
  try { const v = expr(); if (i !== s.length || !isFinite(v)) return null; return +v.toPrecision(12); } catch (e) { return null; }
}
const BALL = ['Бесспорно ✅', 'Предрешено ✅', 'Никаких сомнений ✅', 'Определённо да ✅', 'Знаки говорят — да 👍', 'Пока не ясно, спроси позже 🌫', 'Лучше не рассказывать 🤐', 'Сконцентрируйся и спроси ещё раз 🔮', 'Даже не думай ❌', 'Мой ответ — нет ❌', 'Весьма сомнительно 🤔', 'Перспективы не очень 👎'];
async function ownerExtra(env, cid, conn, msg, text) {
  if (!msg.chat || msg.chat.type !== 'private') return false;
  const full = text.replace(/^\s*\./, '').trim();
  const lines = full.split('\n'), t = lines[0].trim().replace(/\s+/g, ' '), tl = t.toLowerCase();
  const chat = msg.chat.id;
  const editHtml = async (html) => (await tg(env, 'editMessageText', { business_connection_id: cid, chat_id: chat, message_id: msg.message_id, text: html, parse_mode: 'HTML' })).ok;
  const del = () => tg(env, 'deleteBusinessMessages', { business_connection_id: cid, message_ids: [msg.message_id] });
  const note = (x) => tg(env, 'sendMessage', { chat_id: conn.user_chat_id, text: x, parse_mode: 'HTML' });
  const finish = async (html) => { if (await editHtml(html)) return; await del(); await tg(env, 'sendMessage', { business_connection_id: cid, chat_id: chat, text: html, parse_mode: 'HTML' }); };

  if (/^(рп|rp)$/.test(tl)) { await del(); await note('🎭 <b>РП-команды</b> (пиши с точкой, вторая строка — твой комментарий)\n\n' + RP_KEYS.slice().sort().join(', ')); return true; }
  const key = RP_KEYS.find((k) => tl === k || tl.startsWith(k + ' '));
  if (key) {
    const comment = [t.slice(key.length).trim(), ...lines.slice(1)].join(' ').trim().slice(0, 300);
    await finish(pick(RP[key]).replace('{a}', link(msg.from)).replace('{b}', link(msg.chat)) + (comment ? '\n💬 <i>' + esc(comment) + '</i>' : ''));
    return true;
  }
  const crow = (await env.DB.prepare('SELECT key,text FROM m_crp WHERE scope=?').bind('u:' + conn.owner_id).all()).results || [];
  const ck = crow.find((r) => tl === r.key || tl.startsWith(r.key + ' '));
  if (ck) {
    const comment = [t.slice(ck.key.length).trim(), ...lines.slice(1)].join(' ').trim().slice(0, 300);
    await finish(ck.text.replace('{a}', link(msg.from)).replace('{b}', link(msg.chat)) + (comment ? '\n💬 <i>' + esc(comment) + '</i>' : ''));
    return true;
  }
  let m;
  if ((m = /^(?:печатает|печать|type)(?:\s+([\s\S]+))?$/i.exec(full))) {
    const s = (m[1] || '').trim().slice(0, 150);
    if (!s) { await del(); await note('Формат: <code>.печатает текст</code>'); return true; }
    const step = Math.max(1, Math.ceil(s.length / 12));
    for (let k = step; k < s.length; k += step) { const ok = await editHtml(esc(s.slice(0, k)) + '▌'); if (!ok && k === step) break; await sleep(450); }
    await finish(esc(s)); return true;
  }
  if ((m = /^(?:загрузка|load|loading)(?:\s+([\s\S]+))?$/i.exec(full))) {
    const label = (m[1] || 'Загрузка').trim().slice(0, 60);
    for (let p = 0; p <= 100; p += 10) { const ok = await editHtml('⏳ <b>' + esc(label) + '</b>\n' + '▰'.repeat(p / 10) + '▱'.repeat(10 - p / 10) + ' ' + p + '%'); if (!ok && p === 0) break; await sleep(500); }
    await finish('✅ <b>' + esc(label) + '</b> — готово'); return true;
  }
  if ((m = /^(?:calc|кальк|счёт|счет|посчитай)\s+([\s\S]+)$/i.exec(full))) {
    const ex = m[1].trim(), r = calc(ex);
    if (r === null) { await del(); await note('Не понял выражение: <code>' + esc(ex) + '</code>\nМожно: + − * / % ^ и скобки.'); return true; }
    await finish('🧮 ' + esc(ex) + ' = <b>' + r + '</b>'); return true;
  }
  if ((m = /^(?:рандом|random|rand|число)(?:\s+(-?\d+)(?:\s+(-?\d+))?)?$/i.exec(tl))) {
    let a = 1, b = 100;
    if (m[2] != null) { a = parseInt(m[1], 10); b = parseInt(m[2], 10); } else if (m[1] != null) b = parseInt(m[1], 10);
    if (a > b) [a, b] = [b, a];
    a = Math.max(-1e12, a); b = Math.min(1e12, b);
    await finish('🎲 Случайное число от ' + a + ' до ' + b + ': <b>' + (a + Math.floor(Math.random() * (b - a + 1))) + '</b>'); return true;
  }
  if ((m = /^(?:шанс|вероятность|chance)\s+([\s\S]+)$/i.exec(full))) { await finish('🎯 ' + esc(m[1].trim().slice(0, 200)) + '\nВероятность: <b>' + Math.floor(Math.random() * 101) + '%</b>'); return true; }
  if ((m = /^(?:шар|8ball|ball)\s+([\s\S]+)$/i.exec(full))) { await finish('🔮 ' + esc(m[1].trim().slice(0, 200)) + '\n<b>' + pick(BALL) + '</b>'); return true; }
  return false;
}

// ---------- вход ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
      let u; try { u = await req.json(); } catch (e) { return new Response('ok'); }
      try {
        await ensureSchema(env);
        if (u.message) {
          const t = u.message.chat && u.message.chat.type;
          if (t === 'group' || t === 'supergroup') await onGroupMessage(env, u.message);
          else if (t === 'private') await onPrivate(env, u.message);
        } else if (u.callback_query) await onCallback(env, u.callback_query);
        else if (u.inline_query) await onInlineQuery(env, u.inline_query);
        else if (u.chat_member) await rememberUser(env, u.chat_member.chat.id, u.chat_member.new_chat_member && u.chat_member.new_chat_member.user);
        else if (u.business_connection) await onConnection(env, u.business_connection);
        else if (u.business_message) await onBusinessMessage(env, u.business_message);
        else if (u.deleted_business_messages) await onBusinessDeleted(env, u.deleted_business_messages);
      } catch (e) { console.log('error', e && e.stack || e); }
      return new Response('ok');
    }
    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      await ensureSchema(env);
      const out = {};
      out.webhook = await tg(env, 'setWebhook', { url: url.origin + '/webhook', secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query', 'chat_member', 'business_connection', 'business_message', 'deleted_business_messages', 'inline_query'], drop_pending_updates: true });
      out.rights = await tg(env, 'setMyDefaultAdministratorRights', { rights: { can_manage_chat: true, can_delete_messages: true, can_restrict_members: true, can_pin_messages: true, can_invite_users: true, is_anonymous: false, can_change_info: false, can_promote_members: false, can_manage_video_chats: false }, for_channels: false });
      out.commands = await tg(env, 'setMyCommands', { commands: [{ command: 'help', description: 'Список команд' }, { command: 'rules', description: 'Правила чата' }, { command: 'top', description: 'Рейтинг чата' }, { command: 'rank', description: 'Мой уровень' }, { command: 'marriages', description: 'Браки чата' }, { command: 'settings', description: 'Настройки чата (для админов)' }] });
      return new Response(JSON.stringify(out, null, 1), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Бот-модератор: работает');
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(notifyExpired(env)); },
};
