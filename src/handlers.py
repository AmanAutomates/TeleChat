"""Incoming message handlers for both HttpBot and Telethon modes."""

import json
from datetime import datetime, timedelta

from src.clients import userbot, bot, is_http_bot
from src.config import allowed_users, afk_message, create_user_bot, banned_users
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


async def _save_and_notify(chat, sender, msg_id, text, media_type, media_file,
                           reply_to, fwd_name, fwd_uname, source):
    """Store message, conditionally send afk reply, push to websocket."""
    is_group = bool(getattr(chat, 'type', None) in ('group', 'supergroup'))
    send_afk = False if is_group else _should_send_afk(chat.id)

    user_info = await storage.update_user(chat)
    await storage.touch_interaction(chat.id)

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
        "sender_id": sender.id if getattr(sender, 'id', None) else None,
        "sender_name": f"{getattr(sender, 'first_name', '')} {getattr(sender, 'last_name', '')}".strip() if sender else None,
    }

    await storage.save_message(chat.id, msg_data)
    await storage.increment_unread(chat.id)

    if send_afk:
        try:
            await bot.send_message(chat.id, afk_message)
        except Exception as exc:
            print(f"[afk reply] {exc}")

    await _notify_ws({
        "type": "new_message",
        "user_id": chat.id,
        "message": msg_data,
        "user_info": user_info,
    })


# httpbot mode handler

