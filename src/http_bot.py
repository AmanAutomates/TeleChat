"""
Lightweight Telegram Bot API client using aiohttp.
Used in bot-only mode, no API_ID/API_HASH needed.
"""

import asyncio
import mimetypes
from pathlib import Path

import aiohttp


class BotUser:
    """Minimal user object matching fields we use from Telethon."""
    def __init__(self, d: dict):
        self.id = d["id"]
        self.first_name = d.get("first_name", "")
        self.last_name = d.get("last_name") or ""
        self.username = d.get("username")
        self.bot = d.get("is_bot", False)


class BotForward:
    def __init__(self, d: dict):
        self.sender = BotUser(d) if d else None


class BotReplyTo:
    def __init__(self, msg_id: int):
        self.reply_to_msg_id = msg_id


class BotMessage:
    """Wraps a Bot API message dict into an object with Telethon-like attributes."""
    def __init__(self, data: dict, bot: "HttpBot"):
        self.id = data["message_id"]
        self.text = data.get("text", "") or data.get("caption", "")
        self.sender = BotUser(data["from"]) if "from" in data else None
        self.is_private = data.get("chat", {}).get("type") == "private"
        self._data = data
        self._bot = bot

        self.forward = None
        if "forward_from" in data:
            self.forward = BotForward(data["forward_from"])

        self.reply_to = None
        if "reply_to_message" in data:
            self.reply_to = BotReplyTo(data["reply_to_message"]["message_id"])

        self.media_type = None
        self.media_file_id = None
        self._original_filename = None

        if "photo" in data:
            self.media_type = "photo"
            self.media_file_id = data["photo"][-1]["file_id"]
        elif "sticker" in data:
            self.media_type = "sticker"
            self.media_file_id = data["sticker"]["file_id"]
        elif "video_note" in data:
            self.media_type = "video_note"
            self.media_file_id = data["video_note"]["file_id"]
        elif "voice" in data:
            self.media_type = "voice"
            self.media_file_id = data["voice"]["file_id"]
        elif "video" in data:
            self.media_type = "video"
            self.media_file_id = data["video"]["file_id"]
        elif "audio" in data:
            self.media_type = "audio"
            self.media_file_id = data["audio"]["file_id"]
        elif "document" in data:
            doc = data["document"]
            self.media_file_id = doc["file_id"]
            self._original_filename = doc.get("file_name")
            mime = doc.get("mime_type", "")
            if mime.startswith("video"):
                self.media_type = "video"
            elif mime.startswith("audio"):
                self.media_type = "audio"
            elif mime.startswith("image"):
                self.media_type = "photo"
            else:
                self.media_type = "document"

    @property
    def media_filename(self) -> str | None:
        if not self.media_type:
            return None
        ext_map = {
            "photo": ".jpg", "video": ".mp4", "audio": ".mp3",
            "voice": ".ogg", "video_note": ".mp4", "sticker": ".webp",
        }
        if self.media_type == "document" and self._original_filename:
            return f"{self.id}_{self._original_filename}"
        ext = ext_map.get(self.media_type, "")
        return f"{self.id}{ext}"

    async def download_media(self, dest: str):
        if not self.media_file_id:
            return
        await self._bot.download_file(self.media_file_id, dest)


class SentMessage:
    def __init__(self, data: dict):
        self.id = data["message_id"]


