import sqlite3
conn = sqlite3.connect("server/data/xhs_reply_feedback.sqlite3")
conn.execute("DELETE FROM reply_feedback")
conn.commit()
print("Cleaned reply_feedback table")
