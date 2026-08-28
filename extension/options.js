document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const SERVICE_URL = 'http://127.0.0.1:18195';

  const PROVIDERS = {
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

  const keys = [
    'onboardingComplete', 'enabled', 'runMode', 'timeScope', 'fullAutoArmedAt',
    'maxRepliesPerHour', 'repliedCount', 'leadsCount', 'bridgeUrl', 'workspaceToken',
    'workspaceName', 'modelBaseUrl', 'modelName', 'modelApiKey', 'embeddingBaseUrl',
    'embeddingModel', 'embeddingApiKey', 'feishuAppId', 'feishuAppSecret', 'accountId',
    'knowledgeScope', 'brandName', 'businessProfile', 'replyPreferences', 'toneProfile'
  ];

  let config = await storageGet(keys);

  // Tab Navigation
  const navItems = document.querySelectorAll('.nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const pageTitles = {
    models: '🤖 大模型服务商与 API 引擎配置',
    business: '🏢 店铺画像与语气调性',
    knowledge: '📚 专业业务知识库 Studio',
    faq: '💬 结构化标准问答库 (FAQ)',
    crm: '👥 捕获客资与线索中心',
    runtime: '⚡ 智能值守运行监控与安全'
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.dataset.tab;
      navItems.forEach(n => n.classList.toggle('active', n === item));
      tabPanes.forEach(p => p.classList.toggle('active', p.id === `tab-${target}`));
      $('pageHeaderTitle').textContent = pageTitles[target] || '企业控制台';
      if (target === 'knowledge') loadDocuments();
      if (target === 'faq') loadFaqs();
      if (target === 'crm') loadLeads();
      if (target === 'runtime') loadFeedback();
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
    if (!config.modelBaseUrl) matchedProvider = 'deepseek';
    $('modelProvider').value = matchedProvider;

    $('modelBaseUrl').value = config.modelBaseUrl || PROVIDERS.deepseek.url;
    $('modelName').value = config.modelName || PROVIDERS.deepseek.model;
    $('modelApiKey').value = config.modelApiKey || '';
    $('embeddingBaseUrl').value = config.embeddingBaseUrl || '';
    $('embeddingModel').value = config.embeddingModel || '';
    $('embeddingApiKey').value = config.embeddingApiKey || '';

    $('workspaceName').value = config.workspaceName || '';
    $('accountId').value = config.accountId || '';
    $('businessLine').value = config.knowledgeScope || 'default';
    $('brandName').value = config.brandName || '';
    $('toneProfile').value = config.toneProfile || 'warm_consultant';
    $('businessProfile').value = config.businessProfile || '';
    $('replyPreferences').value = config.replyPreferences || '';

    $('feishuAppId').value = config.feishuAppId || '';
    $('feishuAppSecret').value = config.feishuAppSecret || '';

    $('masterToggle').value = String(config.enabled !== false);
    $('runMode').value = config.runMode || 'copilot';
    $('timeScope').value = config.timeScope || 'all_day';
    $('maxRepliesPerHour').value = config.maxRepliesPerHour || 12;
  }

  // Model Provider Switch
  $('modelProvider').addEventListener('change', e => {
    const p = PROVIDERS[e.target.value];
    if (p && e.target.value !== 'custom') {
      $('modelBaseUrl').value = p.url;
      $('modelName').value = p.model;
      $('embeddingBaseUrl').value = p.embeddingUrl;
      $('embeddingModel').value = p.embeddingModel;
    }
  });

  // Save All Configuration
  async function saveAll() {
    $('btnSaveAll').disabled = true;
    $('btnSaveAll').textContent = '正在保存...';

    try {
      const modelUrl = $('modelBaseUrl').value.trim();
      const modelName = $('modelName').value.trim();
      const modelKey = $('modelApiKey').value.trim();
      if (!modelKey) throw new Error('请先填写大模型 API Key，并通过连通性测试');
      if (!modelUrl || !/^https:\/\//i.test(modelUrl)) throw new Error('模型 API 地址必须是有效的 HTTPS 地址');
      if (!modelName) throw new Error('请填写模型名称');

      let token = config.workspaceToken || '';
      const wsName = $('workspaceName').value.trim() || 'My_Workspace';

      // 1. Ensure Tenant Registered
      if (!token) {
        const res = await fetch(`${SERVICE_URL}/tenant/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_name: wsName })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '工作区注册失败');
        token = data.access_token;
      }

      // 2. Save Business Config to Cloud
      const businessPayload = {
        workspace_name: wsName,
        account_id: $('accountId').value.trim(),
        business_line: $('businessLine').value.trim() || 'default',
        brand_name: $('brandName').value.trim(),
        business_profile: $('businessProfile').value.trim(),
        reply_preferences: $('replyPreferences').value.trim()
      };

      await fetch(`${SERVICE_URL}/tenant/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(businessPayload)
      });

      // 3. Save Local Config
      const newConfig = {
        onboardingComplete: true,
        enabled: $('masterToggle').value === 'true',
        runMode: $('runMode').value,
        timeScope: $('timeScope').value,
        maxRepliesPerHour: Number($('maxRepliesPerHour').value) || 12,
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

      $('btnSaveAll').textContent = '✅ 配置已保存';
      setTimeout(() => { $('btnSaveAll').textContent = '💾 保存全局配置'; $('btnSaveAll').disabled = false; }, 1500);
    } catch (err) {
      alert('保存失败：' + err.message);
      $('btnSaveAll').textContent = '💾 保存全局配置';
      $('btnSaveAll').disabled = false;
    }
  }

  $('btnSaveAll').addEventListener('click', saveAll);

  // Test Model Connection
  $('btnTestModel').addEventListener('click', async () => {
    const resBox = $('modelTestResult');
    resBox.style.display = 'block';
    resBox.style.color = '#64748b';
    resBox.textContent = '正在发起测试请求...';

    const url = $('modelBaseUrl').value.trim();
    const key = $('modelApiKey').value.trim();
    const model = $('modelName').value.trim();

    if (!key) {
      resBox.style.color = '#ef4444';
      resBox.textContent = '❌ 请先填写 API Key';
      return;
    }

    const start = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 5
        })
      });

      const latency = Date.now() - start;
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.slice(0, 100)}`);
      }

      resBox.style.color = '#10b981';
      resBox.textContent = `✅ 连通性测试通过！响应耗时: ${latency}ms · 模型 [${model}] 已就绪`;
    } catch (e) {
      resBox.style.color = '#ef4444';
      resBox.textContent = `❌ 连接失败: ${e.message}`;
    }
  });

  // Load Documents
  async function loadDocuments() {
    const tbody = $('documentTableBody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:16px;">正在读取知识库文档...</td></tr>';

    try {
      const res = await fetch(`${SERVICE_URL}/knowledge/documents`, {
        headers: { 'Authorization': `Bearer ${config.workspaceToken || ''}` }
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '获取失败');

      if (!data.items || data.items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">暂无已上传的业务资料，拖拽文件即可添加</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      data.items.forEach(doc => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight:600;">${doc.title}</td>
          <td><span class="status-pill">${(doc.source_type || 'file').toUpperCase()}</span></td>
          <td>${doc.chunk_count} 段</td>
          <td><span class="status-pill ${doc.status === 'ready' ? 'online' : 'warning'}">${doc.status === 'ready' ? '向量+关键词' : '关键词索引'}</span></td>
          <td>
            <button class="btn btn-secondary btn-sm btn-toggle-doc" data-id="${doc.id}" data-enabled="${doc.enabled}">
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

          await fetch(`${SERVICE_URL}/knowledge/status`, {
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
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:16px;">读取失败: ${e.message}</td></tr>`;
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
      if (file.size > 12 * 1024 * 1024) {
        alert(`${file.name} 超过 12MB 上限`);
        continue;
      }
      status.textContent = `正在上传并解析 ${file.name}...`;
      const base64 = await new Promise(res => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(',')[1]);
        r.readAsDataURL(file);
      });

      try {
        const res = await fetch(`${SERVICE_URL}/knowledge/upload`, {
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
      const res = await fetch(`${SERVICE_URL}/knowledge/feishu`, {
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

    try {
      const res = await fetch(`${SERVICE_URL}/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.workspaceToken || ''}`,
          'X-Model-Base-Url': $('modelBaseUrl').value.trim(),
          'X-Model-Key': $('modelApiKey').value.trim(),
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
        <div style="background:#ffffff;padding:10px;border-radius:6px;border:1px solid #e2e8f0;margin-bottom:12px;">${data.reply || '无回复'}</div>
        <div style="font-weight:700;margin-bottom:6px;color:#0f172a;">🔍 命中的知识片段 (${sources.length} 条)：</div>
        ${sources.length ? sources.map((s, idx) => `
          <div style="background:#ffffff;padding:8px 10px;border-radius:6px;border:1px solid #e2e8f0;margin-bottom:6px;font-size:12px;">
            <strong>[${idx + 1}] ${s.heading || '知识点'}</strong>: ${s.content}
          </div>
        `).join('') : '<div style="color:#94a3b8;font-size:12px;">未命中特定文档，将直接基于业务画像与通用常识作答（安全兜底）</div>'}
      `;
    } catch (e) {
      resultBox.innerHTML = `<span style="color:#ef4444;">检索失败: ${e.message}</span>`;
    }
  });

  // --- FAQ Management ---
  async function loadFaqs() {
    const tbody = $('faqTableBody');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;">正在加载标准问答...</td></tr>';
    try {
      const res = await fetch(`${SERVICE_URL}/knowledge/faq/list`, {
        headers: { 'Authorization': `Bearer ${config.workspaceToken || ''}` }
      });
      const data = await res.json();
      if (!data.items || !data.items.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:24px;">暂无已配置的标准问答对，在上方添加即可生效</td></tr>';
        return;
      }
      tbody.innerHTML = data.items.map(faq => `
        <tr>
          <td style="font-weight:600;">${faq.question}</td>
          <td>${faq.answer}</td>
          <td><span class="status-pill">${faq.keywords || '智能匹配'}</span></td>
          <td>
            <button class="btn btn-secondary btn-sm btn-delete-faq" data-id="${faq.id}">删除</button>
          </td>
        </tr>
      `).join('');

      document.querySelectorAll('.btn-delete-faq').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('确定删除此问答对？')) return;
          await fetch(`${SERVICE_URL}/knowledge/faq/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.workspaceToken || ''}` },
            body: JSON.stringify({ id: btn.dataset.id })
          });
          loadFaqs();
        });
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#ef4444;padding:16px;">加载失败: ${e.message}</td></tr>`;
    }
  }

  $('btnAddFaq').addEventListener('click', async () => {
    const q = $('faqQuestion').value.trim();
    const a = $('faqAnswer').value.trim();
    const kw = $('faqKeywords').value.trim();
    if (!q || !a) return alert('请填写问题与标准回答要点');

    try {
      const res = await fetch(`${SERVICE_URL}/knowledge/faq/add`, {
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
      const res = await fetch(`${SERVICE_URL}/leads/list`, {
        headers: { 'Authorization': `Bearer ${config.workspaceToken || ''}` }
      });
      const data = await res.json();
      if (!data.items || !data.items.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">暂无捕获客资。当客户在小红书发送手机号或微信号时，将自动汇总至此。</td></tr>';
        return;
      }
      tbody.innerHTML = data.items.map(lead => `
        <tr>
          <td style="font-weight:600;">${lead.user_name || '小红书用户'}</td>
          <td><span class="status-pill ${lead.lead_type === '手机号' ? 'online' : 'warning'}">${lead.lead_type}</span></td>
          <td style="font-family:monospace;font-weight:700;">${lead.lead_value}</td>
          <td style="color:var(--text-muted);font-size:12px;">${lead.context_summary || '私信留资'}</td>
          <td style="color:var(--text-muted);font-size:12px;">${lead.created_at ? new Date(lead.created_at).toLocaleString('zh-CN') : '-'}</td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:16px;">加载失败: ${e.message}</td></tr>`;
    }
  }

  $('btnRefreshLeads').addEventListener('click', loadLeads);
  $('btnExportLeads').addEventListener('click', async () => {
    const button = $('btnExportLeads');
    button.disabled = true;
    try {
      const res = await fetch(`${SERVICE_URL}/leads/export.csv`, {
        headers: { 'Authorization': `Bearer ${config.workspaceToken || ''}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
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

  // --- Feedback History ---
  async function loadFeedback() {
    const box = $('feedbackListContainer');
    box.innerHTML = '正在加载实战反馈案例...';
    try {
      const scope = encodeURIComponent(config.knowledgeScope || 'default');
      const res = await fetch(`${SERVICE_URL}/feedback/list?scope=${scope}&limit=20`, {
        headers: { 'Authorization': `Bearer ${config.workspaceToken || ''}` }
      });
      const data = await res.json();
      if (!data.items || !data.items.length) {
        box.innerHTML = '暂无已沉淀的人工案例。在小红书客服工作台中修改草稿并点击「记住当前人工话术」，即会自动沉淀至此。';
        return;
      }
      box.innerHTML = data.items.map(item => `
        <div style="background:#ffffff;border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">客户：${item.latest_msg}</div>
          <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px;">采用回复：${item.human_reply}</div>
          <div style="font-size:12px;color:var(--primary);">策略理由：${item.reason || 'AI 自动总结优质表达'}</div>
        </div>
      `).join('');
    } catch (e) {
      box.innerHTML = `<span style="color:#ef4444;">加载失败: ${e.message}</span>`;
    }
  }

  $('btnRefreshFeedback').addEventListener('click', loadFeedback);
  $('btnReloadExtension').addEventListener('click', () => chrome.runtime.reload());

  populate();
});
