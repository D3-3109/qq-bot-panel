// 机器人账号的添加 / 编辑弹窗、设置弹窗
import { h, api, toast, openModal, confirmBox } from './lib.js';
import { state, actions } from './state.js';

const INTENT_OPTIONS = [
  { bit: 1 << 25, label: '群聊与私聊事件（GROUP_AND_C2C_EVENT）', hint: '群消息、私聊、机器人进退群等，必选。群主在 QQ 里为机器人开启“接收全部消息”后，群内所有发言都会推送过来', required: true },
  { bit: 1 << 24, label: '群成员事件（GROUP_MEMBER_EVENT）', hint: '成员进退群、加群申请（需机器人是管理员）。平台未开通时会自动取消勾选' },
  { bit: 1 << 26, label: '互动事件（INTERACTION）', hint: '消息按钮回调' },
];

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'hint', html: hint }) : null);
}

export function botDialog(bot) {
  const isEdit = !!bot;
  openModal((m, close) => {
    const appId = h('input', { value: bot?.appId || '', placeholder: '例如 102xxxxxx', inputmode: 'numeric', disabled: isEdit });
    const secret = h('input', { type: 'password', placeholder: isEdit ? '不修改请留空' : 'AppSecret', autocomplete: 'new-password' });
    const name = h('input', { value: bot?.name || '', placeholder: '留空则自动获取机器人昵称' });
    const mode = h('select', {},
      h('option', { value: 'websocket' }, 'WebSocket 长连接（推荐，无需公网 HTTPS）'),
      h('option', { value: 'webhook' }, 'Webhook 回调（需在开放平台配置 HTTPS 回调地址）'));
    mode.value = bot?.mode || 'websocket';
    const intents = bot?.intents ?? ((1 << 25) | (1 << 24));
    const checks = INTENT_OPTIONS.map((o) => {
      const cb = h('input', { type: 'checkbox', value: o.bit, checked: (intents & o.bit) !== 0, disabled: o.required });
      return { o, cb, el: h('label', {}, cb, h('span', {}, o.label, h('div', { class: 'muted small' }, o.hint))) };
    });
    const apiBase = h('input', { value: bot?.apiBase || '', placeholder: 'https://api.bot.qq.com（留空使用默认）' });
    const webhookUrl = `${location.origin}/webhook/${bot?.appId || '<AppID>'}`;
    const whHint = h('div', { class: 'field' },
      h('label', {}, 'Webhook 回调地址'),
      h('div', { class: 'code-box' }, webhookUrl),
      h('div', { class: 'hint' }, '在 QQ 开放平台 → 开发 → 回调配置 中填写此地址（必须是 HTTPS，端口 80/443/8080/8443），并勾选需要的事件。'));
    const syncMode = () => whHint.classList.toggle('hidden', mode.value !== 'webhook');
    mode.onchange = syncMode;
    syncMode();
    const err = h('p', { class: 'form-error' });
    const submit = h('button', { class: 'btn primary' }, isEdit ? '保存' : '添加并上线');

    submit.onclick = async () => {
      err.textContent = '';
      let bits = 0;
      for (const c of checks) if (c.cb.checked) bits |= c.o.bit;
      const body = { name: name.value.trim(), mode: mode.value, intents: bits, apiBase: apiBase.value.trim() };
      if (!isEdit) body.appId = appId.value.trim();
      if (secret.value.trim()) body.secret = secret.value.trim();
      else if (!isEdit) return (err.textContent = '请填写 AppSecret');
      submit.disabled = true;
      submit.textContent = '正在验证凭证…';
      try {
        const saved = isEdit ? await api('PATCH', `/api/bots/${bot.id}`, body) : await api('POST', '/api/bots', body);
        toast(isEdit ? '已保存' : '机器人已添加', 'ok');
        close();
        await actions.reloadBots(saved.id);
      } catch (e) {
        err.textContent = e.message;
      } finally {
        submit.disabled = false;
        submit.textContent = isEdit ? '保存' : '添加并上线';
      }
    };

    m.append(
      h('h2', {}, isEdit ? '机器人账号设置' : '添加机器人账号'),
      field('AppID', appId, isEdit ? null : '在 <a href="https://q.qq.com/" target="_blank" rel="noopener">QQ 开放平台</a> → 开发 → 开发设置 中查看'),
      field('AppSecret', secret, '凭证在服务器上加密保存，不会返回给浏览器'),
      field('显示名称', name),
      field('事件接收方式', mode),
      whHint,
      h('div', { class: 'field' }, h('label', {}, '事件订阅（Intents，仅 WebSocket 模式）'), h('div', { class: 'checks' }, checks.map((c) => c.el))),
      h('details', {}, h('summary', { class: 'muted small', style: 'margin-bottom:8px;cursor:pointer' }, '高级'), field('OpenAPI 地址', apiBase)),
      err,
      h('div', { class: 'actions' },
        isEdit ? h('button', { class: 'btn danger', style: 'margin-right:auto', onclick: () => removeBot(bot, close) }, '删除') : null,
        isEdit ? h('button', { class: 'btn', onclick: () => toggleBot(bot, close) }, bot.enabled ? '停用' : '启用') : null,
        isEdit ? h('button', { class: 'btn', onclick: () => restartBot(bot, close) }, '重连') : null,
        h('button', { class: 'btn', onclick: close }, '取消'),
        submit),
    );
  });
}

async function removeBot(bot, close) {
  if (!(await confirmBox('删除机器人', `确定删除「${bot.name}」吗？该账号的所有会话、聊天记录和事件都会从面板中删除，且无法恢复。`, '删除', true))) return;
  try {
    await api('DELETE', `/api/bots/${bot.id}`);
    close();
    toast('已删除');
    await actions.reloadBots();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function toggleBot(bot, close) {
  try {
    await api('PATCH', `/api/bots/${bot.id}`, { enabled: !bot.enabled });
    close();
    await actions.reloadBots(bot.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function restartBot(bot, close) {
  try {
    await api('POST', `/api/bots/${bot.id}/restart`);
    close();
    toast('正在重新连接');
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function settingsDialog() {
  openModal((m, close) => {
    const oldPw = h('input', { type: 'password', autocomplete: 'current-password' });
    const newPw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: '至少 8 位' });
    const err = h('p', { class: 'form-error' });
    m.append(
      h('h2', {}, '面板设置'),
      h('div', { class: 'field' }, h('label', {}, '当前用户'), h('div', {}, state.username || 'admin')),
      field('原密码', oldPw),
      field('新密码', newPw),
      err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn danger', style: 'margin-right:auto', onclick: async () => {
          await api('POST', '/api/logout');
          location.reload();
        } }, '退出登录'),
        h('button', { class: 'btn', onclick: close }, '关闭'),
        h('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          try {
            await api('POST', '/api/password', { oldPassword: oldPw.value, newPassword: newPw.value });
            toast('密码已修改，请重新登录', 'ok');
            setTimeout(() => location.reload(), 800);
          } catch (e) {
            err.textContent = e.message;
          }
        } }, '修改密码')),
    );
  });
}
