// 自动化管理：定时消息、关键词自动回复、转发给外部程序
import { h, api, toast, openModal, confirmBox, fmtTime } from './lib.js';
import { state, currentConv } from './state.js';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const MATCH_TEXT = { contains: '包含', exact: '完全等于', prefix: '开头是', regex: '正则', any: '任意消息' };

function convOptions(selected) {
  const sel = h('select', {});
  const list = [...state.convs.values()].sort((a, b) => b.lastTs - a.lastTs);
  for (const c of list) {
    const o = h('option', { value: `${c.type}:${c.peerId}` }, `${c.type === 'group' ? '[群] ' : '[私聊] '}${c.name}`);
    if (selected === `${c.type}:${c.peerId}`) o.selected = true;
    sel.append(o);
  }
  return sel;
}

function stickerSelect(selected) {
  const sel = h('select', {}, h('option', { value: '' }, '不发送表情'));
  for (const s of state.stickers || []) {
    const o = h('option', { value: s.id }, s.keywords ? `表情：${s.keywords}` : `表情 #${s.id}`);
    if (Number(selected) === s.id) o.selected = true;
    sel.append(o);
  }
  return sel;
}

const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);

function toLocalInput(ts) {
  const d = new Date(ts || Date.now() + 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function describeSchedule(s) {
  if (s.kind === 'once') return `${fmtTime(s.runAt, true).slice(0, 16)} 发送一次`;
  if (s.kind === 'daily') return `每天 ${s.timeOfDay}`;
  return `每周${WEEK.filter((_, i) => s.weekdays & (1 << i)).join('、')} ${s.timeOfDay}`;
}

// ---------------- 定时消息 ----------------
function scheduleEditor(s, onSaved, preset) {
  openModal((m, close) => {
    const conv = convOptions(s ? `${s.convType}:${s.peerId}` : preset);
    const name = h('input', { value: s?.name || '', placeholder: '例如：早安问候（可选）' });
    const text = h('textarea', { rows: 4, placeholder: '要发送的内容' });
    text.value = s?.text || '';
    const md = h('input', { type: 'checkbox', checked: !!s?.markdown });
    const sticker = stickerSelect(s?.stickerId);
    const kind = h('select', {}, h('option', { value: 'once' }, '只发一次'), h('option', { value: 'daily' }, '每天'), h('option', { value: 'weekly' }, '每周'));
    kind.value = s?.kind || 'once';
    const runAt = h('input', { type: 'datetime-local', value: toLocalInput(s?.runAt) });
    const time = h('input', { type: 'time', value: s?.timeOfDay || '08:00' });
    const days = WEEK.map((d, i) => h('input', { type: 'checkbox', checked: s ? !!(s.weekdays & (1 << i)) : i >= 1 && i <= 5, dataset: { bit: i } }));
    const dayBox = h('div', { class: 'checks inline' }, days.map((cb, i) => h('label', {}, cb, h('span', {}, `周${WEEK[i]}`))));
    const onceRow = field('发送时间', runAt);
    const timeRow = field('每天几点', time);
    const dayRow = field('星期', dayBox);
    const sync = () => {
      onceRow.classList.toggle('hidden', kind.value !== 'once');
      timeRow.classList.toggle('hidden', kind.value === 'once');
      dayRow.classList.toggle('hidden', kind.value !== 'weekly');
    };
    kind.onchange = sync;
    sync();
    const err = h('p', { class: 'form-error' });
    m.append(
      h('h2', {}, s ? '编辑定时消息' : '新建定时消息'),
      field('发送到', conv),
      field('名称', name),
      field('内容', text, '定时消息通常以主动消息发出，会占用主动消息配额；若当时恰好有被动回复窗口会优先使用。'),
      h('div', { class: 'field' }, h('div', { class: 'checks' }, h('label', {}, md, h('span', {}, '以 Markdown 发送')))),
      field('附带表情', sticker),
      field('重复', kind),
      onceRow,
      timeRow,
      dayRow,
      err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, '取消'),
        h('button', { class: 'btn primary', onclick: async () => {
          const [convType, peerId] = conv.value.split(':');
          const body = {
            convType,
            peerId,
            name: name.value,
            text: text.value,
            markdown: md.checked,
            stickerId: sticker.value ? Number(sticker.value) : null,
            kind: kind.value,
            runAt: new Date(runAt.value).getTime() || 0,
            timeOfDay: time.value,
            weekdays: days.reduce((n, cb) => (cb.checked ? n | (1 << Number(cb.dataset.bit)) : n), 0),
            enabled: true,
          };
          try {
            if (s) await api('PATCH', `/api/bots/${state.botId}/schedules/${s.id}`, body);
            else await api('POST', `/api/bots/${state.botId}/schedules`, body);
            close();
            toast('已保存', 'ok');
            onSaved?.();
          } catch (e) {
            err.textContent = e.message;
          }
        } }, '保存')),
    );
  });
}

