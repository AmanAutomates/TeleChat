import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

base_dir = Path(__file__).resolve().parent.parent

# telegram credentials
bot_token = os.getenv("BOT_TOKEN", "")
create_user_bot = os.getenv("CREATE_USER_BOT", "False").strip().lower() in ("true", "1", "yes")
api_id = int(os.getenv("API_ID", "0")) if create_user_bot else 0
api_hash = os.getenv("API_HASH", "") if create_user_bot else ""
phone_number = os.getenv("PHONE_NUMBER", "") if create_user_bot else ""

# web server
web_host = os.getenv("WEB_HOST", "127.0.0.1")
web_port = int(os.getenv("WEB_PORT", "8080"))

# chat config
messages_per_load = 30

allowed_users: list[int] = []

# afk auto reply
afk_message = "will reply very soon if not afk (or not ignoring)"

# paths
data_dir = base_dir / "data"
chats_dir = data_dir / "chats"
users_file = data_dir / "users.json"
sessions_dir = base_dir / "sessions"

for d in (data_dir, chats_dir, sessions_dir):
    d.mkdir(parents=True, exist_ok=True)
