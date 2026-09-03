/**
 * 客资雷达 · 私信获客工作台 (LeadOps Copilot)
 * 浮动控制台 UI 驱动模块 (XhsDock)
 */
(function () {
  'use strict';

  let handlers = {};
  let rootElement = null;

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function init(userHandlers) {
    handlers = userHandlers || {};
    render();
  }

  function render() {
    document.getElementById('xhs-reply-dock-root')?.remove();

    const root = document.createElement('div');
    root.id = 'xhs-reply-dock-root';
    rootElement = root;

    const html = [
      '<div class="xhs-dock-pill" id="xhsPillTrigger" title="点击展开获客工作台">',
      '  <div class="xhs-dock-status-dot" id="xhsPulseDot"></div>',
      '  <span class="xhs-pill-brand">⚡ 获客副驾</span>',
      '  <span class="xhs-pill-status" id="xhsPillModeText">就绪</span>',
      '</div>',
      '<div class="xhs-dock-panel" id="xhsExpandedPanel">',
      '  <div class="xhs-dock-header">',
      '    <div class="xhs-header-brand">',
      '      <span class="xhs-header-icon">⚡</span>',
      '      <div class="xhs-header-titles">',
      '        <div class="xhs-dock-title">客资雷达 <span class="badge">V1.1</span></div>',
      '        <div class="xhs-dock-subtitle">私信获客与销售承接系统</div>',
      '      </div>',
      '    </div>',
      '    <div class="xhs-dock-header-actions">',
      '      <button class="xhs-dock-btn-icon" id="xhsClosePanelBtn" title="收起面板" aria-label="关闭">✕</button>',
      '    </div>',
      '  </div>',
      '  <div class="xhs-dock-tabs">',
      '    <div class="xhs-dock-tab active" data-tab="desk">',
      '      <span class="tab-icon">💬</span>',
      '      <span>实时接待</span>',
      '    </div>',
      '    <div class="xhs-dock-tab" data-tab="strategy">',
      '      <span class="tab-icon">⚙️</span>',
      '      <span>策略风控</span>',
      '    </div>',
      '    <div class="xhs-dock-tab" data-tab="knowledge">',
      '      <span class="tab-icon">📚</span>',
      '      <span>语料库</span>',
      '    </div>',
      '  </div>',
      '  <div class="xhs-dock-body" id="xhsTabDesk">',
      '    <button class="xhs-btn xhs-btn-primary" id="xhsBtnGenNow">',
      '      <span class="btn-shine"></span>',
      '      <span class="btn-content">✨ 为当前客户生成专属回复</span>',
      '    </button>',
      '    <div class="xhs-action-grid">',
      '      <button class="xhs-action-btn" id="xhsBtnSendWecomCard" title="一键向当前客户发送企业微信联系名片">',
      '        <span class="action-icon">📇</span>',
      '        <span class="action-text">推企微名片</span>',
      '      </button>',
      '      <button class="xhs-action-btn" id="xhsBtnSendLeadCard" title="一键向当前客户发送官方留资表单卡">',
      '        <span class="action-icon">📋</span>',
      '        <span class="action-text">发送留资卡</span>',
      '      </button>',
      '      <button class="xhs-action-btn" id="xhsBtnLearnNow" title="扫描近期已聊会话，自动提炼企业专属语气与业务知识">',
      '        <span class="action-icon">🧠</span>',
      '        <span class="action-text">提炼好话术</span>',
      '      </button>',
      '    </div>',
      '    <div class="xhs-mode-banner" id="xhsAutoArmHint">副驾只预填草稿，不会自动发送</div>',
      '    <div class="xhs-token-meter">',
      '      <div class="token-meter-header">',
      '        <span class="meter-title">',
      '          <span class="meter-shield">🛡️</span>',
      '          <span>Token 算力保护</span>',
      '        </span>',
      '        <span class="meter-stats" id="xhsTokenUsageText">0 / 200k (0%)</span>',
      '      </div>',
      '      <div class="meter-bar-track">',
      '        <div class="meter-bar-fill" id="xhsTokenProgressBar"></div>',
      '      </div>',
      '      <div class="meter-footer">',
      '        <span class="meter-calls" id="xhsCallCountText">今日调用: 0 次</span>',
      '        <div class="meter-controls">',
      '          <span class="meter-badge running" id="xhsTokenStatusBadge">运行中</span>',
      '          <button type="button" class="btn-meter-reset" id="xhsBtnResetTokens" title="清空今日累计与重置熔断状态">重置</button>',
      '        </div>',
      '      </div>',
      '    </div>',
      '    <div class="xhs-feedback-card" id="xhsFeedbackCard" hidden>',
      '      <div class="xhs-feedback-title">',
      '        <span class="title-left">🎯 话术反哺沉淀</span>',
      '        <span class="xhs-feedback-kb">持续学习中</span>',
      '      </div>',
      '      <div class="xhs-feedback-hint" id="xhsFeedbackHint">修改输入框中的话术后，将更好的版本反哺给机器人。</div>',
      '      <textarea class="xhs-textarea" id="xhsFeedbackReason" placeholder="为什么这样回更好？（选填，AI 会自动提炼业务规则）"></textarea>',
      '      <button type="button" class="xhs-btn xhs-btn-secondary" style="width:100%;margin-top:6px;" id="xhsBtnSaveFeedback">',
      '        💾 将此优质话术沉淀进知识库',
      '      </button>',
      '      <div class="xhs-feedback-status" id="xhsFeedbackStatus"></div>',
      '    </div>',
      '    <div class="xhs-feed-header">',
      '      <span class="feed-title">实时接待动态</span>',
      '      <span class="customer-tag" id="xhsActiveCustomerName">当前会话：识别中</span>',
      '    </div>',
      '    <div class="xhs-log-list" id="xhsLogContainer">',
      '      <div class="log-empty-state">等待会话接入中…</div>',
      '    </div>',
      '  </div>',
      '  <div class="xhs-dock-body" id="xhsTabStrategy" style="display:none;">',
      '    <div class="xhs-setting-item">',
      '      <div class="setting-info">',
      '        <div class="setting-name">接待总开关</div>',
      '        <div class="setting-desc">关闭后插件保持完全静默，不读取也不生成</div>',
      '      </div>',
      '      <label class="xhs-toggle-switch">',
      '        <input type="checkbox" id="xhsDockMasterToggle">',
      '        <span class="xhs-toggle-slider"></span>',
      '      </label>',
      '    </div>',
      '    <div class="xhs-field-group">',
      '      <label class="xhs-field-label">工作模式</label>',
      '      <select class="xhs-input-text" id="xhsDockRunMode">',
      '        <option value="copilot">半自动副驾（智能起草，人工确认发送）</option>',
      '        <option value="full_auto">全自动值守（严格风控下自动发送）</option>',
      '      </select>',
      '    </div>',
      '    <div class="xhs-field-group">',
      '      <label class="xhs-field-label">生效时段策略</label>',
      '      <select class="xhs-input-text" id="xhsDockTimeScope">',
      '        <option value="all_day">全天开启服务</option>',
      '        <option value="night_only">仅夜间错峰值守 (22:00 – 09:00)</option>',
      '      </select>',
      '    </div>',
      '    <button class="xhs-btn xhs-btn-primary" style="width:100%;margin:6px 0 10px 0;" id="xhsBeginAwayMode" hidden>',
      '      开始无人值守',
      '    </button>',
      '    <div class="xhs-field-group">',
      '      <label class="xhs-field-label">运行健康度监控</label>',
      '      <div class="xhs-monitor-summary" id="xhsMonitorSummary">正在同步数据…</div>',
      '    </div>',
      '    <div class="xhs-guard-note">',
      '      🛡️ <strong>企业级安全防护</strong>：同一客户 45 秒内禁止高频重复请求；同一消息 30 分钟内绝不重复发；单日 Token 消耗达到设定上限时自动熔断。',
      '    </div>',
      '  </div>',
      '  <div class="xhs-dock-body" id="xhsTabKnowledge" style="display:none;">',
      '    <label class="xhs-knowledge-drop" id="xhsKnowledgeDrop">',
      '      <div class="drop-icon">📄</div>',
      '      <div class="drop-text">拖入或选择产品手册 / 价格单 / 问答文档</div>',
      '      <div class="drop-sub">支持 PDF、Word (.docx)、PPT、TXT、Markdown</div>',
      '      <input id="xhsKnowledgeFiles" type="file" accept=".pdf,.docx,.pptx,.txt,.md,.csv" multiple hidden>',
      '    </label>',
      '    <div class="xhs-feishu-row">',
      '      <input class="xhs-input-text" id="xhsFeishuUrl" placeholder="粘贴飞书云文档 / 知识库 Wiki 链接">',
      '      <button class="xhs-btn xhs-btn-secondary" id="xhsBtnImportFeishu">一键导入</button>',
      '    </div>',
      '    <div class="xhs-knowledge-ingest-status" id="xhsKnowledgeIngestStatus">资料已就绪，AI 会自动按意图精准召回</div>',
      '    <div class="xhs-knowledge-toolbar">',
      '      <span class="toolbar-title">企业已生效资料</span>',
      '      <button class="xhs-btn xhs-btn-icon-text" id="xhsBtnRefreshKnowledge">🔄 刷新</button>',
      '    </div>',
      '    <div class="xhs-knowledge-list" id="xhsDocumentList">点击“刷新”读取生效资料</div>',
      '    <div class="xhs-knowledge-toolbar" style="margin-top:12px;">',
      '      <span class="toolbar-title" id="xhsKnowledgeCount">已沉淀人工优质话术 (0)</span>',
      '    </div>',
      '    <div class="xhs-knowledge-list" id="xhsKnowledgeList">暂无人工沉淀案例</div>',
      '  </div>',
      '</div>'
    ].join("\n");

    root.innerHTML = html;
    document.body.appendChild(root);
    bindEvents(root);
  }

  function bindEvents(root) {
    const pill = root.querySelector('#xhsPillTrigger');
    const panel = root.querySelector('#xhsExpandedPanel');
    const closeBtn = root.querySelector('#xhsClosePanelBtn');

    pill?.addEventListener('click', () => panel?.classList.toggle('active'));
    closeBtn?.addEventListener('click', () => panel?.classList.remove('active'));

    root.querySelectorAll('.xhs-dock-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        root.querySelectorAll('.xhs-dock-tab').forEach(item => item.classList.toggle('active', item === tab));
        root.querySelector('#xhsTabDesk').style.display = tab.dataset.tab === 'desk' ? '' : 'none';
        root.querySelector('#xhsTabStrategy').style.display = tab.dataset.tab === 'strategy' ? '' : 'none';
        root.querySelector('#xhsTabKnowledge').style.display = tab.dataset.tab === 'knowledge' ? '' : 'none';
        if (tab.dataset.tab === 'knowledge') handlers.onLoadKnowledge?.();
      });
    });

    root.querySelector('#xhsBtnGenNow')?.addEventListener('click', () => handlers.onGenerate?.());
    root.querySelector('#xhsBtnSendWecomCard')?.addEventListener('click', () => handlers.onSendCard?.('wecom'));
    root.querySelector('#xhsBtnSendLeadCard')?.addEventListener('click', () => handlers.onSendCard?.('lead'));
    root.querySelector('#xhsBtnLearnNow')?.addEventListener('click', () => handlers.onLearnHistory?.());
    root.querySelector('#xhsBtnSaveFeedback')?.addEventListener('click', () => handlers.onSaveFeedback?.());
    root.querySelector('#xhsBtnResetTokens')?.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onResetTokens?.();
    });

    root.querySelector('#xhsDockMasterToggle')?.addEventListener('change', e => handlers.onSaveConfig?.({ enabled: e.target.checked }));
    root.querySelector('#xhsDockRunMode')?.addEventListener('change', e => {
      handlers.onSaveConfig?.({ runMode: e.target.value });
      addLog('info', '工作模式已切换为：' + (e.target.value === 'full_auto' ? '全自动值守' : '半自动副驾'));
    });
    root.querySelector('#xhsDockTimeScope')?.addEventListener('change', e => handlers.onSaveConfig?.({ timeScope: e.target.value }));
    root.querySelector('#xhsBeginAwayMode')?.addEventListener('click', () => handlers.onToggleAway?.());

    root.querySelector('#xhsBtnRefreshKnowledge')?.addEventListener('click', () => handlers.onLoadKnowledge?.());
    root.querySelector('#xhsKnowledgeFiles')?.addEventListener('change', e => handlers.onUploadFiles?.(e.target.files));
    root.querySelector('#xhsBtnImportFeishu')?.addEventListener('click', () => handlers.onImportFeishu?.());

    const drop = root.querySelector('#xhsKnowledgeDrop');
    if (drop) {
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
      drop.addEventListener('drop', e => {
        e.preventDefault();
        drop.classList.remove('dragging');
        handlers.onUploadFiles?.(e.dataTransfer.files);
      });
    }
  }

  function addLog(type, text) {
    const container = document.getElementById('xhsLogContainer');
    if (!container) return;

    if (container.querySelector('.log-empty-state')) {
      container.innerHTML = '';
    }

    const row = document.createElement('div');
    row.className = 'xhs-log-item ' + type;

    const now = new Date();
    const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');

    let tagLabel = '信息';
    if (type === 'success') tagLabel = '就绪';
    else if (type === 'lead') tagLabel = '线索';
    else if (type === 'warn') tagLabel = '风控';
    else if (type === 'error') tagLabel = '异常';

    row.innerHTML = [
      '<div class="log-meta">',
      '  <span class="log-tag tag-' + type + '">' + tagLabel + '</span>',
      '  <span class="log-time">' + timeStr + '</span>',
      '</div>',
      '<div class="log-message">' + escapeHtml(text) + '</div>'
    ].join("\n");

    container.prepend(row);
    while (container.children.length > 30) {
      container.removeChild(container.lastChild);
    }
  }

  function updateTokenMeter(info) {
    const usageText = document.getElementById('xhsTokenUsageText');
    const bar = document.getElementById('xhsTokenProgressBar');
    const countText = document.getElementById('xhsCallCountText');
    const badge = document.getElementById('xhsTokenStatusBadge');
    if (!usageText || !bar) return;

    const used = Number(info.used || 0);
    const budget = Number(info.budget || 200_000);
    const calls = Number(info.calls || 0);
    const pct = Math.min(100, Math.round((used / budget) * 100));

    usageText.textContent = (used / 1000).toFixed(1) + 'k / ' + (budget / 1000).toFixed(0) + 'k (' + pct + '%)';
    bar.style.width = pct + '%';

    if (info.tripped) {
      bar.style.background = '#ef4444';
      if (badge) { badge.textContent = '已熔断'; badge.className = 'meter-badge tripped'; }
      usageText.style.color = '#ef4444';
    } else if (pct >= 80) {
      bar.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
      if (badge) { badge.textContent = '预警'; badge.className = 'meter-badge warning'; }
      usageText.style.color = '#f59e0b';
    } else {
      bar.style.background = 'linear-gradient(90deg, #6366f1, #38bdf8)';
      if (badge) { badge.textContent = '运行中'; badge.className = 'meter-badge running'; }
      usageText.style.color = '#38bdf8';
    }
    if (countText) countText.textContent = '今日调用: ' + calls + ' 次';
  }

  function updateSessionLabel(session) {
    const label = document.getElementById('xhsActiveCustomerName');
    if (label) {
      const name = session?.name ? session.name.slice(0, 10) : '识别中';
      label.textContent = '当前会话：' + name;
    }
  }

  function updateRuntimeStatus(mode, detail) {
    const pillText = document.getElementById('xhsPillModeText');
    if (pillText) pillText.textContent = detail ? String(detail).slice(0, 8) : '就绪';

    const dot = document.getElementById('xhsPulseDot');
    if (dot) {
      if (detail && (detail.includes('熔断') || detail.includes('异常'))) {
        dot.className = 'xhs-dock-status-dot tripped';
      } else if (mode === 'full_auto') {
        dot.className = 'xhs-dock-status-dot auto';
      } else {
        dot.className = 'xhs-dock-status-dot copilot';
      }
    }
  }

  function showFeedbackCard(candidate, sent = false) {
    const card = document.getElementById('xhsFeedbackCard');
    const hint = document.getElementById('xhsFeedbackHint');
    if (!card || !candidate) return;
    card.hidden = false;
    if (hint) {
      hint.textContent = sent
        ? '已捕获向「' + (candidate.session?.name || '客户') + '」发送的人工回复，可沉淀至知识库。'
        : '修改输入框中的草稿后，点击下方按钮可让 AI 永久记住更优话术。';
    }
  }

  function hideFeedbackCard() {
    const card = document.getElementById('xhsFeedbackCard');
    if (card) card.hidden = true;
    const status = document.getElementById('xhsFeedbackStatus');
    if (status) status.textContent = '';
  }

  function syncState(state) {
    const master = document.getElementById('xhsDockMasterToggle');
    const mode = document.getElementById('xhsDockRunMode');
    const time = document.getElementById('xhsDockTimeScope');
    if (master) master.checked = Boolean(state.enabled);
    if (mode) mode.value = state.runMode || 'copilot';
    if (time) time.value = state.timeScope || 'all_day';

    const armed = Boolean(state.enabled && state.runMode === 'full_auto' && state.operatorAway);
    const hint = document.getElementById('xhsAutoArmHint');
    if (hint) {
      hint.textContent = state.runMode === 'full_auto'
        ? (armed ? '● 已武装：无人操作时系统自动代答' : '○ 未武装：请点击“开始无人值守”')
        : '副驾只预填草稿，不会自动发送';
    }

    const awayButton = document.getElementById('xhsBeginAwayMode');
    if (awayButton) {
      awayButton.hidden = state.runMode !== 'full_auto';
      awayButton.textContent = armed ? '结束无人值守' : '开始无人值守';
    }

    const genBtn = document.getElementById('xhsBtnGenNow');
    if (genBtn) {
      const contentSpan = genBtn.querySelector('.btn-content');
      if (contentSpan) {
        contentSpan.textContent = state.runMode === 'full_auto'
          ? '⚡ 立即扫描并接管全部待回会话'
          : '✨ 为当前客户生成专属回复';
      }
    }
  }

  function syncMonitorUI(monitor) {
    const box = document.getElementById('xhsMonitorSummary');
    if (!box || !monitor) return;
    box.innerHTML = [
      '<div class="monitor-item"><span>LLM 成功调用</span><strong>' + (monitor.llmSuccessCount || 0) + ' 次</strong></div>',
      '<div class="monitor-item"><span>平均响应耗时</span><strong>' + (monitor.lastLlmLatencyMs ? monitor.lastLlmLatencyMs + ' ms' : '-') + '</strong></div>',
      '<div class="monitor-item"><span>自动发送成功</span><strong>' + (monitor.sendSuccessCount || 0) + ' 条</strong></div>',
      (monitor.lastError ? '<div class="monitor-error">最近告警: ' + escapeHtml(monitor.lastError) + '</div>' : '')
    ].join("\n");
  }

  window.XhsDock = {
    init,
    render,
    addLog,
    updateTokenMeter,
    updateSessionLabel,
    updateRuntimeStatus,
    showFeedbackCard,
    hideFeedbackCard,
    syncState,
    syncMonitorUI
  };
})();