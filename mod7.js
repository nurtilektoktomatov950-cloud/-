// Бот-модератор чатов + личные команды через Telegram Business. Cloudflare Worker + D1.
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
    'CREATE TABLE IF NOT EXISTS m_mutes (chat_id INTEGER, user_id INTEGER, until INTEGER, name TEXT, PRIMARY KEY (chat_id, user_id))',
    'CREATE TABLE IF NOT EXISTS m_bconn (id TEXT PRIMARY KEY, owner_id INTEGER, user_chat_id INTEGER, enabled INTEGER)',
    'CREATE TABLE IF NOT EXISTS m_bmutes (conn_id TEXT, chat_id INTEGER, until INTEGER, PRIMARY KEY (conn_id, chat_id))',
  ];
  for (const s of q) await env.DB.prepare(s).run();
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
  help: ['помощь', 'help', 'команды'],
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

// ---------- РП-команды ----------
const RP = {
  'обнять': ['🤗 {a} крепко обнимает {b}', '🫂 {a} заключает {b} в объятия'],
  'поцеловать': ['😘 {a} целует {b} в щёчку', '💋 {a} дарит {b} воздушный поцелуй'],
  'погладить': ['🥰 {a} гладит {b} по голове', '🐱 {a} ласково гладит {b}'],
  'дать пять': ['🙌 {a} даёт пять {b}', '✋ {a} и {b} хлопают в ладоши'],
  'пожать руку': ['🤝 {a} жмёт руку {b}', '🤝 {a} уважительно пожимает руку {b}'],
  'похвалить': ['👏 {a} хвалит {b}: молодец!', '🌟 {a} говорит {b}: ты супер!'],
};
const RP_KEYS = Object.keys(RP).sort((x, y) => y.length - x.length);
async function tryRp(env, msg, text) {
  const t = text.trim().toLowerCase().replace(/^[./!]/, '').replace(/\s+/g, ' ');
  const key = RP_KEYS.find((k) => t === k || t.startsWith(k + ' @'));
  if (!key) return false;
  const nm = /@([a-z0-9_]{4,32})\s*$/.exec(t);
  const tg0 = await resolveTarget(env, msg, { ids: [], names: nm ? [nm[1]] : [] });
  if (!tg0 || tg0.unknown) return false;
  const from = msg.from, a = link(from), tu = tg0.user, bot = await me(env);
  let out;
  if (tu.id === bot.id) out = '🥹 Мне? Спасибо, ' + a + '!';
  else if (tu.id === from.id) out = '🫂 ' + a + ' обнимает сам себя. Держись, мы с тобой';
  else out = pick(RP[key]).replace('{a}', a).replace('{b}', link(tu));
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

function help() {
  return '<b>Команды для админов</b> (нажми, чтобы развернуть)\n<blockquote expandable>' +
    'Пиши ответом на сообщение, по @нику или id. Можно по-русски и по-английски, с точкой, слэшем или без.\n\n' +
    '<b>мут</b> — без срока: навсегда, пока не снимут\n' +
    '<b>мут 10 минут</b> — на срок (2ч, 1д, 1h30m). Причину пиши с новой строки\n' +
    '<b>размут</b> — снять мут\n' +
    '<b>бан</b> — бан навсегда  ·  <b>разбан</b>\n' +
    '<b>варн</b> — предупреждение, за 3 варна мут на 5 часов\n' +
    '<b>снять варн</b>  ·  <b>варны</b> — сколько у человека\n' +
    '<b>правила</b> — показать  ·  <b>+правило текст</b>  ·  <b>-правило 2</b>\n' +
    '<b>РП (все, ответом):</b> обнять, поцеловать, погладить, дать пять, пожать руку, похвалить\n\n' +
    'Бан: нужно право блокировки. Мут: блокировка или удаление сообщений. Варн: любой админ.' +
    '</blockquote>';
}

async function onGroupMessage(env, msg) {
  const chat = msg.chat.id, from = msg.from;
  if (!from) return;
  await rememberUser(env, chat, from);
  if (msg.reply_to_message && msg.reply_to_message.from) await rememberUser(env, chat, msg.reply_to_message.from);
  for (const nu of msg.new_chat_members || []) await rememberUser(env, chat, nu);
  if (msg.left_chat_member) await rememberUser(env, chat, msg.left_chat_member);
  if (msg.forward_origin && msg.forward_origin.sender_user) await rememberUser(env, chat, msg.forward_origin.sender_user);
  const text = msg.text || msg.caption;
  if (!text) return;
  const bot = await me(env);
  if (await tryRp(env, msg, text)) return;
  const cmd = parseCommand(text, msg.entities || msg.caption_entities, bot.username);
  if (!cmd) return;
  const lines = cmd.rest.split('\n');
  const first = lines[0], more = lines.slice(1).join('\n');

  if (cmd.cmd === 'rules') { if (!cmd.prefixed && cmd.rest.trim()) return; return showRules(env, msg); }
  if (cmd.cmd === 'help') { if (!cmd.prefixed) return; return reply(env, msg, help()); }
  if (cmd.cmd === 'spam') return;

  if (cmd.cmd.startsWith('rp:')) {
    const t = await resolveTarget(env, msg, cmd);
    if (!t || t.unknown) { if (cmd.prefixed) await reply(env, msg, 'Ответь на сообщение того, к кому обращаешься.'); return; }
    const [emo, act] = RP[cmd.cmd.slice(3)];
    const self = t.id === from.id, isBot = t.id === bot.id;
    const who = self ? 'самого себя' : isBot ? 'меня' : link(t.user);
    return reply(env, msg, emo + ' ' + link(from) + ' ' + act + ' ' + (self ? '— сам себя, и это тоже мило 🥹' : isBot ? 'меня 🥹' : link(t.user)));
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
  if (!msg || !msg.chat) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const chat = msg.chat.id, from = cq.from;
  const mp = perms(await member(env, chat, from.id));
  const deny = (t) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: t, show_alert: true });
  if (data === 'ar') {
    if (!mp.admin) return deny('Только админы могут добавлять правила.');
    return deny('Напиши в чат: +правило текст правила');
  }
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
  const bot = await me(env);
  const url = 'https://t.me/' + bot.username + '?startgroup=true&admin=delete_messages+restrict_members+pin_messages+invite_users';
  const text = '👮 <b>Бот-модератор</b>\n' +
    '<b>Команды в личке</b> (бот подключён к аккаунту, пиши с точкой):\n' +
    '<blockquote><code>.mut</code> — мут навсегда\n<code>.mut 10m</code> — мут на время (30s, 2h, 1d)\n<code>.unmut</code> — снять мут\n<code>.spam 5 слово</code> — повторить слово 5 раз</blockquote>\n\n' + help();
  return tg(env, 'sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '➕ Добавить в чат', url }]] } });
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
async function onBusinessMessage(env, msg) {
  const cid = msg.business_connection_id; if (!cid || !msg.from) return;
  const conn = await getConn(env, cid); if (!conn || !conn.enabled) return;
  const chat = msg.chat.id, now = Math.floor(Date.now() / 1000);
  if (msg.from.id !== conn.owner_id) {
    const m = await env.DB.prepare('SELECT until FROM m_bmutes WHERE conn_id=? AND chat_id=?').bind(cid, chat).first();
    if (m && (m.until === 0 || m.until > now)) await tg(env, 'deleteBusinessMessages', { business_connection_id: cid, message_ids: [msg.message_id] });
    else if (m) await env.DB.prepare('DELETE FROM m_bmutes WHERE conn_id=? AND chat_id=?').bind(cid, chat).run();
    return;
  }
  const text = msg.text; if (!text || !/^\s*[.]/.test(text)) return;
  const m = /^\s*\.([a-zа-яё]+)([\s\S]*)$/i.exec(text); if (!m) return;
  const c = WORD2CMD[m[1].toLowerCase()]; if (!['mute', 'unmute', 'spam'].includes(c)) return;
  const del = () => tg(env, 'deleteBusinessMessages', { business_connection_id: cid, message_ids: [msg.message_id] });
  const note = (t) => tg(env, 'sendMessage', { chat_id: conn.user_chat_id, text: t, parse_mode: 'HTML' });
  const who = nameOf(msg.chat);
  if (msg.chat.type !== 'private') return;
  if (c === 'mute') {
    const d = parseDur(m[2].split('\n')[0]); const sec = d.sec === null ? 0 : d.sec;
    await env.DB.prepare('INSERT INTO m_bmutes (conn_id,chat_id,until) VALUES (?,?,?) ON CONFLICT(conn_id,chat_id) DO UPDATE SET until=excluded.until').bind(cid, chat, sec ? now + sec : 0).run();
    await del(); await note('🔇 ' + esc(who) + ': его сообщения удаляются <b>' + fmtDur(sec) + '</b>. Снять: <code>.unmut</code> в том же чате.');
  } else if (c === 'unmute') {
    await env.DB.prepare('DELETE FROM m_bmutes WHERE conn_id=? AND chat_id=?').bind(cid, chat).run();
    await del(); await note('🔊 ' + esc(who) + ': мут снят.');
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
        else if (u.chat_member) await rememberUser(env, u.chat_member.chat.id, u.chat_member.new_chat_member && u.chat_member.new_chat_member.user);
        else if (u.business_connection) await onConnection(env, u.business_connection);
        else if (u.business_message) await onBusinessMessage(env, u.business_message);
      } catch (e) { console.log('error', e && e.stack || e); }
      return new Response('ok');
    }
    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      await ensureSchema(env);
      const out = {};
      out.webhook = await tg(env, 'setWebhook', { url: url.origin + '/webhook', secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query', 'chat_member', 'business_connection', 'business_message'], drop_pending_updates: true });
      out.rights = await tg(env, 'setMyDefaultAdministratorRights', { rights: { can_manage_chat: true, can_delete_messages: true, can_restrict_members: true, can_pin_messages: true, can_invite_users: true, is_anonymous: false, can_change_info: false, can_promote_members: false, can_manage_video_chats: false }, for_channels: false });
      out.commands = await tg(env, 'setMyCommands', { commands: [{ command: 'help', description: 'Список команд' }, { command: 'rules', description: 'Правила чата' }] });
      return new Response(JSON.stringify(out, null, 1), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Бот-модератор: работает');
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(notifyExpired(env)); },
};
