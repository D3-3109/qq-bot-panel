// 图文卡片与消息按钮
import { h, $, api, toast, openModal } from './lib.js';
import { state, actions, currentConv } from './state.js';

const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);

export function cardDialog() {
  const conv = currentConv();
  if (!conv) return;
  openModal((m, close) => {
    const title = h('input', { placeholder: '1~50 个字', maxlength: 50 });
    const desc = h('textarea', { rows: 3, placeholder: '1~200 个字', maxlength: 200 });
    const url = h('input', { placeholder: 'https://… 点击卡片后打开的网页' });
    const pic = h('input', { placeholder: 'https://… 封面图片地址' });
    const preview = h('div', { class: 'card-msg' });
    const draw = () => {
      preview.replaceChildren(
        pic.value ? h('img', { src: pic.value, referrerpolicy: 'no-referrer', alt: '' }) : h('div', { class: 'card-pic-ph' }, '封面'),
        h('div', { class: 'card-body' }, h('div', { class: 'card-title' }, title.value || '标题'), h('div', { class: 'card-desc' }, desc.value || '描述')));
    };
    [title, desc, url, pic].forEach((i) => i.addEventListener('input', draw));
    draw();
    const err = h('p', { class: 'form-error' });
    m.append(
      h('h2', {}, '发送图文卡片'),
      field('标题', title),
      field('描述', desc),
      field('跳转链接', url),
      field('封面图片', pic, '链接都必须是 https 地址'),
      h('div', { class: 'field' }, h('label', {}, '预览'), preview),
      err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, '取消'),
        h('button', { class: 'btn primary', onclick: async (e) => {
          err.textContent = '';
          e.target.disabled = true;
          try {
            await api('POST', `/api/bots/${state.botId}/conversations/${conv.type}/${encodeURIComponent(conv.peerId)}/messages`, {
              card: { title: title.value, description: desc.value, url: url.value, pic_url: pic.value },
              replyMode: $('#opt-mode').value,
            });
            close();
          } catch (ex) {
            err.textContent = ex.message;
          } finally {
            e.target.disabled = false;
          }
        } }, '发送')),
    );
  });
}

const TYPE_TEXT = { 2: '指令（插入 @机器人 + 内容）', 1: '回调（发给面板）', 0: '跳转链接' };

// 按钮编辑：行列表，每行最多 5 个
export function keyboardDialog() {
  const rows = state.keyboard?.rows ? structuredClone(state.keyboard.rows) : [[{ label: '', type: 2, data: '', style: 1 }]];
  openModal((m, close) => {
    const list = h('div', {});
    const draw = () => {
      list.innerHTML = '';
      rows.forEach((row, ri) => {
        const rowEl = h('div', { class: 'kb-row-edit' }, h('div', { class: 'muted small' }, `第 ${ri + 1} 行`));
        row.forEach((b, bi) => {
          const label = h('input', { value: b.label, placeholder: '按钮文字', maxlength: 10, oninput: (e) => (b.label = e.target.value) });
          const type = h('select', { onchange: (e) => (b.type = Number(e.target.value)) }, Object.entries(TYPE_TEXT).map(([v, t]) => h('option', { value: v }, t)));
          type.value = String(b.type);
          const data = h('input', { value: b.data, placeholder: '指令内容 / 回调数据 / 链接', oninput: (e) => (b.data = e.target.value) });
          rowEl.append(h('div', { class: 'row-fields' }, label, type, data,
            h('button', { class: 'link-btn danger', title: '删除', onclick: () => {
              row.splice(bi, 1);
              if (!row.length) rows.splice(ri, 1);
              draw();
            } }, '✕')));
        });
        if (row.length < 5) rowEl.append(h('button', { class: 'link-btn', onclick: () => {
          row.push({ label: '', type: 2, data: '', style: 1 });
          draw();
        } }, '＋ 本行加一个按钮'));
        list.append(rowEl);
      });
      if (rows.length < 5) list.append(h('button', { class: 'btn small', onclick: () => {
        rows.push([{ label: '', type: 2, data: '', style: 1 }]);
        draw();
      } }, '＋ 新增一行'));
    };
    draw();
    m.classList.add('wide');
    m.append(
      h('h2', {}, '消息按钮'),
      h('p', { class: 'muted small', style: 'line-height:1.7;margin-top:-6px' },
        '按钮挂在 Markdown 消息底部，最多 5 行、每行 5 个。QQ 开放平台的自定义按钮目前是“内邀开通”，机器人没有权限时发送会失败。回调按钮被点击后，面板会自动回应平台，并在会话里显示是谁点了哪个按钮。'),
      list,
      h('div', { class: 'actions' },
        state.keyboard ? h('button', { class: 'btn danger', style: 'margin-right:auto', onclick: () => {
          setKeyboard(null);
          close();
        } }, '移除按钮') : null,
        h('button', { class: 'btn', onclick: close }, '取消'),
        h('button', { class: 'btn primary', onclick: () => {
          const clean = rows.map((r) => r.filter((b) => b.label.trim() || b.data.trim())).filter((r) => r.length);
          if (!clean.length) return toast('请至少添加一个按钮', 'error');
          setKeyboard({ rows: clean });
          close();
          $('#input').focus();
        } }, '附加到下一条消息')),
    );
  });
}

export function setKeyboard(kb) {
  state.keyboard = kb;
  renderKeyboardBar();
}

export function renderKeyboardBar() {
  const bar = $('#keyboard-bar');
  if (!bar) return;
  if (!state.keyboard) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const n = state.keyboard.rows.reduce((s, r) => s + r.length, 0);
  bar.replaceChildren(
    h('span', {}, `下一条消息将附带 ${n} 个按钮（以 Markdown 发送）`),
    h('button', { onclick: keyboardDialog }, '编辑'),
    h('button', { onclick: () => setKeyboard(null), title: '移除' }, '✕'));
}

// ---------- 消息中显示 ----------
export function cardNode(card) {
  if (!card) return null;
  return h('a', { class: 'card-msg', href: card.url, target: '_blank', rel: 'noopener noreferrer' },
    card.pic_url ? h('img', { src: card.pic_url, referrerpolicy: 'no-referrer', alt: '' }) : null,
    h('div', { class: 'card-body' }, h('div', { class: 'card-title' }, card.title), h('div', { class: 'card-desc' }, card.description)));
}

export function keyboardNode(kb) {
  if (!kb?.rows) return null;
  return h('div', { class: 'kb-view' }, kb.rows.map((r) => h('div', { class: 'kb-row' },
    (r.buttons || r).map((b) => h('span', { class: 'kb-btn', title: `${TYPE_TEXT[b.action?.type ?? b.type]}：${b.action?.data ?? b.data}` }, b.render_data?.label ?? b.label)))));
}

export { actions };
