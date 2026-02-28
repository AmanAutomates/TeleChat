import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

base_dir = Path(__file__).resolve().parent.parent

# telegram credentials
bot_token = os.getenv("bot_token", os.getenv("BOT_TOKEN", ""))
create_user_bot = os.getenv("create_user_bot", os.getenv("CREATE_USER_BOT", "False")).strip().lower() in ("true", "1", "yes")
api_id = int(os.getenv("api_id", os.getenv("API_ID", "0"))) if create_user_bot else 0
api_hash = os.getenv("api_hash", os.getenv("API_HASH", "")) if create_user_bot else ""
phone_number = os.getenv("phone_number", os.getenv("PHONE_NUMBER", "")) if create_user_bot else ""

# web server
web_host = os.getenv("web_host", os.getenv("WEB_HOST", "127.0.0.1"))
web_port = int(os.getenv("web_port", os.getenv("WEB_PORT", "8080")))

# chat config
messages_per_load = 30

_au = os.getenv("allowed_users", "")
allowed_users = [int(x.strip().strip("'\"")) for x in _au.split(",") if x.strip().strip("'\"")] if _au else []

_bu = os.getenv("banned_users", "")
banned_users = [int(x.strip().strip("'\"")) for x in _bu.split(",") if x.strip().strip("'\"")] if _bu else []

# afk auto reply
afk_message = "will reply very soon if not afk (or not ignoring)"

# paths
data_dir = base_dir / "data"
chats_dir = data_dir / "chats"
users_file = data_dir / "users.json"
sessions_dir = base_dir / "sessions"

for d in (data_dir, chats_dir, sessions_dir):
    d.mkdir(parents=True, exist_ok=True)

def update_banned_users(uid, block=True):
    from dotenv import set_key
    global banned_users
    uid = int(uid)
    if block and uid not in banned_users:
        banned_users.append(uid)
    elif not block and uid in banned_users:
        banned_users.remove(uid)
    
    val = ",".join(str(x) for x in banned_users)
    set_key(str(base_dir / ".env"), "banned_users", val)