async def _http_bot_handler(msg):
    """Called by HttpBot polling for every message."""
    print(f"DEBUG recv: sender={getattr(msg.sender, 'id', None)}, chat={getattr(msg.chat, 'id', None)}, type={getattr(msg.chat, 'type', None)}")
    if not msg.sender or getattr(msg.sender, 'bot', False):
        print("DEBUG: blocked because no sender or bot")
        return

    chat = msg.chat if getattr(msg, 'chat', None) else msg.sender
    is_group = getattr(chat, 'type', 'private') in ('group', 'supergroup')

    if not is_group and msg.sender.id not in allowed_users:
        print(f"DEBUG: blocked because not group and not allowed")
        return

    if msg.sender.id in banned_users:
        print(f"DEBUG: blocked because banned")
        return

    media_type = getattr(msg, 'media_type', None)
    media_file = getattr(msg, 'media_filename', None)
    if media_type:
        await storage.update_user(chat)
        folder = storage.get_user_folder(chat.id)
        if folder:
            dest = folder / "media" / media_file
            try:
                await msg.download_media(str(dest))
            except Exception as exc:
                print(f"[media download] {exc}")
                media_type = media_file = None

    fwd_name = fwd_uname = None
    if getattr(msg, 'forward', None) and msg.forward.sender:
        s = msg.forward.sender
        fwd_name = f"{s.first_name} {s.last_name}".strip()
        fwd_uname = s.username

    reply_to = msg.reply_to.reply_to_msg_id if getattr(msg, 'reply_to', None) else None

    await _save_and_notify(
        chat, msg.sender, msg.id, msg.text,
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
                    mime = doc.mime_type or ""
                    if mime == "video/webm" or "video" in mime:
                        return "video_sticker", f"{m.id}.webm"
                    elif mime == "application/x-tgsticker":
                        return "animated_sticker", f"{m.id}.tgs"
                    else:
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
        if sender.id in banned_users:
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
            if getattr(fwd, 'sender', None):
                fwd_name = getattr(fwd.sender, "first_name", "") or ""
                ln = getattr(fwd.sender, "last_name", "")
                if ln:
                    fwd_name += f" {ln}"
                fwd_uname = getattr(fwd.sender, "username", None)

        reply_to = (event.message.reply_to.reply_to_msg_id
                    if getattr(event.message, 'reply_to', None) else None)

        chat = await event.get_chat()
        await _save_and_notify(
            chat, sender, event.message.id, event.message.text or "",
            media_type, media_file,
            reply_to, fwd_name, fwd_uname, source,
        )

    if userbot is not None:
        @userbot.on(events.NewMessage(incoming=True, func=lambda e: e.is_private))
        async def on_userbot_msg(event):
            await _handle_telethon(event, "userbot")

        @userbot.on(events.MessageDeleted())
        async def on_userbot_deleted(event):
            for msg_id in event.deleted_ids:
                chat_id = event.chat_id
                if not chat_id:
                    chat_id = await storage.get_chat_id_by_msg_id(msg_id)
                if chat_id:
                    msg = await storage.get_message_by_id(chat_id, msg_id)
                    if msg:
                        await storage.delete_messages(chat_id, [msg_id])
                        await _notify_ws({
                            "type": "messages_deleted",
                            "user_id": int(chat_id),
                            "msg_ids": [msg_id]
                        })
        print("[+] userbot handler registered")

    @bot.on(events.NewMessage(incoming=True, func=lambda e: e.is_private))
    async def on_bot_msg(event):
        await _handle_telethon(event, "bot")

    @bot.on(events.MessageDeleted())
    async def on_bot_deleted(event):
        for msg_id in event.deleted_ids:
            chat_id = event.chat_id
            if not chat_id:
                chat_id = await storage.get_chat_id_by_msg_id(msg_id)
            if chat_id:
                msg = await storage.get_message_by_id(chat_id, msg_id)
                if msg:
                    await storage.delete_messages(chat_id, [msg_id])
                    await _notify_ws({
                        "type": "messages_deleted",
                        "user_id": int(chat_id),
                        "msg_ids": [msg_id]
                    })
async def _http_edit_handler(msg):
    """Called when a user edits a message in Telegram (http mode)."""
    if not getattr(msg, 'sender', None) or getattr(msg.sender, 'bot', False):
        return

    chat = msg.chat if getattr(msg, 'chat', None) else msg.sender
    is_group = getattr(chat, 'type', 'private') in ('group', 'supergroup')

    if not is_group and msg.sender.id not in allowed_users:
        return

    new_text = getattr(msg, 'text', "") or ""
    await storage.edit_message(chat.id, msg.id, new_text)
    updated = await storage.get_message_by_id(chat.id, msg.id)
    await _notify_ws({
        "type": "message_edited",
        "user_id": chat.id,
        "msg_id": msg.id,
        "message": updated,
    })

async def _http_reaction_handler(data):
    """Called when a user reacts to a message in Telegram (http mode)."""
    chat = data.get("chat", {})
    user = data.get("user", {})
    msg_id = data.get("message_id")
    new_reactions = data.get("new_reaction", [])

    chat_id = chat.get("id")
    user_id = user.get("id")

    if not chat_id or not msg_id:
        return

    # Extract the emoji from new_reaction (Telegram: one reaction per user)
    emoji = None
    for r in new_reactions:
        if r.get("type") == "emoji":
            emoji = r.get("emoji")
            break

    reactor = str(user_id) if user_id else "unknown"
    rname = f"{user.get('first_name', '')} {user.get('last_name', '')}".strip() or reactor

    if emoji:
        await storage.add_reaction(chat_id, msg_id, emoji, reactor, rname)
    else:
        # User removed their reaction
        await storage.remove_reaction(chat_id, msg_id, reactor)

    msg = await storage.get_message_by_id(chat_id, msg_id)
    await _notify_ws({
        "type": "reaction_update",
        "user_id": chat_id,
        "msg_id": msg_id,
        "reactions": msg.get("reactions", {}) if msg else {},
        "reactor_names": msg.get("reactor_names", {}) if msg else {},
    })


def setup_handlers():
    if is_http_bot:
        bot.on_message(_http_bot_handler)
        bot.on_edit(_http_edit_handler)
        bot.on_reaction(_http_reaction_handler)
        print("[+] http bot handler registered")
    else:
        _setup_telethon_handlers()
        if not create_user_bot:
            print("[-] userbot disabled")
    print("[+] bot handler registered")
