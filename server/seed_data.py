import sqlite3
from pathlib import Path
import sys
from db import init_feedback_db, add_tenant_faq
from rag import ingest_knowledge_document

init_feedback_db()
conn = sqlite3.connect('server/data/xhs_reply_feedback.sqlite3')
cur = conn.cursor()
tenants = cur.execute('SELECT id, token_hash, workspace_name FROM tenants').fetchall()
print('Current tenants:', tenants)

content = Path('server/data/seed_knowledge_xinzuo.md').read_text(encoding='utf-8')

for tid, thash, name in tenants:
    tenant = {'id': tid, 'workspace_name': name}
    res = ingest_knowledge_document(tenant, '新作AI 2.0官方产品手册与常见问答.md', content, 'file', '', {'model': ''})
    print(f'Ingested doc for {tid} ({name}):', res.get('chunk_count'), 'chunks')
    
    faqs = [
        ('多少钱？怎么收费？', '目前新作 2.0 处于商用内测阶段，提供免费算力体验包。方便留个联系方式吗？我先给您的手机号开通 50 次免费生成额度，您先体验出图效果，后续正式套餐会根据您的使用频率灵活选择。', '价格,收费,多少钱,套餐,费用'),
        ('手机上可以用吗？有没有小程序或App？', '新作 2.0 主要是免下载的电脑网页端工具，直接在浏览器打开即可。因为小红书 3:4 多页图文涉及精细的排版、字数门禁和模板调整，电脑大屏操作最轻量顺畅。', '手机,小程序,App,安装,下载,电脑'),
        ('你们会乱发消息或被封号吗？', '我们坚守合规底线，不做任何高风险的群控刷量或未经审核的无脑乱发。工具定位是您的“内容与客服副驾”——AI 负责高效起草和专业排版，最终发布与发送始终由您确认把关，确保账号 100% 安全。', '封号,安全,违规,自动发,群控'),
        ('可以针对我们行业的特定模板定制吗？', '完全可以！系统已经内置了 47 套行业专属模板（家装/美业/摄影/教培等），同时支持在知识库中上传您的门店资料、价格表和案例，生成出来的内容自带您的业务特色。', '模板,定制,行业,美业,家装,教培')
    ]
    for q, a, kw in faqs:
        add_tenant_faq(tid, q, a, kw)
    print(f'Added {len(faqs)} FAQs for {tid}')