async function drawSchedules(box) {
  box.innerHTML = '';
  const list = await api('GET', `/api/bots/${state.botId}/schedules`);
  box.append(h('div', { class: 'auto-toolbar' },
    h('span', { class: 'muted small' }, '时间按服务器所在时区计算。面板停机期间错过超过 10 分钟的消息不会补发。'),
    h('button', { class: 'btn small primary', onclick: () => scheduleEditor(null, () => drawSchedules(box)) }, '＋ 新建')));
  if (!list.length) box.append(h('div', { class: 'empty-list' }, '还没有定时消息'));
  for (const s of list) {
    const toggle = h('input', { type: 'checkbox', checked: s.enabled, title: '启用' });
    toggle.onchange = async () => {
      try {
        await api('PATCH', `/api/bots/${state.botId}/schedules/${s.id}`, { enabled: toggle.checked });
        drawSchedules(box);
      } catch (e) {
        toggle.checked = !toggle.checked;
        toast(e.message, 'error');
      }
    };
    box.append(h('div', { class: `auto-item ${s.enabled ? '' : 'off'}` },
      h('div', { class: 'ai-main' },
        h('div', { class: 'ai-title' }, s.name || s.text.slice(0, 30) || '[表情]', h('span', { class: 'tag', style: 'margin-left:6px' }, describeSchedule(s))),
        h('div', { class: 'ai-sub' }, `发送到 ${s.convName}`, s.nextRun ? ` · 下次 ${fmtTime(s.nextRun, true).slice(0, 16)}` : ''),
        s.lastStatus ? h('div', { class: `ai-sub ${/失败|跳过/.test(s.lastStatus) ? 'fail' : ''}` }, `上次 ${fmtTime(s.lastRun)}：${s.lastStatus}`) : null),
      h('div', { class: 'ai-ops' },
        toggle,
        h('button', { class: 'link-btn', onclick: () => scheduleEditor(s, () => drawSchedules(box)) }, '编辑'),
        h('button', { class: 'link-btn danger', onclick: async () => {
          if (!(await confirmBox('删除定时消息', '确定删除吗？', '删除', true))) return;
          await api('DELETE', `/api/bots/${state.botId}/schedules/${s.id}`);
          drawSchedules(box);
        } }, '删除'))));
  }
}

