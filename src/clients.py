"""
Client factory. Bot-only mode uses HttpBot (just bot_token needed),
full mode uses Telethon for both userbot and bot.
"""

import sys
from src.config import api_id, api_hash, bot_token, sessions_dir, create_user_bot

if not bot_token:
    print("[x] bot_token is missing in .env")
    sys.exit(1)

if create_user_bot:
    if not api_id or not api_hash:
        print("[x] create_user_bot=True requires API_ID and API_HASH in .env")
        print("    get them at https://my.telegram.org")
        sys.exit(1)

    from telethon import TelegramClient

    userbot = TelegramClient(
        str(sessions_dir / "userbot"),
        api_id, api_hash,
        connection_retries=5, auto_reconnect=True,
    )
    bot = TelegramClient(
        str(sessions_dir / "bot"),
        api_id, api_hash,
        connection_retries=5, auto_reconnect=True,
    )
    is_http_bot = False

else:
    from src.http_bot import HttpBot

    userbot = None
    bot = HttpBot(bot_token)
    is_http_bot = True