class HttpBot:
    """Async Telegram Bot API client, drop-in for TelegramClient in bot-only mode."""

    def __init__(self, token: str):
        self.token = token
        self._base = f"https://api.telegram.org/bot{token}"
        self._file_base = f"https://api.telegram.org/file/bot{token}"
        self._session: aiohttp.ClientSession | None = None
        self._me: BotUser | None = None
        self._msg_handler = None
        self._running = False

    async def start(self, bot_token=None):
        self._session = aiohttp.ClientSession()
        data = await self._call("getMe")
        self._me = BotUser(data)
        return self._me

    async def get_me(self):
        if not self._me:
            await self.start()
        return self._me

    async def disconnect(self):
        self._running = False
        if self._session:
            await self._session.close()
            self._session = None

    async def _call(self, method: str, **kwargs):
        async with self._session.post(f"{self._base}/{method}", json=kwargs) as r:
            body = await r.json()
            if not body.get("ok"):
                raise Exception(body.get("description", "Bot API error"))
            return body["result"]

    async def _call_form(self, method: str, data: aiohttp.FormData):
        async with self._session.post(f"{self._base}/{method}", data=data) as r:
            body = await r.json()
            if not body.get("ok"):
                raise Exception(body.get("description", "Bot API error"))
            return body["result"]

    async def send_message(self, chat_id, text, reply_to=None, **_kw):
        params = {"chat_id": chat_id, "text": text}
        if reply_to:
            params["reply_to_message_id"] = reply_to
        return SentMessage(await self._call("sendMessage", **params))

    async def send_file(self, chat_id, file_path, caption=None, reply_to=None, **_kw):
        p = Path(file_path)
        mime, _ = mimetypes.guess_type(str(p))
        mime = mime or "application/octet-stream"

        if mime.startswith("image") and not mime.endswith("gif"):
            field, method = "photo", "sendPhoto"
        elif mime.startswith("video"):
            field, method = "video", "sendVideo"
        elif mime.startswith("audio"):
            field, method = "audio", "sendAudio"
        else:
            field, method = "document", "sendDocument"

        fd = aiohttp.FormData()
        fd.add_field("chat_id", str(chat_id))
        if caption:
            fd.add_field("caption", caption)
        if reply_to:
            fd.add_field("reply_to_message_id", str(reply_to))
        fd.add_field(field, open(p, "rb"), filename=p.name,
                     content_type=mime)

        return SentMessage(await self._call_form(method, fd))

    async def download_file(self, file_id: str, dest: str):
        info = await self._call("getFile", file_id=file_id)
        file_path = info["file_path"]
        url = f"{self._file_base}/{file_path}"
        async with self._session.get(url) as r:
            Path(dest).parent.mkdir(parents=True, exist_ok=True)
            with open(dest, "wb") as f:
                async for chunk in r.content.iter_chunked(8192):
                    f.write(chunk)

    async def delete_messages(self, chat_id, msg_ids: list):
        """Delete messages from telegram (bots can delete within 48h in private chats)."""
        for mid in msg_ids:
            try:
                await self._call("deleteMessage",
                                 chat_id=chat_id, message_id=mid)
            except Exception as exc:
                print(f"[tg delete] msg {mid}: {exc}")

    async def get_user_profile_photo(self, user_id: int, dest: str) -> bool:
        """Download user's profile photo to dest. Returns True on success."""
        try:
            data = await self._call("getUserProfilePhotos",
                                    user_id=user_id, limit=1)
            if not data.get("photos") or not data["photos"]:
                return False
            photo = data["photos"][0]
            best = photo[-1]
            await self.download_file(best["file_id"], dest)
            return True
        except Exception as exc:
            print(f"[avatar] user {user_id}: {exc}")
            return False

    def on_message(self, handler):
        """Register an async callback for incoming messages."""
        self._msg_handler = handler

    async def start_polling(self):
        """Long-poll getUpdates in a loop."""
        self._running = True
        offset = 0
        while self._running:
            try:
                updates = await self._call("getUpdates",
                                           offset=offset, timeout=30,
                                           allowed_updates=["message"])
                for u in updates:
                    offset = u["update_id"] + 1
                    raw = u.get("message")
                    if raw and self._msg_handler:
                        msg = BotMessage(raw, self)
                        if msg.is_private and msg.sender:
                            try:
                                await self._msg_handler(msg)
                            except Exception as exc:
                                print(f"[handler] {exc}")
            except asyncio.CancelledError:
                break
            except Exception as exc:
                print(f"[polling] {exc}")
                await asyncio.sleep(3)