// ---------------- 自动回复 ----------------
function ruleEditor(r, onSaved) {
  openModal((m, close) => {
    const name = h('input', { value: r?.name || '', placeholder: '例如：问天气（可选）' });
    const matchType = h('select', {}, Object.entries(MATCH_TEXT).map(([v, t]) => h('option', { value: v }, t)));
    matchType.value = r?.matchType || 'contains';
    const pattern = h('input', { value: r?.pattern || '', placeholder: '多个关键词用 | 分隔，例如：天气|下雨' });
    const scope = h('select', {}, h('option', { value: 'all' }, '群聊和私聊'), h('option', { value: 'group' }, '仅群聊'), h('option', { value: 'c2c' }, '仅私聊'));
    scope.value = r?.scope || 'all';
    const peerSel = h('select', {}, h('option', { value: '' }, '所有会话'));
    for (const c of state.convs.values()) {
      const o = h('option', { value: c.peerId }, `${c.type === 'group' ? '[群] ' : '[私聊] '}${c.name}`);
      if (r?.peerId === c.peerId) o.selected = true;
      peerSel.append(o);
    }
    const requireAt = h('input', { type: 'checkbox', checked: r ? r.requireAt : true });
    const reply = h('textarea', { rows: 4, placeholder: '回复内容。可用 {name} 发送者昵称、{at} @发送者、{time} 当前时间' });
    reply.value = r?.replyText || '';
    const md = h('input', { type: 'checkbox', checked: !!r?.replyMarkdown });
    const sticker = stickerSelect(r?.stickerId);
    const cooldown = h('input', { type: 'number', min: 0, max: 86400, value: r?.cooldownSec ?? 10 });
    const err = h('p', { class: 'form-error' });
    const sync = () => pattern.closest('.field').classList.toggle('hidden', matchType.value === 'any');
    matchType.onchange = sync;
    m.append(
      h('h2', {}, r ? '编辑自动回复' : '新建自动回复'),
      field('名称', name),
      h('div', { class: 'row-fields' }, matchType, scope),
      field('关键词', pattern),
      field('限定会话', peerSel),
      h('div', { class: 'field' }, h('div', { class: 'checks' }, h('label', {}, requireAt, h('span', {}, '群聊里只回复 @机器人 的消息',
        h('div', { class: 'muted small' }, '开启“接收全部消息”后群里每条发言都会经过规则，建议保持勾选'))))),
      field('回复内容', reply),
      h('div', { class: 'field' }, h('div', { class: 'checks' }, h('label', {}, md, h('span', {}, '以 Markdown 发送（使用 {at} 时自动开启）')))),
      field('同时回复表情', sticker),
      field('冷却时间（秒）', cooldown, '同一会话里触发后多少秒内不再重复回复'),
      err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, '取消'),
        h('button', { class: 'btn primary', onclick: async () => {
          const body = {
            name: name.value, matchType: matchType.value, pattern: pattern.value, scope: scope.value, peerId: peerSel.value,
            requireAt: requireAt.checked, replyText: reply.value, replyMarkdown: md.checked,
            stickerId: sticker.value ? Number(sticker.value) : null, cooldownSec: Number(cooldown.value) || 0,
          };
          try {
            if (r) await api('PATCH', `/api/bots/${state.botId}/rules/${r.id}`, body);
            else await api('POST', `/api/bots/${state.botId}/rules`, body);
            close();
            toast('已保存', 'ok');
            onSaved?.();
          } catch (e) {
            err.textContent = e.message;
          }
        } }, '保存')),
    );
    sync();
  });
}

async function drawRules(box) {
  box.innerHTML = '';
  const list = await api('GET', `/api/bots/${state.botId}/rules`);
  box.append(h('div', { class: 'auto-toolbar' },
    h('span', { class: 'muted small' }, '收到消息时从上到下匹配，只执行第一条命中的规则。回复使用被动回复，不占主动消息配额。'),
    h('button', { class: 'btn small primary', onclick: () => ruleEditor(null, () => drawRules(box)) }, '＋ 新建')));
  if (!list.length) box.append(h('div', { class: 'empty-list' }, '还没有自动回复规则'));
  for (const r of list) {
    const toggle = h('input', { type: 'checkbox', checked: r.enabled, title: '启用' });
    toggle.onchange = async () => {
      await api('PATCH', `/api/bots/${state.botId}/rules/${r.id}`, { enabled: toggle.checked }).catch((e) => toast(e.message, 'error'));
      drawRules(box);
    };
    box.append(h('div', { class: `auto-item ${r.enabled ? '' : 'off'}` },
      h('div', { class: 'ai-main' },
        h('div', { class: 'ai-title' }, r.name || r.pattern || '任意消息',
          h('span', { class: 'tag', style: 'margin-left:6px' }, `${MATCH_TEXT[r.matchType]}${r.matchType === 'any' ? '' : `「${r.pattern}」`}`)),
        h('div', { class: 'ai-sub' }, `回复：${r.replyText.slice(0, 40) || '[表情]'}`),
        h('div', { class: 'ai-sub' }, `${{ all: '群聊和私聊', group: '仅群聊', c2c: '仅私聊' }[r.scope]}${r.requireAt ? ' · 群里需 @机器人' : ''} · 已触发 ${r.hits} 次`)),
      h('div', { class: 'ai-ops' },
        toggle,
        h('button', { class: 'link-btn', onclick: () => ruleEditor(r, () => drawRules(box)) }, '编辑'),
        h('button', { class: 'link-btn danger', onclick: async () => {
          if (!(await confirmBox('删除规则', '确定删除这条自动回复规则吗？', '删除', true))) return;
          await api('DELETE', `/api/bots/${state.botId}/rules/${r.id}`);
          drawRules(box);
        } }, '删除'))));
  }
}

