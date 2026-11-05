// 깡통 노선도 - shared state, storage, data access and AI helpers

export const MODULE = 'kkangtong_subway';
export const LOG = '[깡통 노선도]';
export const TOAST = '깡통 노선도';

export const STATUS = {
    run: { icon: '🟢', label: '운행중' },
    stop: { icon: '🟡', label: '정차중' },
    end: { icon: '🏁', label: '종착' },
    test: { icon: '🧪', label: '시험운행' },
    rest: { icon: '💤', label: '운휴' },
};

export const LINE_COLORS = ['#e07a5f', '#7b6cf6', '#3fa7d6', '#e9a23b', '#d6609a', '#3fae8f', '#9a6bd8', '#c9773e'];

export const defaultSettings = Object.freeze({
    profileId: '',
    summaryMessages: 40,
    outputLanguage: 'Korean',
    theme: 'auto',
    announce: 'away', // away | always | off
    announceDays: 60, // "오랜만" = this many days since the last message
    askBranchName: true,
    announceVer: 0,
    pinnedBots: [],
    viewMode: 'tree', // tree | status | line
    autoStatus: true, // fill 🧪/🟢/💤 for chats the user has not tagged (🏁 is always manual)
    autoDays: 14, // 이 안에 탔으면 🟢 운행중
    restDays: 60, // 이만큼 넘게 안 탔으면 💤 운휴, 그 사이는 🟡 정차중
    cleanShortMax: 4,
    cleanStaleDays: 90,
    cleanStaleMax: 20,
    lines: {}, // avatar -> [{ id, name, color }]
    chats: {},
});

export const BULK_CONCURRENCY = 3;

// Late-bound hooks so modules can call each other without import cycles.
export const app = {
    render: () => {},
    refresh: async () => {},
    closePopup: () => {},
    openPopup: () => {},
};

export const state = {
    open: false,
    tab: 'map', // map | recent | stats
    view: 'main', // main | ticket
    avatar: null, // character whose map is shown
    charName: '',
    list: [],
    byId: new Map(),
    children: new Map(),
    roots: [],
    groupColor: new Map(),
    selectedId: null,
    collapsed: new Set(),
    sort: 'recent',
    query: '',
    filter: 'all',
    selectMode: false,
    checked: new Set(),
    reasons: new Map(),
    editing: false,
    summarizing: new Set(),
    bulk: null,
    loading: false,
    error: '',
    mobileDetail: false,
    divergence: new Map(), // `${avatar}|${id}` -> result | 'loading' | 'error'
    compare: null, // { target, busy, result }
    hub: null, // { at, bots, chats }
    hubLoading: false,
    hubQuery: '',
    ticket: null,
    peek: null,
    tails: new Map(),
    lineFilter: null, // null | 'none' | lineId
    groupCollapsed: new Set(),
    lineEdit: null,
    hubSort: 'recent',
    hubDormant: false,
    statsPeriod: 'all',
};

// ---------------------------------------------------------------- settings / storage

export const ctx = () => SillyTavern.getContext();

export function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(defaultSettings);
    const s = extensionSettings[MODULE];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) s[key] = structuredClone(defaultSettings[key]);
    }
    return s;
}

export function save() {
    ctx().saveSettingsDebounced();
}

export function storeFor(avatar = state.avatar) {
    const s = getSettings();
    if (!avatar) return {};
    if (!s.chats[avatar]) s.chats[avatar] = {};
    return s.chats[avatar];
}

export function entry(id, avatar = state.avatar) {
    return storeFor(avatar)[id] || {};
}

export function setEntry(id, patch, avatar = state.avatar) {
    const st = storeFor(avatar);
    const next = { ...(st[id] || {}), ...patch };
    for (const k of Object.keys(next)) {
        if (next[k] === undefined || next[k] === '' || next[k] === false || next[k] === null) delete next[k];
    }
    if (Object.keys(next).length) st[id] = next;
    else delete st[id];
    save();
}

