import urllib.request, json
token = 'xhs_live_87EBDO26zZKNv7NlmuZgc-TOaSyRyH7UU47EPMH-Tag'
req = urllib.request.Request('http://127.0.0.1:18195/knowledge/documents', headers={'Authorization': f'Bearer {token}'})
with urllib.request.urlopen(req) as resp:
    print('Docs Result:', json.loads(resp.read().decode('utf-8')))
req2 = urllib.request.Request('http://127.0.0.1:18195/knowledge/faq/list', headers={'Authorization': f'Bearer {token}'})
with urllib.request.urlopen(req2) as resp:
    print('FAQ Result:', json.loads(resp.read().decode('utf-8')))
