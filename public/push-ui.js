// Web Push 订阅：手机或电脑在面板关闭时也能收到私聊和 @机器人 的通知
import { h, api, toast } from './lib.js';
import { settingsSections } from './bots-ui.js';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    // 点击通知时跳到对应会话
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open' && e.data.url) location.hash = new URL(e.data.url, location.origin).hash;
    });
    return reg;
  } catch (e) {
    console.warn('注册 Service Worker 失败', e);
    return null;
  }
}

function keyToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function currentSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enable() {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('浏览器没有授予通知权限');
  const { publicKey } = await api('GET', '/api/push');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
  await api('POST', '/api/push/subscribe', sub.toJSON());
}

async function disable() {
  const sub = await currentSub();
  if (!sub) return;
  await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

settingsSections.push(async () => {
  const box = h('div', { class: 'settings-section' }, h('h3', {}, '推送通知'));
  if (!supported()) {
    box.append(h('p', { class: 'muted small' }, '当前浏览器不支持推送通知。iPhone 需要先把面板“添加到主屏幕”，再从主屏幕打开。'));
    return box;
  }
  if (!window.isSecureContext) {
    box.append(h('p', { class: 'muted small' }, '推送通知需要通过 HTTPS 访问面板（本机 localhost 除外）。'));
    return box;
  }
  const draw = async () => {
    const sub = await currentSub().catch(() => null);
    const { count } = await api('GET', '/api/push').catch(() => ({ count: 0 }));
    box.replaceChildren(
      h('h3', {}, '推送通知'),
      h('p', { class: 'muted small' }, `面板没打开时，私聊和 @机器人 的消息也会推送到这台设备。已登记 ${count} 台设备。手机上可以用浏览器菜单“添加到主屏幕”，像应用一样使用。`),
      h('div', { class: 'row-fields' },
        sub
          ? h('button', { class: 'btn small', onclick: async () => {
            await disable();
            toast('这台设备已关闭推送');
            draw();
          } }, '在这台设备关闭推送')
          : h('button', { class: 'btn small primary', onclick: async () => {
            try {
              await enable();
              toast('已开启推送', 'ok');
              draw();
            } catch (e) {
              toast(e.message, 'error');
            }
          } }, '在这台设备开启推送'),
        sub ? h('button', { class: 'btn small', onclick: async () => {
          try {
            const r = await api('POST', '/api/push/test');
            toast(`已发送到 ${r.ok}/${r.total} 台设备`, 'ok');
          } catch (e) {
            toast(e.message, 'error');
          }
        } }, '发送测试通知') : null));
  };
  await draw();
  return box;
});