// ---------------------------------------------------------------- my lines (user-defined groups)

export function linesFor(avatar = state.avatar) {
    const s = getSettings();
    if (!s.lines || typeof s.lines !== 'object') s.lines = {};
    if (!Array.isArray(s.lines[avatar])) s.lines[avatar] = [];
    return s.lines[avatar];
}

export function lineById(id, avatar = state.avatar) {
    return id ? linesFor(avatar).find((l) => l.id === id) || null : null;
}

export function addLine(name, avatar = state.avatar) {
    const ls = linesFor(avatar);
    const used = new Set(ls.map((l) => l.color));
    const color = LINE_COLORS.find((x) => !used.has(x)) || LINE_COLORS[ls.length % LINE_COLORS.length];
    const line = { id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: String(name).trim().slice(0, 24), color };
    ls.push(line);
    save();
    return line;
}

export function removeLine(id, avatar = state.avatar) {
    const ls = linesFor(avatar);
    const i = ls.findIndex((l) => l.id === id);
    if (i >= 0) ls.splice(i, 1);
    for (const e of Object.values(storeFor(avatar))) if (e.line === id) delete e.line;
    save();
}

// ---------------------------------------------------------------- text & time helpers

export function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function plain(html) {
    const text = new DOMParser().parseFromString(String(html ?? ''), 'text/html').body.textContent || '';
    return text.replace(/\s+/g, ' ').trim();
}

/** What the user actually sees: the translation from translator extensions (extra.display_text) if present. */
export function shownText(m) {
    return plain(m?.extra?.display_text || m?.mes || '');
}

