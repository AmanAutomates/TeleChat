"""Incoming message handlers for both HttpBot and Telethon modes."""

import json
from datetime import datetime, timedelta

from src.clients import userbot, bot, is_http_bot
from src.config import allowed_users, afk_message, create_user_bot
from src.storage import storage

# websocket clients (populated by server.py)
ws_clients: set = set()

# hours before afk reply is sent again to same user
afk_cooldown_hours = 2


async def _notify_ws(data: dict):
    """Push json payload to all connected websocket clients."""
    payload = json.dumps(data, default=str)
    dead = set()
    for ws in ws_clients:
        try:
            await ws.send_str(payload)
        except Exception:
            dead.add(ws)
    ws_clients.difference_update(dead)


def _should_send_afk(user_id) -> bool:
    """Only send afk reply on first contact or after cooldown period."""
    info = storage.get_user(user_id)
    if not info:
        return True

    last = info.get("last_interaction")
    if not last:
        return True

    try:
        last_dt = datetime.fromisoformat(last)
        return datetime.now() - last_dt > timedelta(hours=afk_cooldown_hours)
    except (ValueError, TypeError):
        return True


async def _save_and_notify(user_obj, msg_id, text, media_type, media_file,
                           reply_to, fwd_name, fwd_uname, source):
    """Store message, conditionally send afk reply, push to websocket."""
    send_afk = _should_send_afk(user_obj.id)

    user_info = await storage.update_user(user_obj)
    await storage.touch_interaction(user_obj.id)

    msg_data = {
        "msg_id": msg_id,
        "direction": "in",
        "text": text or "",
        "timestamp": datetime.now().isoformat(),
        "media_type": media_type,
        "media_file": media_file,
        "reply_to": reply_to,
        "forwarded_from": fwd_name,
        "forwarded_from_username": fwd_uname,
        "source": source,
    }

    await storage.save_message(user_obj.id, msg_data)
    await storage.increment_unread(user_obj.id)

    if send_afk:
        try:
            await bot.send_message(user_obj.id, afk_message)
        except Exception as exc:
            print(f"[afk reply] {exc}")

    await _notify_ws({
        "type": "new_message",
        "user_id": user_obj.id,
        "message": msg_data,
        "user_info": user_info,
    })


# httpbot mode handler

async def _http_bot_handler(msg):
    """Called by HttpBot polling for every private message."""
    if not msg.sender or msg.sender.bot:
        return
    if msg.sender.id not in allowed_users:
        return

    media_type = msg.media_type
    media_file = msg.media_filename
    if media_type:
        await storage.update_user(msg.sender)
        folder = storage.get_user_folder(msg.sender.id)
        if folder:
            dest = folder / "media" / media_file
            try:
                await msg.download_media(str(dest))
            except Exception as exc:
                print(f"[media download] {exc}")
                media_type = media_file = None

    fwd_name = fwd_uname = None
    if msg.forward and msg.forward.sender:
        s = msg.forward.sender
        fwd_name = f"{s.first_name} {s.last_name}".strip()
        fwd_uname = s.username

    reply_to = msg.reply_to.reply_to_msg_id if msg.reply_to else None

    await _save_and_notify(
        msg.sender, msg.id, msg.text,
        media_type, media_file,
        reply_to, fwd_name, fwd_uname, "bot",
    )


# telethon mode handler setup

def _setup_telethon_handlers():
    from telethon import events
    from telethon.tl.types import (
        MessageMediaPhoto,
        MessageMediaDocument,
        DocumentAttributeFilename,
        DocumentAttributeAudio,
        DocumentAttributeVideo,
        DocumentAttributeSticker,
    )

    def _doc_type(doc) -> str:
        mime = doc.mime_type or ""
        if mime.startswith("video"):   return "video"
        if mime.startswith("audio"):   return "audio"
        if mime.startswith("image"):   return "photo"
        return "document"

    def _media_info(m):
        if not m.media:
            return None, None
        if isinstance(m.media, MessageMediaPhoto):
            return "photo", f"{m.id}.jpg"
        if isinstance(m.media, MessageMediaDocument):
            doc = m.media.document
            for attr in doc.attributes:
                if isinstance(attr, DocumentAttributeFilename):
                    return _doc_type(doc), f"{m.id}_{attr.file_name}"
                if isinstance(attr, DocumentAttributeSticker):
                    return "sticker", f"{m.id}.webp"
                if isinstance(attr, DocumentAttributeAudio):
                    t = "voice" if attr.voice else "audio"
                    ext = ".ogg" if attr.voice else ".mp3"
                    return t, f"{m.id}{ext}"
                if isinstance(attr, DocumentAttributeVideo):
                    t = "video_note" if attr.round_message else "video"
                    return t, f"{m.id}.mp4"
            return "document", f"{m.id}"
        return None, None

    async def _handle_telethon(event, source: str):
        sender = await event.get_sender()
        if not sender or getattr(sender, "bot", False):
            return
        if sender.id not in allowed_users:
            return

        await storage.update_user(sender)
        folder = storage.get_user_folder(sender.id)

        media_type, media_file = _media_info(event.message)
        if media_type and folder:
            try:
                await event.message.download_media(
                    file=str(folder / "media" / media_file))
            except Exception as exc:
                print(f"[media download] {exc}")
                media_type = media_file = None

        fwd_name = fwd_uname = None
        if event.message.forward:
            fwd = event.message.forward
            if fwd.sender:
                fwd_name = getattr(fwd.sender, "first_name", "") or ""
                ln = getattr(fwd.sender, "last_name", "")
                if ln:
                    fwd_name += f" {ln}"
                fwd_uname = getattr(fwd.sender, "username", None)

        reply_to = (event.message.reply_to.reply_to_msg_id
                    if event.message.reply_to else None)

        await _save_and_notify(
            sender, event.message.id, event.message.text or "",
            media_type, media_file,
            reply_to, fwd_name, fwd_uname, source,
        )

    if userbot is not None:
        @userbot.on(events.NewMessage(incoming=True, func=lambda e: e.is_private))
        async def on_userbot_msg(event):
            await _handle_telethon(event, "userbot")
        print("[+] userbot handler registered")

    @bot.on(events.NewMessage(incoming=True, func=lambda e: e.is_private))
    async def on_bot_msg(event):
        await _handle_telethon(event, "bot")


def setup_handlers():
    if is_http_bot:
        bot.on_message(_http_bot_handler)
        print("[+] http bot handler registered")
    else:
        _setup_telethon_handlers()
        if not create_user_bot:
            print("[-] userbot disabled")
    print("[+] bot handler registered")