// ---------------- 转发 ----------------
async function drawForward(box) {
  box.innerHTML = '';
  const f = await api('GET', `/api/bots/${state.botId}/forward`);
  const url = h('input', { value: f.url, placeholder: 'https://your-server/qq-hook（留空关闭转发）' });
  const secret = h('input', { type: 'password', placeholder: f.hasSecret ? '已设置，不修改请留空' : '可选，用于 HMAC 签名', autocomplete: 'new-password' });
  const mode = h('select', {}, h('option', { value: 'at' }, '群聊只转发 @机器人 的消息，私聊全部转发'), h('option', { value: 'all' }, '转发全部消息'));
  mode.value = f.mode;
  const events = h('input', { type: 'checkbox', checked: f.events });
  const err = h('p', { class: 'form-error' });
  const result = h('div', {});
  box.append(
    h('p', { class: 'muted small', style: 'line-height:1.7;margin-top:0' },
      '收到消息时，面板把消息以 JSON POST 到这个地址，可以接自己的程序或大模型。外部程序在响应里返回 ',
      h('code', {}, '{"reply": "回复内容"}'), ' 时，面板会用被动回复把它发回会话；返回空内容则不回复。设置了密钥时，请求头 ',
      h('code', {}, 'X-Panel-Signature'), ' 为 ', h('code', {}, 'sha256=HMAC(密钥, 时间戳 + "." + 请求体)'), '，时间戳在 ', h('code', {}, 'X-Panel-Timestamp'), '。'),
    field('转发地址', url),
    field('签名密钥', secret),
    field('转发范围', mode),
    h('div', { class: 'field' }, h('div', { class: 'checks' }, h('label', {}, events, h('span', {}, '同时转发群事件（进退群、成员变动、加群申请等）')))),
    err,
    h('div', { class: 'row-fields' },
      h('button', { class: 'btn small primary', onclick: async () => {
        err.textContent = '';
        try {
          await api('PUT', `/api/bots/${state.botId}/forward`, { url: url.value, secret: secret.value, mode: mode.value, events: events.checked });
          toast('已保存', 'ok');
          drawForward(box);
        } catch (e) {
          err.textContent = e.message;
        }
      } }, '保存'),
      h('button', { class: 'btn small', onclick: async () => {
        result.textContent = '测试中…';
        try {
          const r = await api('POST', `/api/bots/${state.botId}/forward/test`);
          result.textContent = r.reply ? `成功，外部程序返回回复：${r.reply.text}` : '成功，外部程序没有返回回复';
        } catch (e) {
          result.textContent = e.message;
        }
      } }, '发送测试请求'),
      f.hasSecret ? h('button', { class: 'btn small', onclick: async () => {
        await api('PUT', `/api/bots/${state.botId}/forward`, { url: url.value, mode: mode.value, events: events.checked, clearSecret: true });
        drawForward(box);
      } }, '清除密钥') : null),
    result,
  );
}

export function automationDialog(tab = 'schedules') {
  if (!state.botId) return toast('请先添加机器人', 'error');
  openModal((m) => {
    m.classList.add('wide');
    const body = h('div', { class: 'auto-body' });
    const tabs = [['schedules', '定时消息', drawSchedules], ['rules', '自动回复', drawRules], ['forward', '转发到外部程序', drawForward]];
    const bar = h('div', { class: 'tabs', style: 'margin:0 0 12px' });
    const show = (key) => {
      bar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
      body.innerHTML = '<div class="empty-list">加载中…</div>';
      tabs.find((t) => t[0] === key)[2](body).catch((e) => (body.textContent = e.message));
    };
    for (const [key, label] of tabs) bar.append(h('button', { dataset: { tab: key }, onclick: () => show(key) }, label));
    m.append(h('h2', {}, '自动化'), bar, body);
    show(tab);
  });
}

// 从会话面板快速为当前会话创建定时消息
export function quickSchedule() {
  const c = currentConv();
  if (!c) return;
  scheduleEditor(null, () => toast('可在左侧 ⚡ 自动化中管理'), `${c.type}:${c.peerId}`);
}