export function cut(text, n) {
    text = String(text ?? '');
    return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

export function parseDate(value, fallbackName) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value) {
        const t = Date.parse(value);
        if (!Number.isNaN(t)) return t;
        // ST's own send_date looks like "November 5, 2026 3:52pm"; Date.parse needs a space before am/pm
        const t2 = Date.parse(value.replace(/(\d)\s*([ap]m)\b/i, '$1 $2'));
        if (!Number.isNaN(t2)) return t2;
        const m = value.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    if (fallbackName) {
        const m = String(fallbackName).match(/(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    }
    return 0;
}

export function parseSize(text) {
    const m = String(text ?? '').match(/([\d.]+)\s*([KMGT]?B)/i);
    if (!m) return 0;
    const mul = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()] || 1;
    return parseFloat(m[1]) * mul;
}

export function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export const pad = (n) => String(n).padStart(2, '0');

export function fmtShort(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/** 26.11.03 — short, but with the year (lists can span years) */
export function fmtYmd(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${String(d.getFullYear()).slice(2)}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

export function fmtLong(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const year = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}년 ` : '';
    return `${year}${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtAgo(ts) {
    if (!ts) return '';
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return '방금';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
    if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}달 전`;
    return `${Math.floor(s / 86400 / 365)}년 전`;
}

export function branchNo(id) {
    const m = String(id).match(/ - Branch #(\d+)$/);
    return m ? Number(m[1]) : null;
}

/** A chat file the user renamed in ST (not ST's "Name - date" / "… - Branch #N" default). Its name is the user's own title. */
export function customFileName(id) {
    const t = String(id ?? '');
    if (!t) return false;
    if (/\d{4}-\d{1,2}-\d{1,2}\s*@\s*\d{1,2}h\s*\d{1,2}m/.test(t)) return false;
    if (/(^|\s-\s)(Branch|Checkpoint) #\d+/.test(t)) return false;
    return true;
}

export function fallbackTitle(id) {
    const no = branchNo(id);
    if (no !== null) return `Branch #${no}`;
    const m = String(id).match(/(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m/);
    return m ? `${pad(m[2])}/${pad(m[3])} ${pad(m[4])}:${pad(m[5])} 챗` : String(id);
}

export function title(id, avatar = state.avatar) {
    return entry(id, avatar).title || fallbackTitle(id);
}

export function hasTitle(id, avatar = state.avatar) {
    return !!entry(id, avatar).title;
}

// ---------------------------------------------------------------- characters

export function openChar() {
    const c = ctx();
    if (c.groupId || c.characterId === undefined) return null;
    return c.characters?.[c.characterId] || null;
}

export function charByAvatar(avatar) {
    const list = ctx().characters || [];
    const index = list.findIndex((x) => x?.avatar === avatar);
    return index >= 0 ? { index, char: list[index] } : null;
}

export function isOpenCharView() {
    return !!state.avatar && openChar()?.avatar === state.avatar;
}

// current chat id, but only when the viewed map belongs to the open character
export function currentChatId() {
    return isOpenCharView() ? (ctx().getCurrentChatId?.() ?? null) : null;
}

export function avatarUrl(avatar) {
    try { return ctx().getThumbnailUrl('avatar', avatar); } catch { return `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`; }
}

// ---------------------------------------------------------------- server access

async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
    return res;
}

// Chats without a date in their name (renamed in ST) go last, whichever way.
const createdKey = (id) => state.byId.get(id)?.created || 0;
export const CREATED_SORTS = {
    made: (a, b) => (createdKey(b) || -Infinity) - (createdKey(a) || -Infinity) || 0,
    madeOld: (a, b) => (createdKey(a) || Infinity) - (createdKey(b) || Infinity) || 0,
};

/** When the chat file was made, from the newest "YYYY-MM-DD@HHhMMm" stamp in its name (ST names new chats and branches this way). */
export function createdFromName(id) {
    const all = [...String(id ?? '').matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m(?:\s*(\d{1,2})s)?/g)];
    if (!all.length) return 0;
    const m = all[all.length - 1];
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    // "Main - date - Branch #N": the date is the main chat's, so only the order is known (later number = made later)
    const after = String(id).slice(m.index + m[0].length).match(/ - Branch #(\d+)/);
    return after ? -(t + Number(after[1])) : t;
}

export async function fetchChatList(avatar, { metadata = true } = {}) {
    const data = await (await post('/api/characters/chats', { avatar_url: avatar, metadata })).json();
    if (!Array.isArray(data)) return [];
    return data.map((x) => {
        const id = String(x.file_id ?? String(x.file_name).replace(/\.jsonl$/, ''));
        return {
            id,
            sizeText: x.file_size || '',
            size: parseSize(x.file_size),
            count: Number(x.chat_items) || 0,
            lastMes: plain(x.mes),
            lastDate: parseDate(x.last_mes, id),
            created: Math.abs(createdFromName(id)),
            createdExact: createdFromName(id) > 0,
            parent: x.chat_metadata?.main_chat ? String(x.chat_metadata.main_chat).replace(/\.jsonl$/, '') : null,
        };
    });
}

// Whole chat file: [header, ...messages]
export async function loadChatRaw(id, avatar = state.avatar) {
    const data = await (await post('/api/chats/get', { file_name: id, avatar_url: avatar })).json();
    if (!Array.isArray(data)) return { header: {}, messages: [] };
    const header = data[0] && !('mes' in data[0]) ? data[0] : { chat_metadata: {} };
    const messages = data.filter((m) => m && typeof m.mes === 'string');
    return { header, messages };
}

export async function loadChat(id, avatar = state.avatar) {
    return (await loadChatRaw(id, avatar)).messages;
}

export async function ensureChatDir(avatar) {
    await post('/api/chats/get', { avatar_url: avatar });
}

export async function saveChatRaw(avatar, charName, id, header, messages) {
    await post('/api/chats/save', { ch_name: charName, file_name: id, chat: [header, ...messages], avatar_url: avatar });
}

export async function deleteChatFile(avatar, id) {
    await post('/api/chats/delete', { chatfile: `${id}.jsonl`, avatar_url: avatar });
}

export async function fetchRecentChats(max = 100000) {
    const data = await (await post('/api/chats/recent', { max, metadata: true })).json();
    return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------- map data

export async function loadMap(avatar) {
    const char = charByAvatar(avatar)?.char;
    state.avatar = avatar;
    state.charName = char?.name || avatar;
    state.list = await fetchChatList(avatar);
    buildTree();
}

export function buildTree() {
    state.byId = new Map(state.list.map((c) => [c.id, c]));
    state.children = new Map();
    state.roots = [];
    for (const c of state.list) {
        c.orphan = false;
        let validParent = c.parent && c.parent !== c.id && state.byId.has(c.parent);
        if (validParent) {
            let p = c.parent;
            let hops = 0;
            while (p && hops < 64) {
                if (p === c.id) { validParent = false; break; }
                p = state.byId.get(p)?.parent;
                hops++;
            }
        }
        if (validParent) {
            if (!state.children.has(c.parent)) state.children.set(c.parent, []);
            state.children.get(c.parent).push(c.id);
        } else {
            if (c.parent) c.orphan = true;
            state.roots.push(c.id);
        }
    }
    const pinFirst = (a, b) => (entry(b).pinned ? 1 : 0) - (entry(a).pinned ? 1 : 0);
    const sorter = {
        recent: (a, b) => state.byId.get(b).lastDate - state.byId.get(a).lastDate,
        old: (a, b) => state.byId.get(a).lastDate - state.byId.get(b).lastDate,
        ...CREATED_SORTS,
        size: (a, b) => state.byId.get(b).size - state.byId.get(a).size,
        count: (a, b) => state.byId.get(b).count - state.byId.get(a).count,
    }[state.sort] || (() => 0);
    state.roots.sort((a, b) => pinFirst(a, b) || sorter(a, b));
    for (const kids of state.children.values()) {
        kids.sort((a, b) => pinFirst(a, b)
            || ((branchNo(a) ?? 1e9) - (branchNo(b) ?? 1e9))
            || (state.byId.get(a).lastDate - state.byId.get(b).lastDate));
    }
    state.groupColor = new Map();
    let i = 0;
    const assign = (ids) => {
        for (const id of ids) {
            const kids = state.children.get(id);
            if (kids?.length) {
                state.groupColor.set(id, LINE_COLORS[i++ % LINE_COLORS.length]);
                assign(kids);
            }
        }
    };
    assign(state.roots);
}

/**
 * The status shown for a station: the user's own tag always wins; otherwise (when enabled)
 * an automatic one from message count and last ride. 🏁 종착 is never set automatically.
 * @returns {{ key: string|null, auto: boolean }}
 */
export function statusOf(id, avatar = state.avatar) {
    return statusForChat(entry(id, avatar), avatar === state.avatar ? state.byId.get(id) : null);
}

/** Same rule for any chat record that has { count, lastDate } (e.g. from the all-bots tally). */
export function statusForChat(e, c) {
    if (e?.status && STATUS[e.status]) return { key: e.status, auto: false };
    const s = getSettings();
    if (!s.autoStatus || !c) return { key: null, auto: false };
    if (c.count <= 3) return { key: 'test', auto: true };
    const runDays = Math.max(1, Number(s.autoDays) || 14);
    const restDays = Math.max(runDays, Number(s.restDays) || 60);
    const age = Date.now() - c.lastDate;
    if (age <= runDays * 86400e3) return { key: 'run', auto: true };
    return { key: age > restDays * 86400e3 ? 'rest' : 'stop', auto: true };
}

export function statusIcon(id, avatar = state.avatar) {
    const st = statusOf(id, avatar);
    if (!st.key) return '';
    const v = STATUS[st.key];
    return `<span class="kts-status ${st.auto ? 'auto' : ''}" title="${v.label}${st.auto ? ' (자동)' : ''}">${v.icon}</span>`;
}

export function isRoot(id) {
    return state.roots.includes(id);
}

export function parentOf(id) {
    return isRoot(id) ? null : state.byId.get(id)?.parent ?? null;
}

// ---------------------------------------------------------------- AI

// Without a preset, ST does not attach source-specific auth fields (e.g. Vertex AI auth mode),
// so the server falls back to Express mode. Copy them from the current Chat Completion settings.
function sourceExtras(profileId) {
    const c = ctx();
    const cc = c.chatCompletionSettings || {};
    const extras = {};
    let profile = null;
    try { profile = c.ConnectionManagerRequestService.getProfile(profileId); } catch { /* ignore */ }
    if (cc.vertexai_auth_mode) extras.vertexai_auth_mode = cc.vertexai_auth_mode;
    if (cc.vertexai_express_project_id) extras.vertexai_express_project_id = cc.vertexai_express_project_id;
    const region = profile?.['api-url'] || cc.vertexai_region;
    if (region) extras.vertexai_region = region;
    // Labelling a chat needs no deep reasoning: keep thinking low so it is fast and cheap.
    extras.include_reasoning = false;
    // 'min' maps to MINIMAL, which some Gemini 3.x flash models reject; 'low' works everywhere.
    if (['vertexai', 'makersuite'].includes(profile?.api)) extras.reasoning_effort = 'low';
    return extras;
}

export async function callModel(system, user, maxTokens = 1500) {
    const c = ctx();
    const profileId = getSettings().profileId;
    if (profileId && c.ConnectionManagerRequestService) {
        const res = await c.ConnectionManagerRequestService.sendRequest(
            profileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            maxTokens,
            { stream: false, extractData: true, includePreset: false, includeInstruct: true },
            sourceExtras(profileId),
        );
        return typeof res === 'string' ? res : (res?.content ?? '');
    }
    return await c.generateRaw({ systemPrompt: system, prompt: user, responseLength: maxTokens });
}

export function errText(err) {
    let e = err;
    const parts = [];
    for (let i = 0; e && i < 4; i++) { if (e.message) parts.push(e.message); e = e.cause; }
    return cut(parts.filter((m) => m !== 'API request failed').join(' / ') || String(err), 200);
}

function extractField(raw, key) {
    // tolerant: works even when the JSON was cut off before the closing quote/brace
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("|$)`));
    if (!m) return '';
    let v = m[1];
    try { v = JSON.parse(`"${v}"`); } catch { v = v.replace(/\\n/g, ' ').replace(/\\"/g, '"'); }
    return String(v).trim();
}

export function looksBroken(text) {
    return /^\s*[{[]/.test(text || '') || /"(title|summary)"\s*:/.test(text || '');
}

// Parses a JSON object from a model reply. Falls back to tolerant field extraction.
export function parseJsonReply(text, keys) {
    const raw = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
    const greedy = raw.match(/\{[\s\S]*\}/);
    const candidates = [...(greedy ? [greedy[0]] : []), ...(raw.match(/\{[\s\S]*?\}/g) || []).reverse()];
    for (const b of candidates) {
        try {
            const j = JSON.parse(b);
            if (j && keys.some((k) => j[k])) return j;
        } catch { /* try next */ }
    }
    const out = {};
    for (const k of keys) out[k] = extractField(raw, k);
    return keys.some((k) => out[k]) ? out : null;
}

export function parseResult(text) {
    const raw = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
    const j = parseJsonReply(raw, ['title', 'summary']);
    if (j) {
        const closed = /"summary"\s*:\s*"(?:[^"\\]|\\.)*"/.test(raw);
        const summary = String(j.summary || '').trim();
        return { title: String(j.title || '').trim().slice(0, 60), summary: summary && !closed ? `${summary}…` : summary };
    }
    if (looksBroken(raw)) return null;
    const lines = raw.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return null;
    return { title: lines[0].replace(/^["#*\s]*(title:)?/i, '').slice(0, 40), summary: lines.slice(1).join(' ') };
}

export function repairBrokenEntries() {
    const all = getSettings().chats || {};
    let fixed = 0;
    for (const chats of Object.values(all)) {
        for (const [id, e] of Object.entries(chats)) {
            if (e.title && !e.titleLocked && customFileName(id)) {
                // an earlier version let the AI title cover the file name the user gave in ST
                e.aiTitle = e.title;
                delete e.title;
                fixed++;
            }
            if (!looksBroken(e.title) && !looksBroken(e.summary)) continue;
            const raw = `${e.title || ''} ${e.summary || ''}`;
            const t = extractField(raw, 'title');
            const next = { ...e };
            if (looksBroken(e.title)) next.title = t || undefined;
            next.summary = undefined;
            delete next.summarizedCount;
            delete next.summarizedAt;
            for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
            if (Object.keys(next).length) chats[id] = next; else delete chats[id];
            fixed++;
        }
    }
    if (fixed) {
        save();
        console.log(LOG, `repaired ${fixed} broken summaries`);
    }
    return fixed;
}

export function buildTranscript(messages, limit, budget = 24000) {
    const lines = [];
    const first = messages[0];
    const start = Math.max(0, messages.length - limit);
    const tail = messages.slice(start);
    for (let i = tail.length - 1; i >= 0; i--) {
        const m = tail[i];
        const line = `${m.name || (m.is_user ? 'User' : 'Character')}: ${cut(plain(m.mes), 1200)}`;
        if (budget - line.length < 0) break;
        budget -= line.length;
        lines.unshift(line);
    }
    const opening = first && start > 0
        ? `[Opening scene]\n${first.name || 'Character'}: ${cut(plain(first.mes), 800)}\n\n${start > 1 ? '[...earlier messages omitted...]\n\n' : ''}`
        : '';
    return opening + lines.join('\n\n');
}

/**
 * Summarizes one chat. Works for any character, popup open or not.
 * @param {{avatar: string, charName: string, id: string, parentId?: string|null, count?: number}} p
 */
export async function summarizeChat({ avatar, charName, id, parentId = null, count }) {
    const messages = await loadChat(id, avatar);
    if (messages.length < 2) throw new Error('메시지가 너무 적어요');
    const transcript = buildTranscript(messages, Math.max(4, Number(getSettings().summaryMessages) || 40));
    const lang = getSettings().outputLanguage || 'Korean';
    const pe = parentId ? entry(parentId, avatar) : null;
    const system = 'You are an archivist who labels roleplay chat logs so the user can quickly recognize each chat later. You never continue the story; you only describe it.';
    const branchNote = parentId
        ? `\nThis chat is a BRANCH that split off from another chat${pe?.title ? ` titled "${pe.title}"` : ''}.${pe?.summary ? ` The parent chat is summarized as: "${pe.summary}"` : ''}\nFocus on what makes this branch different from the parent: the choice that diverged and where it led.\n`
        : '';
    const user = `Below is the latest part of a roleplay chat log with the character "${charName}".
${branchNote}
Write two things:
1. "title": a short, evocative title like a subway station name (max 20 characters) that names the current arc or situation concretely. No quotes, no emojis.
2. "summary": ONE sentence (max 70 characters) that pins down the CURRENT scene: who is where, doing what, right now. Use the actual character names and place names from the log. Be specific and concrete. Never use vague filler such as "the relationship deepens", "tension rises", "a new chapter begins", or "their bond grows".

Good summary example: "In the abandoned chapel, Elias confronts Mira about the stolen letter while Kai keeps watch outside."
Bad summary example: "The story continues as the characters face new challenges and their relationships develop."

Write both values in ${lang}.
Respond with JSON only, no extra text: {"title": "...", "summary": "..."}

<chat_log>
${transcript}
</chat_log>`;
    const out = parseResult(await callModel(system, user));
    if (!out || (!out.title && !out.summary)) throw new Error('응답을 읽지 못했어요 (형식 오류)');
    const cur = entry(id, avatar);
    setEntry(id, {
        // never replace a name the user chose: one typed here (titleLocked) or the chat file's own name in ST
        title: cur.titleLocked ? cur.title : customFileName(id) ? undefined : (out.title || cur.title),
        summary: out.summary || cur.summary,
        summarizedCount: count ?? messages.length - 1,
        summarizedAt: Date.now(),
    }, avatar);
    return entry(id, avatar);
}

// Map-aware wrapper used by the popup.
export async function summarize(id, { quiet = false } = {}) {
    if (state.summarizing.has(id)) return false;
    const avatar = state.avatar;
    state.summarizing.add(id);
    app.render();
    try {
        await summarizeChat({ avatar, charName: state.charName, id, parentId: parentOf(id), count: state.byId.get(id)?.count });
        return true;
    } catch (err) {
        console.error(LOG, 'summary failed', err);
        state.lastError = errText(err);
        if (!quiet) toastr.error(`요약에 실패했어요.<br><small>${esc(state.lastError)}</small>`, TOAST, { escapeHtml: false });
        return false;
    } finally {
        state.summarizing.delete(id);
        app.render();
    }
}

export async function bulkSummarize({ all = false } = {}) {
    if (state.bulk) return;
    const targets = state.list.filter((c) => (all || !entry(c.id).summary) && c.count >= 2).map((c) => c.id);
    if (!targets.length) {
        toastr.info('요약할 역이 없어요.', TOAST);
        return;
    }
    const { Popup, POPUP_RESULT } = ctx();
    const ok = await Popup.show.confirm(all ? '모든 역 다시 요약' : '요약 없는 역 모두 요약', `역 ${targets.length}개를 ${BULK_CONCURRENCY}개씩 동시에 요약해요. 챗 하나당 API 요청이 한 번씩 나가요.${all ? '<br><small>직접 지은 역 이름은 그대로 두고 요약만 새로 써요.</small>' : ''}<br>진행할까요?`);
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
    state.bulk = { done: 0, total: targets.length, abort: false };
    app.render();
    let fail = 0;
    state.lastError = '';
    const queue = [...targets];
    const worker = async () => {
        while (queue.length && state.bulk && !state.bulk.abort) {
            const id = queue.shift();
            const okOne = await summarize(id, { quiet: true });
            if (!okOne) fail++;
            if (!state.bulk) return;
            state.bulk.done++;
            if (state.bulk.done >= 3 && fail === state.bulk.done && !state.bulk.abort) {
                state.bulk.abort = true;
                toastr.error('처음 몇 개가 모두 실패해서 일괄 요약을 멈췄어요.', TOAST);
            }
            app.render();
        }
    };
    await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, targets.length) }, worker));
    const done = state.bulk?.done ?? 0;
    state.bulk = null;
    app.render();
    if (fail) {
        toastr.warning(`요약 완료 ${done - fail}개 · 실패 ${fail}개<br><small>${esc(state.lastError || '')}</small>`, TOAST, { escapeHtml: false, timeOut: 10000 });
    } else {
        toastr.success(`요약 완료 ${done}개`, TOAST);
    }
}

// ---------------------------------------------------------------- theme

export function resolveTheme() {
    const pref = getSettings().theme;
    if (pref === 'light' || pref === 'dark') return pref;
    const css = getComputedStyle(document.documentElement);
    for (const raw of [css.getPropertyValue('--SmartThemeBlurTintColor'), css.getPropertyValue('--SmartThemeChatTintColor')]) {
        const m = String(raw).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
        if (m) return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 > 0.55 ? 'light' : 'dark';
    }
    return 'dark';
}

// ---------------------------------------------------------------- navigation

/** Opens a chat of any character (switching characters if needed). */
export async function openChatOf(avatar, id) {
    const c = ctx();
    if (openChar()?.avatar === avatar) {
        if (c.getCurrentChatId() !== id) await c.openCharacterChat(id);
        return;
    }
    const found = charByAvatar(avatar);
    if (!found) throw new Error('캐릭터를 찾을 수 없어요');
    // selectCharacterById loads characters[index].chat, so point it at the wanted chat first
    found.char.chat = id;
    await c.selectCharacterById(found.index);
    if (c.getCurrentChatId?.() !== id) await c.openCharacterChat(id);
}
