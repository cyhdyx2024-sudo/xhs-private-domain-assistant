/**
 * 评论区 AI 副驾（V1.0.3）：笔记页每条评论旁注入「AI 回复」按钮，
 * 点击后读取评论内容 → Bridge 生成公开回复草稿 → 填入回复框。
 * 只预填，不自动发送：评论是公开内容，发布永远由人确认。
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  if (!/\.xiaohongshu\.com$/.test(location.hostname)) return;
  if (!/\/(explore|discovery)\/[0-9a-f]{12,}/.test(location.pathname)) return;

  const BRIDGE_URL = (window.__XHS_COMMENT_BRIDGE__ || 'http://127.0.0.1:18195').replace(/\/+$/, '');
  const ROOT_ID = 'xhs-comment-copilot-root';
  if (document.getElementById(ROOT_ID)?.__xhsDestroy) document.getElementById(ROOT_ID).__xhsDestroy();

  const state = { busy: new WeakSet() };

  function bridgeBase() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['bridgeUrl'], (r) => resolve(String(r.bridgeUrl || BRIDGE_URL).replace(/\/+$/, '')));
      } catch (_) { resolve(BRIDGE_URL); }
    });
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function commentText(item) {
    const nodes = item.querySelectorAll('.note-text, .content, [class*="content"]');
    for (const node of nodes) {
      const text = cleanText(node.textContent);
      if (text.length > 1) return text.slice(0, 300);
    }
    return '';
  }

  function commentAuthor(item) {
    const name = item.querySelector('.author .name, [class*="author"] [class*="name"], .name');
    return cleanText(name?.textContent).slice(0, 30);
  }

  function noteTitle() {
    return cleanText(document.querySelector('#detail-title, .title, [class*="note-content"] [class*="title"]')?.textContent).slice(0, 60);
  }

  function replyButton(item) {
    return [...item.querySelectorAll('span, button, div')].find((node) => {
      if (node.children.length > 0) return false;
      const text = cleanText(node.textContent);
      return text === '回复' || text === '回复他' || text === '回复TA';
    }) || null;
  }

  function replyInput(item) {
    // 回复框可能是 contenteditable div 或 textarea；优先在评论项内找，找不到再全局找最后激活的
    return item.querySelector('[contenteditable="true"], textarea')
      || document.querySelector('.comment-input [contenteditable="true"], .reply-input [contenteditable="true"], [class*="reply"] textarea');
  }

  function setInputValue(input, text) {
    if (input.isContentEditable) {
      input.focus();
      input.textContent = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      (setter || (() => {})).call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
  }

  async function generateDraft(item, chip) {
    const original = chip.textContent;
    chip.textContent = '生成中…';
    chip.style.opacity = '0.6';
   try {
     const bridge = await bridgeBase();
      const storage = await new Promise((r) => chrome.storage.local.get(
        ['workspaceToken', 'modelBaseUrl', 'modelName', 'modelApiKey'],
        (x) => r(x || {})
      ));
      const modelHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${storage.workspaceToken || ''}`,
        'X-Model-Base-Url': storage.modelBaseUrl || 'http://127.0.0.1:10100/v1/chat/completions',
        'X-Model-Name': storage.modelName || 'google-antigravity/gemini-3.7-flash',
        'X-Model-Key': storage.modelApiKey || ''
      };
      const response = await fetch(`${bridge}/reply`, {
        method: 'POST',
        headers: modelHeaders,
        body: JSON.stringify({
          session_id: `comment:${location.pathname}`,
          user_name: commentAuthor(item),
          action: 'comment_reply',
          knowledge_scope: 'default',
          latest_msg: commentText(item),
          turns: [],
          note_title: noteTitle()
        })
      });
      const data = await response.json();
      if (!data.ok || !data.reply) throw new Error(data.error || `HTTP ${response.status}`);
      const replyButtonNode = replyButton(item);
      if (replyButtonNode) replyButtonNode.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const input = replyInput(item);
      if (!input) throw new Error('没找到回复输入框，请手动点击该评论的「回复」后再试');
      setInputValue(input, data.reply);
      chip.textContent = '✓ 已填入';
      setTimeout(() => { chip.textContent = 'AI 回复'; chip.style.opacity = '1'; }, 2000);
    } catch (error) {
      chip.textContent = 'AI 回复';
      chip.style.opacity = '1';
      chip.title = String(error.message || error);
      chip.style.background = '#fee2e2';
      setTimeout(() => { chip.style.background = 'rgba(0,0,0,0.06)'; }, 2500);
    }
    state.busy.delete(item);
  }

  function decorate(item) {
    if (item.__xhsAiChip || state.busy.has(item)) return;
    const actions = item.querySelector('.interactions, [class*="interact"], .operate, .info');
    if (!actions) return;
    if ([...actions.childNodes].some((n) => n.__xhsAiChip)) return;
    const chip = document.createElement('span');
    chip.textContent = 'AI 回复';
    chip.__xhsAiChip = true;
    Object.assign(chip.style, {
      cursor: 'pointer', marginLeft: '10px', padding: '0 6px', borderRadius: '4px',
      background: 'rgba(0,0,0,0.06)', color: '#ff2442', fontSize: '12px', fontWeight: '600',
      lineHeight: '18px', display: 'inline-block', userSelect: 'none'
    });
    chip.title = '生成一条公开回复草稿（填入后由你确认发送）';
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (state.busy.has(item)) return;
      state.busy.add(item);
      generateDraft(item, chip);
    });
    item.__xhsAiChip = chip;
    actions.appendChild(chip);
  }

  let observer = null;
  let scanTimer = null;
  function scan() {
    try {
      document.querySelectorAll('.comment-item, .parent-comment, [class*="comment-item"]').forEach(decorate);
    } catch (_) { /* DOM 变化中的瞬态错误忽略 */ }
    scanTimer = setTimeout(scan, 2000);
  }

  function start() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      document.documentElement.appendChild(root);
    }
    root.__xhsDestroy = () => {
      clearTimeout(scanTimer);
      observer?.disconnect();
      root.remove();
    };
    scan();
    observer = new MutationObserver(() => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scan, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
