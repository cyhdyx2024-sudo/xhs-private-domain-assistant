document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const Safety = globalThis.XhsSafety;
  const storageGet = keys => new Promise(resolve => chrome.storage.local.get(keys, resolve));
  const storageSet = values => new Promise(resolve => chrome.storage.local.set(values, resolve));

  const keys = ['onboardingComplete', 'enabled', 'runMode', 'timeScope', 'fullAutoArmedAt', 'operatorAway', 'repliedCount', 'leadsCount', 'statsDate', 'bridgeUrl', 'workspaceToken'];
  let config = await storageGet(keys);
  const dailyStats = Safety.normalizeDailyStats(config);
  if (dailyStats.statsDate !== config.statsDate) {
    await storageSet(dailyStats);
    config = { ...config, ...dailyStats };
  }

  function updateStatus() {
    const on = $('masterToggle').checked;
    $('headerStatus').textContent = !config.onboardingComplete ? '待配置' : (on ? '运行中' : '已暂停');
    $('headerStatus').style.color = on ? '#10b981' : '#f59e0b';
    $('switchDesc').textContent = !config.onboardingComplete ? '请先打开完整管理控制台完成首次设置' : (!on ? '已暂停，不读取、不生成、不发送' : ($('runMode').value === 'full_auto' ? '请在工作台点击“开始无人值守”后运行' : '半自动副驾：只预填，人工确认发送'));
  }

  $('masterToggle').checked = Boolean(config.onboardingComplete && config.enabled === true);
  $('runMode').value = config.runMode || 'copilot';
  $('timeScope').value = config.timeScope || 'all_day';
  $('todayReplied').textContent = config.repliedCount || 0;
  $('todayLeads').textContent = config.leadsCount || 0;
  updateStatus();

  async function refreshServerStats() {
    if (!config.workspaceToken) return;
    const bridgeUrl = String(config.bridgeUrl || 'http://127.0.0.1:18195').replace(/\/+$/, '');
    try {
      const response = await fetch(`${bridgeUrl}/report/today`, {
        headers: { Authorization: `Bearer ${config.workspaceToken}` }, cache: 'no-store'
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data.ok) return;
      config.repliedCount = Number(data.replies || 0);
      config.leadsCount = Number(data.leads || 0);
      $('todayReplied').textContent = config.repliedCount;
      $('todayLeads').textContent = config.leadsCount;
      await storageSet({ repliedCount: config.repliedCount, leadsCount: config.leadsCount });
    } catch (_) { /* Bridge 离线时保留本地统计，不阻塞弹窗 */ }
  }

  refreshServerStats();

  async function notify(patch) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: 'CONFIG_UPDATED', config: patch }).catch(() => {});
  }

  async function saveRuntime() {
    if (!config.onboardingComplete) {
      $('masterToggle').checked = false;
      $('runMode').value = 'copilot';
      await storageSet({ enabled: false, runMode: 'copilot', fullAutoArmedAt: 0, operatorAway: false });
      updateStatus();
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      return;
    }
    if ($('runMode').value === 'full_auto' && !$('masterToggle').checked) $('runMode').value = 'copilot';
    const patch = {
      enabled: $('masterToggle').checked,
      runMode: $('runMode').value,
      timeScope: $('timeScope').value,
      fullAutoArmedAt: 0,
      operatorAway: false
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
  $('btnSyncLeads').addEventListener('click', async () => {
    const button = $('btnSyncLeads');
    button.disabled = true;
    button.textContent = '正在扫描留资会话…';
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id || !/^https:\/\/(?:[^/]+\.)?xiaohongshu\.com\//.test(tabs[0].url || '')) {
        throw new Error('请先打开小红书客服工作台');
      }
      const result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'SYNC_PLATFORM_LEADS' });
      if (!result?.ok) throw new Error(result?.error || '同步失败');
      await refreshServerStats();
      button.textContent = result.tagged
        ? `完成：识别 ${result.captured}/${result.tagged} 条`
        : '当前列表没有“留客资”会话';
    } catch (error) {
      button.textContent = error.message || '同步失败，请刷新工作台';
    } finally {
      setTimeout(() => { button.disabled = false; button.textContent = '同步平台留资'; }, 2800);
    }
  });
  $('btnQuickInject').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) chrome.tabs.reload(tabs[0].id);
    window.close();
  });
});
