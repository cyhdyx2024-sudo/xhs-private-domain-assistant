document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const SERVICE_URL = 'http://127.0.0.1:18195';

  const PROVIDERS = {
    opencodex_local: { url: 'http://127.0.0.1:10100/v1/chat/completions', model: 'google-antigravity/gemini-3.7-flash', embeddingUrl: '', embeddingModel: '' },
    // 兼容旧版本地配置，界面统一显示为 OpenCodex。
    gemini_local: { url: 'http://127.0.0.1:10100/v1/chat/completions', model: 'google-antigravity/gemini-3.7-flash', embeddingUrl: '', embeddingModel: '' },
    deepseek: { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', embeddingUrl: '', embeddingModel: '' },
    openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini', embeddingUrl: 'https://api.openai.com/v1/embeddings', embeddingModel: 'text-embedding-3-small' },
    dashscope: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', embeddingUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', embeddingModel: 'text-embedding-v3' },
    zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', embeddingUrl: 'https://open.bigmodel.cn/api/paas/v4/embeddings', embeddingModel: 'embedding-3' },
    moonshot: { url: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', embeddingUrl: '', embeddingModel: '' },
    siliconflow: { url: 'https://api.siliconflow.cn/v1/chat/completions', model: 'deepseek-ai/DeepSeek-V3', embeddingUrl: 'https://api.siliconflow.cn/v1/embeddings', embeddingModel: 'BAAI/bge-m3' },
    volcengine: { url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'doubao-lite-32k', embeddingUrl: '', embeddingModel: '' },
    minimax: { url: 'https://api.minimax.chat/v1/text/chatcompletion_v2', model: 'abab6.5s-chat', embeddingUrl: '', embeddingModel: '' },
    openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'deepseek/deepseek-chat', embeddingUrl: '', embeddingModel: '' },
    custom: { url: '', model: '', embeddingUrl: '', embeddingModel: '' }
  };

  const storageGet = keys => new Promise(resolve => chrome.storage.local.get(keys, resolve));
  const storageSet = values => new Promise(resolve => chrome.storage.local.set(values, resolve));
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  async function bridgeFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'BRIDGE_FETCH',
        url,
        options: {
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.body || undefined
        }
      }, res => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!res) return reject(new Error('未收到响应'));
        const pseudoResponse = {
          ok: Boolean(res.ok),
          status: Number(res.status || 0),
          statusText: String(res.statusText || ''),
          json: async () => (res.data !== null ? res.data : JSON.parse(res.text || '{}')),
          text: async () => String(res.text || '')
        };
        resolve(pseudoResponse);
      });
    });
  }

  async function readJson(response) {
    const text = await response.text();
    try { return text ? JSON.parse(text) : {}; }
    catch (_) { return { ok: false, error: text.slice(0, 160) || `HTTP ${response.status}` }; }
  }

  async function checkBridgeHealth() {
    const pill = $('topStatusPill');
    const label = $('topStatusText');
    pill.classList.remove('online', 'warning', 'error');
    label.textContent = '正在检查本机 Bridge…';
    try {
      const response = await bridgeFetch(`${SERVICE_URL}/healthz`, { cache: 'no-store' });
      const data = await readJson(response);
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (data.product_mode !== true) {
        pill.classList.add('warning');
        label.textContent = 'Bridge 为开发模式，不建议正式使用';
        return false;
      }
      pill.classList.add('online');
      label.textContent = '本机 Bridge 已就绪 · 安全模式';
      return true;
    } catch (_) {
      pill.classList.add('error');
      label.textContent = '本机 Bridge 未连接';
      return false;
    }
  }

  async function registerWorkspace(workspaceName) {
    const response = await bridgeFetch(`${SERVICE_URL}/tenant/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_name: workspaceName })
    });
    const data = await readJson(response);
    if (!response.ok || !data.ok || !data.access_token) throw new Error(data.error || '工作区注册失败');
    return data.access_token;
  }

  async function saveTenantConfig(token, payload) {
    const response = await bridgeFetch(`${SERVICE_URL}/tenant/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    const data = await readJson(response);
    return { response, data };
  }

  const keys = [
    'onboardingComplete', 'enabled', 'runMode', 'timeScope', 'fullAutoArmedAt',
    'maxRepliesPerHour', 'repliedCount', 'leadsCount', 'bridgeUrl', 'workspaceToken',
    'workspaceName', 'modelBaseUrl', 'modelName', 'modelApiKey', 'embeddingBaseUrl',
    'embeddingModel', 'embeddingApiKey', 'feishuAppId', 'feishuAppSecret', 'accountId',
    'knowledgeScope', 'brandName', 'operatorNickname', 'businessProfile', 'replyPreferences', 'toneProfile',
    'autoReplyMaxAgeMinutes', 'contactBlacklist', 'configVersion', 'followupStateMap',
    'historyLearnedAt', 'learnedSummary'
  ];

  let config = await storageGet(keys);

  // Tab Navigation
  const navItems = document.querySelectorAll('.nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const pageTitles = {
    reply: '我的回复方式',
    crm: '客户跟进',
    settings: '接入设置'
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.dataset.tab;
      navItems.forEach(n => {
        const active = n === item;
        n.classList.toggle('active', active);
        if (active) n.setAttribute('aria-current', 'page');
        else n.removeAttribute('aria-current');
      });
      tabPanes.forEach(p => p.classList.toggle('active', p.dataset.group === target));
      $('pageHeaderTitle').textContent = pageTitles[target] || '工作台设置';
      if (target === 'crm') { loadFollowupQueue(); loadLeads(); loadTodayReport(); }
      if (target === 'settings') { loadDocuments(); loadFaqs(); loadFeedback(); }
    });
  });

  // Populate Form Fields
  function populate() {
    let matchedProvider = 'custom';
    for (const [key, p] of Object.entries(PROVIDERS)) {
      if (p.url && config.modelBaseUrl === p.url) {
        matchedProvider = key;
        break;
      }
    }
    if (!config.modelApiKey) matchedProvider = 'opencodex_local';
    if (config.modelBaseUrl === PROVIDERS.opencodex_local.url) matchedProvider = 'opencodex_local';
    if (!config.modelBaseUrl && !config.modelApiKey) matchedProvider = 'opencodex_local';
    $('modelProvider').value = matchedProvider;

    const defaultProvider = PROVIDERS[matchedProvider] || PROVIDERS.opencodex_local;
    $('modelBaseUrl').value = config.modelApiKey ? (config.modelBaseUrl || defaultProvider.url) : defaultProvider.url;
    $('modelName').value = config.modelApiKey ? (config.modelName || defaultProvider.model) : defaultProvider.model;
    $('modelApiKey').value = config.modelApiKey || '';
    $('embeddingBaseUrl').value = config.embeddingBaseUrl || '';
    $('embeddingModel').value = config.embeddingModel || '';
    $('embeddingApiKey').value = config.embeddingApiKey || '';

    $('workspaceName').value = config.workspaceName || '我的工作区';
    $('workspaceToken').value = config.workspaceToken || '';
    $('accountId').value = config.accountId || '';
    $('businessLine').value = config.knowledgeScope || 'default';
    $('brandName').value = config.brandName || '新作AI';
    $('operatorNickname').value = config.operatorNickname || '新作AI';
    $('toneProfile').value = config.toneProfile || 'creator_ip';
    $('businessProfile').value = config.businessProfile || '【产品定位】新作AI（新作2.0）：面向中小企业与内容创作者的电脑网页端获客图文工具，支持3:4多页图文排版、业务资料知识库与小红书私信副驾。包含专属内测邀请码与算力福利。';
    $('replyPreferences').value = config.replyPreferences || '先回应客户最后一条消息中的具体问题；结合上下文自然引导体验电脑端或留微信号；语气像真人主理人，自然干练，不堆Emoji，不生硬推销。';

    const learnStatus = $('learnHistoryStatus');
    if (config.historyLearnedAt) {
      learnStatus.textContent = `${config.learnedSummary || '已学习历史回复'} · 可继续在下方补充修改`;
      learnStatus.classList.add('success');
    }

    $('feishuAppId').value = config.feishuAppId || '';
    $('feishuAppSecret').value = config.feishuAppSecret || '';

    $('masterToggle').value = String(Boolean(config.onboardingComplete && config.enabled === true));
    $('runMode').value = config.onboardingComplete ? (config.runMode || 'copilot') : 'copilot';
    $('timeScope').value = config.timeScope || 'all_day';
    $('maxRepliesPerHour').value = config.maxRepliesPerHour || 12;
    $('autoReplyMaxAgeMinutes').value = config.autoReplyMaxAgeMinutes || 120;
    $('contactBlacklist').value = Array.isArray(config.contactBlacklist) ? config.contactBlacklist.join('\n') : '';
  }

  // Model Provider Switch
  async function loadOpenCodexModels() {
    if ($('modelProvider').value !== 'opencodex_local') return;
    try {
      const response = await fetch('http://127.0.0.1:10100/v1/models', { cache: 'no-store' });
      const data = await readJson(response);
      const models = Array.isArray(data.data) ? data.data.map(item => item.id).filter(Boolean) : [];
      if (models.length && !models.includes($('modelName').value.trim())) {
        $('modelName').value = models.includes('google-antigravity/gemini-3.7-flash')
          ? 'google-antigravity/gemini-3.7-flash'
          : models[0];
      }
      $('modelName').setAttribute('list', 'opencodexModelList');
      let list = $('opencodexModelList');
      if (!list) {
        list = document.createElement('datalist');
        list.id = 'opencodexModelList';
        document.body.appendChild(list);
      }
      list.replaceChildren(...models.slice(0, 100).map(id => {
        const option = document.createElement('option');
        option.value = id;
        return option;
      }));
    } catch (_) {
      // OpenCodex 未启动时保留可编辑模型名，由连接测试给出明确错误。
    }
  }

  $('modelProvider').addEventListener('change', e => {
    const p = PROVIDERS[e.target.value];
    if (p && e.target.value !== 'custom') {
      $('modelBaseUrl').value = p.url;
      $('modelName').value = p.model;
      $('embeddingBaseUrl').value = p.embeddingUrl;
      $('embeddingModel').value = p.embeddingModel;
    }
    loadOpenCodexModels();
  });

  // Save All Configuration
  async function saveAll() {
    $('btnSaveAll').disabled = true;
    $('btnSaveAll').textContent = '正在保存...';

    try {
      const modelUrl = $('modelBaseUrl').value.trim();
      const modelName = $('modelName').value.trim();
      const modelKey = $('modelApiKey').value.trim();
      const isLocalGateway = $('modelProvider').value === 'opencodex_local'
        || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/v1\/chat\/completions\/?$/i.test(modelUrl);
      if (!isLocalGateway) {
        if (!modelKey) throw new Error('请先填写大模型 API Key');
        if (!modelUrl || !/^https:\/\//i.test(modelUrl)) throw new Error('模型 API 地址必须是有效的 HTTPS 地址');
        if (!modelName) throw new Error('请填写模型名称');
      }

      let token = $('workspaceToken').value.trim() || config.workspaceToken || '';
      const wsName = $('workspaceName').value.trim() || 'My_Workspace';

      // 1. 保存业务配置。已有工作区凭据失效时必须显式停下，不能静默创建新租户，
      // 否则旧知识库、反馈案例和线索会在界面上像“消失”了一样。
      const businessPayload = {
        workspace_name: wsName,
        account_id: $('accountId').value.trim(),
        business_line: $('businessLine').value.trim() || 'default',
        brand_name: $('brandName').value.trim(),
        business_profile: $('businessProfile').value.trim(),
        reply_preferences: $('replyPreferences').value.trim()
      };

      if (!token) token = await registerWorkspace(wsName);
      let saved = await saveTenantConfig(token, businessPayload);
      if (saved.response.status === 401 || saved.response.status === 403 || saved.data.error === 'workspace_token_invalid') {
        token = await registerWorkspace(wsName);
        saved = await saveTenantConfig(token, businessPayload);
      }
      if (!saved.response.ok || !saved.data.ok) throw new Error(saved.data.error || `业务配置保存失败（HTTP ${saved.response.status}）`);

      // 3. Save Local Config
      const newConfig = {
        configVersion: Date.now(),
        onboardingComplete: true,
        enabled: $('masterToggle').value === 'true',
        runMode: $('runMode').value,
        timeScope: $('timeScope').value,
        fullAutoArmedAt: 0,
        operatorAway: false,
        maxRepliesPerHour: Number($('maxRepliesPerHour').value) || 12,
        autoReplyMaxAgeMinutes: Math.min(120, Math.max(10, Number($('autoReplyMaxAgeMinutes').value) || 120)),
        contactBlacklist: $('contactBlacklist').value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean),
        bridgeUrl: SERVICE_URL,
        workspaceToken: token,
        workspaceName: wsName,
        modelBaseUrl: modelUrl,
        modelName,
        modelApiKey: modelKey,
        embeddingBaseUrl: $('embeddingBaseUrl').value.trim(),
        embeddingModel: $('embeddingModel').value.trim(),
        embeddingApiKey: $('embeddingApiKey').value.trim(),
        feishuAppId: $('feishuAppId').value.trim(),
        feishuAppSecret: $('feishuAppSecret').value.trim(),
        accountId: businessPayload.account_id,
        knowledgeScope: businessPayload.business_line,
        brandName: businessPayload.brand_name,
        operatorNickname: $('operatorNickname').value.trim(),
        toneProfile: $('toneProfile').value,
        businessProfile: businessPayload.business_profile,
        replyPreferences: businessPayload.reply_preferences
      };

      await storageSet(newConfig);
      config = { ...config, ...newConfig };

      // Notify tabs
      const tabs = await chrome.tabs.query({});
      tabs.forEach(tab => {
        if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATED', config: newConfig }).catch(() => {});
      });

      $('btnSaveAll').textContent = '已保存';
      setTimeout(() => { $('btnSaveAll').textContent = '保存配置'; $('btnSaveAll').disabled = false; }, 1500);
    } catch (err) {
      alert('保存失败：' + err.message);
      $('btnSaveAll').textContent = '保存配置';
      $('btnSaveAll').disabled = false;
    }
  }

  $('btnSaveAll').addEventListener('click', saveAll);

  // Test the real product chain: workspace token -> Bridge -> model provider.
  $('btnTestModel').addEventListener('click', async () => {
    const resBox = $('modelTestResult');
    resBox.style.display = 'block';
    resBox.style.color = '#64748b';
    resBox.textContent = '正在发起测试请求...';

    const url = $('modelBaseUrl').value.trim();
    const key = $('modelApiKey').value.trim();
    const model = $('modelName').value.trim();

    const localOpenCodex = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/v1\/chat\/completions\/?$/i.test(url);
    if (!key && !localOpenCodex) {
      resBox.style.color = '#ef4444';
      resBox.textContent = '远程模型必须填写 API Key；本机 OpenCodex 可以留空';
      return;
    }

    if (!config.workspaceToken) {
      resBox.style.color = '#ef4444';
      resBox.textContent = '请先保存配置，创建工作区后再测试完整链路';
      return;
    }

    const start = Date.now();
    try {
      const response = await bridgeFetch(`${SERVICE_URL}/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.workspaceToken}`,
          'X-Model-Key': key,
          'X-Model-Base-Url': url,
          'X-Model-Name': model
        },
        body: JSON.stringify({
          session_id: 'settings_e2e_test', user_name: '链路测试', action: 'reply',
          latest_msg: '请只回复：链路正常', turns: [{ role: 'user', content: '请只回复：链路正常' }]
        })
      });

      const latency = Date.now() - start;
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.slice(0, 100)}`);
      }

      resBox.style.color = '#10b981';
      resBox.textContent = `完整链路通过！工作区、Bridge 与模型均正常 · ${latency}ms · [${model}]`;
    } catch (e) {
      resBox.style.color = '#ef4444';
      resBox.textContent = `连接失败：${e.message}`;
    }
  });

  // Load Documents
  async function loadDocuments() {
    const tbody = $('documentTableBody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:16px;">正在读取知识库文档...</td></tr>';

    try {
      let token = config.workspaceToken || '';
      if (!token) {
        token = await registerWorkspace($('workspaceName')?.value.trim() || '新作AI创作工作台');
        config.workspaceToken = token;
        await storageSet({ workspaceToken: token });
      }
      let res = await bridgeFetch(`${SERVICE_URL}/knowledge/documents`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      let data = await res.json();
      if (res.status === 401 || data.error === 'workspace_token_invalid') {
        token = await registerWorkspace($('workspaceName')?.value.trim() || '新作AI创作工作台');
        config.workspaceToken = token;
        await storageSet({ workspaceToken: token });
        res = await bridgeFetch(`${SERVICE_URL}/knowledge/documents`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        data = await res.json();
      }
      if (!res.ok || !data.ok) throw new Error(data.error || '获取失败');

      if (!data.items || data.items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">暂无已上传的业务资料，拖拽文件即可添加</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      data.items.forEach(doc => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight:600;">${escapeHtml(doc.title)}</td>
          <td><span class="status-pill">${escapeHtml((doc.source_type || 'file').toUpperCase())}</span></td>
          <td>${Number(doc.chunk_count || 0)} 段</td>
          <td><span class="status-pill ${doc.status === 'ready' ? 'online' : 'warning'}">${doc.status === 'ready' ? '向量+关键词' : '关键词索引'}</span></td>
          <td>
            <button class="btn btn-secondary btn-sm btn-toggle-doc" data-id="${escapeHtml(doc.id)}" data-enabled="${doc.enabled ? 'true' : 'false'}">
              ${doc.enabled ? '停用' : '恢复'}
            </button>
          </td>
        `;
        tbody.appendChild(tr);
      });

      document.querySelectorAll('.btn-toggle-doc').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const currentEnabled = btn.dataset.enabled === 'true' || btn.dataset.enabled === '1';
          if (currentEnabled && !confirm('确定软停用该资料？数据会完整保留，随时可恢复。')) return;

          await bridgeFetch(`${SERVICE_URL}/knowledge/status`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.workspaceToken || ''}`
            },
            body: JSON.stringify({ id, enabled: !currentEnabled, soft: true })
          });
          loadDocuments();
        });
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:16px;">读取失败: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  $('btnRefreshDocs').addEventListener('click', loadDocuments);

  // File Upload Handlers
  const dropzone = $('knowledgeDropzone');
  const fileInput = $('fileUploadInput');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files.length) handleFiles(e.target.files);
  });

  async function handleFiles(files) {
    const status = $('uploadStatusText');
    for (const file of Array.from(files)) {
      if (file.size > 10 * 1024 * 1024) {
        alert(`${file.name} 超过 10MB 上限`);
        continue;
      }
      status.textContent = `正在上传并解析 ${file.name}...`;
      const base64 = await new Promise(res => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(',')[1]);
        r.readAsDataURL(file);
      });

      try {
        const res = await bridgeFetch(`${SERVICE_URL}/knowledge/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.workspaceToken || ''}`,
            'X-Model-Base-Url': $('modelBaseUrl').value.trim(),
            'X-Model-Key': $('modelApiKey').value.trim(),
            'X-Model-Name': $('modelName').value.trim(),
            'X-Embedding-Base-Url': $('embeddingBaseUrl').value.trim(),
            'X-Embedding-Model': $('embeddingModel').value.trim(),
            'X-Embedding-Key': $('embeddingApiKey').value.trim()
          },
          body: JSON.stringify({ filename: file.name, content_base64: base64 })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '上传失败');
        status.textContent = `✅ ${file.name} 已成功入库 · 生成 ${data.document.chunk_count} 个切片`;
      } catch (err) {
        status.textContent = `❌ ${file.name} 导入失败: ${err.message}`;
      }
    }
    loadDocuments();
  }

  // Feishu Import
  $('btnImportFeishu').addEventListener('click', async () => {
    const url = $('feishuDocUrl').value.trim();
    if (!url) return alert('请先粘贴飞书文档链接');

    $('btnImportFeishu').disabled = true;
    $('btnImportFeishu').textContent = '正在读取飞书...';

    try {
      const res = await bridgeFetch(`${SERVICE_URL}/knowledge/feishu`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.workspaceToken || ''}`,
          'X-Feishu-App-Id': $('feishuAppId').value.trim(),
          'X-Feishu-App-Secret': $('feishuAppSecret').value.trim()
        },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '飞书文档读取失败');
      alert(`飞书文档导入成功！已生成 ${data.document.chunk_count} 个知识切片`);
      $('feishuDocUrl').value = '';
      loadDocuments();
    } catch (e) {
      alert('飞书导入失败：' + e.message);
    } finally {
      $('btnImportFeishu').disabled = false;
      $('btnImportFeishu').textContent = '一键导入飞书';
    }
  });

  // Sandbox Test Query
  $('btnRunTestQuery').addEventListener('click', async () => {
    const q = $('testQueryInput').value.trim();
    const resultBox = $('testQueryResult');
    if (!q) return alert('请输入模拟提问内容');

    resultBox.style.display = 'block';
    resultBox.innerHTML = '正在检索知识切片...';

    let token = config.workspaceToken || '';
    if (!token) {
      token = await registerWorkspace($('workspaceName')?.value.trim() || '新作AI创作工作台');
      config.workspaceToken = token;
      await storageSet({ workspaceToken: token });
    }
    const modelKey = $('modelApiKey').value.trim();

    try {
      if (!modelKey) {
        // 纯知识库检索模式（免 API Key 调试）
        const res = await bridgeFetch(`${SERVICE_URL}/knowledge/retrieve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ query: q })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '检索失败');
        const chunks = data.chunks || [];
        const faqs = data.faqs || [];
        resultBox.innerHTML = `
          <div style="font-size:12px;color:#16a34a;margin-bottom:8px;">✅ 纯知识库召回检索成功（未填模型 Key，展示原始命中切片与问答）：</div>
          ${faqs.length ? `
            <div style="font-weight:700;margin-bottom:6px;color:#0f172a;">💬 命中的标准问答 (FAQ ${faqs.length} 条)：</div>
            ${faqs.map(f => `
              <div style="background:#fff7ed;padding:8px 10px;border-radius:6px;border:1px solid #fed7aa;margin-bottom:6px;font-size:12px;">
                <strong>问：${escapeHtml(f.question)}</strong><br>
                <span style="color:#475569;">答：${escapeHtml(f.answer)}</span>
              </div>
            `).join('')}
          ` : ''}
          <div style="font-weight:700;margin-bottom:6px;color:#0f172a;">🔍 命中的文档知识切片 (${chunks.length} 条)：</div>
          ${chunks.length ? chunks.map((s, idx) => `
            <div style="background:#ffffff;padding:8px 10px;border-radius:6px;border:1px solid #e2e8f0;margin-bottom:6px;font-size:12px;">
              <strong>[${idx + 1}] ${escapeHtml(s.heading || s.title || '知识点')}</strong>: ${escapeHtml(s.content)}
            </div>
          `).join('') : '<div style="color:#94a3b8;font-size:12px;">未命中特定文档片段，后续将基于通用常识作答</div>'}
        `;
        return;
      }

      // 带模型生成的端到端测试
      const res = await bridgeFetch(`${SERVICE_URL}/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Model-Base-Url': $('modelBaseUrl').value.trim(),
          'X-Model-Key': modelKey,
          'X-Model-Name': $('modelName').value.trim()
        },
        body: JSON.stringify({
          session_id: 'sandbox_test',
          user_name: '测试客户',
          action: 'reply',
          latest_msg: q,
          turns: [{ role: 'user', content: q }]
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');

      const sources = data.knowledge_sources || [];
      resultBox.innerHTML = `
        <div style="font-weight:700;margin-bottom:8px;color:#0f172a;">🤖 AI 预估回复：</div>
        <div style="background:#ffffff;padding:10px;border-radius:6px;border:1px solid #e2e8f0;margin-bottom:12px;">${escapeHtml(data.reply || '无回复')}</div>
        <div style="font-weight:700;margin-bottom:6px;color:#0f172a;">🔍 命中的知识片段 (${sources.length} 条)：</div>
        ${sources.length ? sources.map((s, idx) => `
          <div style="background:#ffffff;padding:8px 10px;border-radius:6px;border:1px solid #e2e8f0;margin-bottom:6px;font-size:12px;">
            <strong>[${idx + 1}] ${escapeHtml(s.heading || '知识点')}</strong>: ${escapeHtml(s.content)}
          </div>
        `).join('') : '<div style="color:#94a3b8;font-size:12px;">未命中特定文档，将直接基于业务画像与通用常识作答（安全兜底）</div>'}
      `;
    } catch (e) {
      resultBox.innerHTML = `<span style="color:#ef4444;">检索失败: ${escapeHtml(e.message)}</span>`;
    }
  });

  // --- FAQ Management ---
  async function loadFaqs() {
    const tbody = $('faqTableBody');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;">正在加载标准问答...</td></tr>';
    try {
   let token = config.workspaceToken || '';
      let res = await bridgeFetch(`${SERVICE_URL}/knowledge/faq/list`, {
       headers: { 'Authorization': `Bearer ${token}` }
      });
      let data = await res.json();
      if (res.status === 401 || data.error === 'workspace_token_invalid') {
        token = await registerWorkspace($('workspaceName')?.value.trim() || '新作AI创作工作台');
       config.workspaceToken = token;
       await storageSet({ workspaceToken: token });
        res = await bridgeFetch(`${SERVICE_URL}/knowledge/faq/list`, {
         headers: { 'Authorization': `Bearer ${token}` }
       });
       data = await res.json();
      }
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.items || !data.items.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:24px;">暂无已配置的标准问答对，在上方添加即可生效</td></tr>';
        return;
      }
      tbody.innerHTML = data.items.map(faq => `
        <tr>
          <td style="font-weight:600;">${escapeHtml(faq.question)}</td>
          <td>${escapeHtml(faq.answer)}</td>
          <td><span class="status-pill">${escapeHtml(faq.keywords || '智能匹配')}</span></td>
          <td>
            <button class="btn btn-secondary btn-sm btn-delete-faq" data-id="${escapeHtml(faq.id)}">删除</button>
          </td>
        </tr>
      `).join('');

     document.querySelectorAll('.btn-delete-faq').forEach(btn => {
       btn.addEventListener('click', async () => {
         if (!confirm('确定删除此问答对？')) return;
          await bridgeFetch(`${SERVICE_URL}/knowledge/faq/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.workspaceToken || ''}` },
            body: JSON.stringify({ id: btn.dataset.id })
          }).then(async response => {
            const data = await readJson(response);
            if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
          });
          loadFaqs();
        });
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#ef4444;padding:16px;">加载失败: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  $('btnAddFaq').addEventListener('click', async () => {
    const q = $('faqQuestion').value.trim();
    const a = $('faqAnswer').value.trim();
    const kw = $('faqKeywords').value.trim();
    if (!q || !a) return alert('请填写问题与标准回答要点');

   try {
      const res = await bridgeFetch(`${SERVICE_URL}/knowledge/faq/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.workspaceToken || ''}` },
        body: JSON.stringify({ question: q, answer: a, keywords: kw })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '添加失败');
      $('faqQuestion').value = '';
      $('faqAnswer').value = '';
      $('faqKeywords').value = '';
      loadFaqs();
    } catch (e) {
      alert('添加失败：' + e.message);
    }
  });
  $('btnRefreshFaq').addEventListener('click', loadFaqs);

  // --- CRM Leads Management ---
  async function loadLeads() {
    const tbody = $('leadsTableBody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:16px;">正在加载客资列表...</td></tr>';
   try {
      const res = await bridgeFetch(`${SERVICE_URL}/leads/list`, {
        headers: { 'Authorization': `Bearer ${config.workspaceToken || ''}` }
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.items || !data.items.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">暂无捕获客资。当客户在小红书发送手机号或微信号时，将自动汇总至此。</td></tr>';
        return;
      }
      tbody.innerHTML = data.items.map(lead => `
        <tr>
          <td style="font-weight:600;">${escapeHtml(lead.user_name || '小红书用户')}</td>
          <td><span class="status-pill ${lead.lead_type === '手机号' ? 'online' : 'warning'}">${escapeHtml(lead.lead_type)}</span></td>
          <td style="font-family:monospace;font-weight:700;">${escapeHtml(lead.lead_value)}</td>
          <td style="color:var(--text-muted);font-size:12px;">${escapeHtml(lead.context_summary || '私信留资')}</td>
          <td style="color:var(--text-muted);font-size:12px;">${lead.created_at ? new Date(lead.created_at).toLocaleString('zh-CN') : '-'}</td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:16px;">加载失败: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  $('btnRefreshLeads').addEventListener('click', loadLeads);

  // 评论雷达
  $('btnLoadComments').addEventListener('click', async () => {
    const status = $('commentsStatus');
    const list = $('commentsList');
    const query = $('commentQuery').value.trim();
    if (!query) { status.textContent = '请先输入笔记链接、ID 或关键词'; return; }
    status.textContent = '正在拉取评论（含搜索解析，约 10~30 秒）...';
    list.innerHTML = '';
   try {
      const res = await bridgeFetch(`${SERVICE_URL}/comments/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.workspaceToken || ''}` },
        body: JSON.stringify({ note: query })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const comments = data.comments || [];
      if (!comments.length) { status.textContent = '这条笔记暂时没有评论'; return; }
      status.textContent = `共 ${comments.length} 条评论${data.has_more ? '（还有更多未拉取）' : ''}`;
      comments.forEach((c) => list.appendChild(renderCommentRow(c)));
    } catch (error) {
      status.textContent = `❌ ${error.message}`;
    }
  });

  function renderCommentRow(c) {
    const row = document.createElement('div');
    row.style.cssText = 'border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;font-size:13px;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:4px;';
    const author = document.createElement('b');
    author.textContent = c.author || '匿名';
    const meta = document.createElement('span');
    meta.style.cssText = 'color:#94a3b8;font-size:11px;';
    meta.textContent = [c.location, c.likes ? `赞 ${c.likes}` : '', c.sub_count ? `回复 ${c.sub_count}` : ''].filter(Boolean).join(' · ');
    const draftBtn = document.createElement('button');
    draftBtn.className = 'btn btn-secondary btn-sm';
    draftBtn.textContent = '✨ AI 草稿';
    draftBtn.style.marginLeft = 'auto';
    head.append(author, meta, draftBtn);
    const body = document.createElement('div');
    body.style.cssText = 'white-space:pre-wrap;color:#334155;margin-bottom:6px;';
    body.textContent = c.content || '（无文字内容）';
    const draftBox = document.createElement('div');
    draftBox.style.display = 'none';
    draftBox.style.cssText += 'background:#f8fafc;border-radius:8px;padding:8px 10px;margin-top:6px;';
    const draftText = document.createElement('div');
    draftText.style.cssText = 'white-space:pre-wrap;color:#0f172a;';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-primary btn-sm';
    copyBtn.textContent = '📋 复制草稿';
    copyBtn.style.marginTop = '6px';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(draftText.textContent || '').then(() => {
        copyBtn.textContent = '✓ 已复制，去小红书回复';
        setTimeout(() => { copyBtn.textContent = '📋 复制草稿'; }, 2000);
      });
    });
    draftBox.append(draftText, copyBtn);
    draftBtn.addEventListener('click', async () => {
      if (!config.workspaceToken) { draftText.textContent = '❌ 请先保存一次全局配置'; draftBox.style.display = 'block'; return; }
      draftBtn.disabled = true;
      draftBtn.textContent = '生成中…';
      draftBox.style.display = 'block';
     try {
        const res = await bridgeFetch(`${SERVICE_URL}/reply`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.workspaceToken}`,
            'X-Model-Key': $('modelApiKey')?.value.trim() || config.modelApiKey || '',
            'X-Model-Base-Url': $('modelBaseUrl')?.value.trim() || config.modelBaseUrl || 'http://127.0.0.1:10100/v1/chat/completions',
            'X-Model-Name': $('modelName')?.value.trim() || config.modelName || 'google-antigravity/gemini-3.7-flash'
          },
          body: JSON.stringify({
            session_id: `comment:${c.id || Date.now()}`,
            user_name: c.author || '',
            action: 'comment_reply',
            latest_msg: c.content || ''
          })
        });
        const data = await res.json();
        if (!data.ok || !data.reply) throw new Error(data.error || `HTTP ${res.status}`);
        draftText.textContent = data.reply;
        copyBtn.style.display = 'inline-block';
      } catch (error) {
        draftText.textContent = `❌ 生成失败：${error.message}`;
      }
      draftBtn.disabled = false;
      draftBtn.textContent = '✨ 重新生成';
    });
    row.append(head, body, draftBox);
    return row;
  }


  // 今日经营战报
  async function loadTodayReport() {
    if (!config.workspaceToken) return;
    try {
      const res = await bridgeFetch(`${SERVICE_URL}/report/today`, {
        headers: { 'Authorization': `Bearer ${config.workspaceToken}` }
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      $('statReplies').textContent = data.replies;
      $('statLeads').textContent = data.leads;
      $('statLatency').textContent = data.avg_latency_ms >= 1000 ? `${(data.avg_latency_ms / 1000).toFixed(1)}s` : `${data.avg_latency_ms}ms`;
      $('statIntents').textContent = (data.top_intents || []).map(i => `${i.intent}×${i.count}`).join('、') || '今天还没有咨询';
      if (!$('alertWebhook').value) $('webhookStatus').textContent = data.webhook_configured ? '✅ 已配置警报推送' : '';
    } catch (error) {
      $('statIntents').textContent = `战报加载失败：${error.message}`;
    }
  }
  $('btnRefreshReport').addEventListener('click', loadTodayReport);

  // 线索流失警报 Webhook
  $('btnSaveWebhook').addEventListener('click', async () => {
    const status = $('webhookStatus');
    if (!config.workspaceToken) { status.textContent = '❌ 请先保存一次全局配置'; status.style.color = '#ef4444'; return; }
    status.style.color = '#64748b';
    status.textContent = '正在保存...';
    try {
      const res = await bridgeFetch(`${SERVICE_URL}/tenant/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.workspaceToken}` },
        body: JSON.stringify({ url: $('alertWebhook').value.trim() })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      status.style.color = '#16a34a';
      status.textContent = '✅ 已保存，新线索会立刻推送到群机器人';
    } catch (error) {
      status.style.color = '#ef4444';
      status.textContent = `❌ ${error.message}`;
    }
  });

  $('btnExportLeads').addEventListener('click', async () => {
    const button = $('btnExportLeads');
    button.disabled = true;
   try {
      const res = await bridgeFetch(`${SERVICE_URL}/leads/export.csv`, {
        headers: { 'Authorization': `Bearer ${config.workspaceToken || ''}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const csvText = await res.text();
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'leads_export.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('导出失败：' + e.message);
    } finally {
      button.disabled = false;
    }
  });

  const FOLLOWUP_LABELS = {
    needs_reply: '🔴 待客服回复',
    card_sent: '已发名片',
    card_clicked_unconfirmed: '名片已点击，添加未确认',
    lead_captured: '📋 客户已留资',
    waiting_reply: '🟡 等待客户中',
    followup_due: '⏰ 到期需跟进',
    done: '✅ 已完成 / 已加微',
    vendor: '📢 平台推销（已免除跟进）',
    invalid: '🚫 账号异常（已归档）'
  };

  async function loadFollowupQueue() {
    const list = $('followupList');
    const summary = $('followupSummary');
    const saved = await storageGet(['followupStateMap']);
    const now = Date.now();
    const items = Object.values(saved.followupStateMap || {}).filter(item => item && item.sessionId);
    items.forEach(item => {
      if (item.category === 'vendor' || item.category === 'invalid') {
        item.displayStage = item.category;
      } else if (item.nextFollowupAt && item.nextFollowupAt <= now && Number(item.followupCount || 0) < 2
          && !['needs_reply', 'lead_captured', 'done', 'vendor', 'invalid'].includes(item.stage)) {
        item.displayStage = 'followup_due';
      } else {
        item.displayStage = item.stage || 'waiting_reply';
      }
    });
    items.sort((a, b) => {
      const aDue = a.displayStage === 'followup_due' || a.displayStage === 'needs_reply' ? 0 : 1;
      const bDue = b.displayStage === 'followup_due' || b.displayStage === 'needs_reply' ? 0 : 1;
      return aDue - bDue || Number(a.nextFollowupAt || Infinity) - Number(b.nextFollowupAt || Infinity);
    });
    const dueCount = items.filter(item => ['followup_due', 'needs_reply'].includes(item.displayStage)).length;
    const prospectCount = items.filter(item => item.category === 'prospect' || item.category === 'lead' || item.category === 'wecom').length;
    summary.textContent = items.length
      ? `共记录 ${items.length} 位联系人（${prospectCount} 位高意向/客资客户），当前 ${dueCount} 位需要跟进处理`
      : '打开小红书客服台后，系统会自动提取联系人对话与意图标签。';
    list.replaceChildren();
    items.slice(0, 100).forEach(item => {
      const row = document.createElement('div');
      row.className = 'followup-item';
      const main = document.createElement('div');
      main.className = 'followup-main';
      const header = document.createElement('div');
      header.className = 'followup-header';
      const name = document.createElement('div');
      name.className = 'followup-name';
      name.textContent = item.userName || '未命名客户';

      const catTag = document.createElement('span');
      catTag.className = `followup-category-tag tag-${item.category || 'general'}`;
      catTag.textContent = item.categoryLabel || '💬 咨询';
      header.append(name, catTag);

      const snippet = document.createElement('div');
      snippet.className = 'followup-snippet';
      snippet.textContent = item.snippet || '暂无对话摘要';
      snippet.title = item.snippet || '';

      const meta = document.createElement('div');
      meta.className = 'followup-meta';
      if (item.displayStage === 'vendor') {
        meta.textContent = '小红书官方推销顾问（已自动免除跟进）';
      } else if (item.displayStage === 'invalid') {
        meta.textContent = '异常账号（已自动归档）';
      } else if (item.displayStage === 'done') {
        meta.textContent = '已标记加微 / 结束跟进';
      } else if (item.displayStage === 'needs_reply') {
        meta.textContent = `最新消息：${item.timeText || '刚刚'} · 客户等待回复中`;
      } else if (item.nextFollowupAt) {
        meta.textContent = `上次互动：${item.timeText || '今天'} · 下次跟进：${new Date(item.nextFollowupAt).toLocaleString('zh-CN', { hour12: false })}`;
      } else {
        meta.textContent = `上次互动：${item.timeText || '今天'} · 等待客户回复中`;
      }
      main.append(header, snippet, meta);

      const actions = document.createElement('div');
      actions.className = 'followup-actions';
      const tag = document.createElement('span');
      tag.className = `followup-tag ${item.displayStage === 'followup_due' ? 'due' : ''}`;
      tag.textContent = FOLLOWUP_LABELS[item.displayStage] || '待判断';
      actions.append(tag);

      if (item.displayStage !== 'vendor' && item.displayStage !== 'invalid' && item.displayStage !== 'done') {
        const markBtn = document.createElement('button');
        markBtn.className = 'btn btn-secondary btn-sm';
        markBtn.textContent = '标记已加微';
        markBtn.title = '人工确认已加上企微，移出待办队列';
        markBtn.addEventListener('click', async () => {
          const savedMap = (await storageGet(['followupStateMap'])).followupStateMap || {};
          if (savedMap[item.sessionId]) {
            savedMap[item.sessionId].stage = 'done';
            savedMap[item.sessionId].nextFollowupAt = 0;
            await storageSet({ followupStateMap: savedMap });
            loadFollowupQueue();
          }
        });
        actions.append(markBtn);
      }
      row.append(main, actions);
      list.append(row);
    });
  }

  async function collectHistorySamples() {
    const tabs = await chrome.tabs.query({});
    let lastError = '';
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'COLLECT_HISTORY_SAMPLES', maxSessions: 12, maxTurns: 30
        });
        if (result?.ok && Array.isArray(result.sessions) && result.sessions.length) return result.sessions;
        if (result && !result.ok && result.error) {
          lastError = result.error;
        }
      } catch (_) {
        // 未注入 content script 的标签页跳过
      }
    }
    throw new Error(lastError || '未连接到小红书客服台。请先刷新已打开的小红书私信页面，并选中一个有聊天记录的会话');
  }

  async function learnFromHistory() {
    const button = $('btnLearnHistory');
    const status = $('learnHistoryStatus');
    button.disabled = true;
    status.className = 'learn-state';
    status.textContent = '正在读取真实会话并提炼你的回复方式…';
    try {
      const sessions = await collectHistorySamples();
      let token = $('workspaceToken').value.trim() || config.workspaceToken || '';
      const workspaceName = $('workspaceName').value.trim() || '我的工作区';
      if (!token) {
        token = await registerWorkspace(workspaceName);
        $('workspaceToken').value = token;
        await storageSet({ workspaceToken: token, workspaceName });
      }
      const response = await bridgeFetch(`${SERVICE_URL}/tenant/learn-history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Model-Base-Url': $('modelBaseUrl').value.trim(),
          'X-Model-Name': $('modelName').value.trim(),
          'X-Model-Key': $('modelApiKey').value.trim()
        },
        body: JSON.stringify({ sessions })
      });
      const data = await readJson(response);
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      $('businessProfile').value = data.config?.business_profile || '';
      $('replyPreferences').value = data.config?.reply_preferences || '';
      const learnedAt = Date.now();
      const patch = {
        workspaceToken: token,
        businessProfile: $('businessProfile').value,
        replyPreferences: $('replyPreferences').value,
        historyLearnedAt: learnedAt,
        learnedSummary: data.summary || '已学习历史回复',
        configVersion: learnedAt
      };
      await storageSet(patch);
      config = { ...config, ...patch };
      status.className = 'learn-state success';
      status.textContent = `${patch.learnedSummary} · 已自动写入，可继续在下方补充修改`;
      const tabs = await chrome.tabs.query({});
      tabs.forEach(tab => tab.id && chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATED', config: patch }).catch(() => {}));
    } catch (error) {
      status.className = 'learn-state error';
      status.textContent = `学习失败：${error.message}`;
    } finally {
      button.disabled = false;
      button.textContent = config.historyLearnedAt ? '重新学习' : '从历史对话学习';
    }
  }

  $('btnLearnHistory').addEventListener('click', learnFromHistory);
  $('btnRefreshFollowups').addEventListener('click', loadFollowupQueue);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.followupStateMap) loadFollowupQueue();
  });

  // --- Feedback History ---
  async function loadFeedback() {
    const box = $('feedbackListContainer');
    box.innerHTML = '正在加载实战反馈案例...';
    try {
     const scope = encodeURIComponent(config.knowledgeScope || 'default');
      const res = await bridgeFetch(`${SERVICE_URL}/feedback/list?scope=${scope}&limit=20`, {
        headers: { 'Authorization': `Bearer ${config.workspaceToken || ''}` }
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.items || !data.items.length) {
        box.innerHTML = '暂无已沉淀的人工案例。在小红书客服工作台中修改草稿并点击「记住当前人工话术」，即会自动沉淀至此。';
        return;
      }
      box.innerHTML = data.items.map(item => `
        <div style="background:#ffffff;border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">客户：${escapeHtml(item.latest_msg)}</div>
          <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px;">采用回复：${escapeHtml(item.human_reply)}</div>
          <div style="font-size:12px;color:var(--primary);">策略理由：${escapeHtml(item.reason || 'AI 自动总结优质表达')}</div>
        </div>
      `).join('');
    } catch (e) {
      box.innerHTML = `<span style="color:#ef4444;">加载失败: ${escapeHtml(e.message)}</span>`;
    }
  }

  $('btnRefreshFeedback').addEventListener('click', loadFeedback);
  $('btnReloadExtension').addEventListener('click', () => chrome.runtime.reload());
  window.addEventListener('focus', checkBridgeHealth);

  populate();
  checkBridgeHealth();
  loadOpenCodexModels();
  syncFromServer();

  async function syncFromServer() {
    let token = config.workspaceToken || '';
    if (!token) {
      try {
        token = await registerWorkspace(config.workspaceName || '我的工作区');
        config.workspaceToken = token;
        $('workspaceToken').value = token;
        await storageSet({ workspaceToken: token });
      } catch (_) {}
    }
    if (!token) return;
    try {
      const res = await bridgeFetch(SERVICE_URL + '/tenant/config', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const data = await readJson(res);
      if (data.ok && data.config) {
        const s = data.config;
        if (s.business_profile) {
          $('businessProfile').value = s.business_profile;
          config.businessProfile = s.business_profile;
        }
        if (s.reply_preferences) {
          $('replyPreferences').value = s.reply_preferences;
          config.replyPreferences = s.reply_preferences;
        }
        if (s.brand_name) {
          $('brandName').value = s.brand_name;
          config.brandName = s.brand_name;
        }
        await storageSet({
          businessProfile: $('businessProfile').value,
          replyPreferences: $('replyPreferences').value,
          brandName: $('brandName').value
        });
      }
    } catch (_) {}
    loadTodayReport();
  }
});
