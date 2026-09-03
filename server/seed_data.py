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
        ('多少钱？怎么收费？', '当前业务资料没有明确价格时，不自行报价或承诺优惠，请由人工按实际版本确认。', '价格,收费,多少钱,套餐,费用'),
        ('手机上可以用吗？有没有小程序或App？', '新作 2.0 主要是免下载的电脑网页端工具，直接在浏览器打开即可。因为小红书 3:4 多页图文涉及精细的排版、字数门禁和模板调整，电脑大屏操作最轻量顺畅。', '手机,小程序,App,安装,下载,电脑'),
        ('你们会乱发消息或被封号吗？', '系统默认只生成草稿并由操作员确认发送；仍需遵守平台规则，不能承诺账号绝对安全。', '封号,安全,违规,自动发,群控'),
        ('可以针对我们行业的特定模板定制吗？', '是否支持行业模板或定制取决于实际产品配置；资料没有明确说明时请由人工确认。', '模板,定制,行业,美业,家装,教培')
    ]
    for q, a, kw in faqs:
        add_tenant_faq(tid, q, a, kw)
    print(f'Added {len(faqs)} FAQs for {tid}')
