document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const storageGet = keys => new Promise(resolve => chrome.storage.local.get(keys, resolve));
  const storageSet = values => new Promise(resolve => chrome.storage.local.set(values, resolve));

  const keys = ['onboardingComplete', 'enabled', 'runMode', 'timeScope', 'fullAutoArmedAt', 'repliedCount', 'leadsCount'];
  let config = await storageGet(keys);

  function updateStatus() {
    const on = $('masterToggle').checked;
    $('headerStatus').textContent = on ? '运行中' : '已暂停';
    $('headerStatus').style.color = on ? '#10b981' : '#f59e0b';
    $('switchDesc').textContent = !on ? '已暂停，不读取、不生成、不发送' : ($('runMode').value === 'full_auto' ? '全自动已武装；人工操作时暂停' : '半自动副驾：只预填，人工确认发送');
  }

  $('masterToggle').checked = config.enabled !== false;
  $('runMode').value = config.runMode || 'copilot';
  $('timeScope').value = config.timeScope || 'all_day';
  $('todayReplied').textContent = config.repliedCount || 0;
  $('todayLeads').textContent = config.leadsCount || 0;
  updateStatus();

  async function notify(patch) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: 'CONFIG_UPDATED', config: patch }).catch(() => {});
  }

  async function saveRuntime() {
    if ($('runMode').value === 'full_auto' && !$('masterToggle').checked) $('runMode').value = 'copilot';
    const patch = {
      enabled: $('masterToggle').checked,
      runMode: $('runMode').value,
      timeScope: $('timeScope').value,
      fullAutoArmedAt: $('masterToggle').checked && $('runMode').value === 'full_auto' ? Date.now() : 0
    };
    await storageSet(patch);
    config = { ...config, ...patch };
    updateStatus();
    notify(patch);
  }

  $('masterToggle').addEventListener('change', saveRuntime);
  $('runMode').addEventListener('change', saveRuntime);
  $('timeScope').addEventListener('change', saveRuntime);

  $('btnOpenStudio').addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  });

  $('btnOpenXhs').addEventListener('click', () => chrome.tabs.create({ url: 'https://pro.xiaohongshu.com/im/multiCustomerService' }));
  $('btnQuickInject').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) chrome.tabs.reload(tabs[0].id);
    window.close();
  });
});
