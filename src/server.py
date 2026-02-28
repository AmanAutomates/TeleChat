"""aiohttp web server with REST API, WebSocket, and static files."""

import json
import mimetypes
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

import aiohttp
from aiohttp import web

from src.clients import bot, is_http_bot
from src.config import messages_per_load, base_dir, data_dir
from src.handlers import ws_clients, _notify_ws
from src.storage import storage

# register missing mimetypes
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("video/webm", ".webm")
mimetypes.add_type("application/x-tgsticker", ".tgs")

web_dir = base_dir / "web"
avatar_dir = data_dir / "avatars"
avatar_dir.mkdir(exist_ok=True)

_bot_info_cache: dict | None = None


# static / index

async def index(request):
    return web.FileResponse(web_dir / "index.html")


async def static_handler(request):
    rel = request.match_info.get("path", "")
    fp = web_dir / rel
    if fp.exists() and fp.is_file():
        return web.FileResponse(fp)
    raise web.HTTPNotFound()


# rest api

async def api_get_users(request):
    from src.config import banned_users
    users = storage.get_all_users()
    result = []
    for uid, u in users.items():
        msgs, _ = await storage.get_messages(uid, offset=0, limit=1)
        last = msgs[0] if msgs else None
        result.append({**u, "last_message": last, "is_banned": int(uid) in banned_users})
    result.sort(key=lambda x: x.get("last_seen", ""), reverse=True)
    return web.json_response(result)


async def api_get_messages(request):
    uid = request.match_info["user_id"]
    offset = int(request.query.get("offset", 0))
    limit = int(request.query.get("limit", messages_per_load))
    msgs, total = await storage.get_messages(uid, offset, limit)
    return web.json_response({
        "messages": msgs, "total": total,
        "offset": offset, "limit": limit,
        "has_more": (offset + limit) < total,
    })


async def api_send_message(request):
    data = await request.json()
    uid = int(data["user_id"])
    text = data.get("text", "")
    reply_to = data.get("reply_to")

    try:
        sent = await bot.send_message(uid, text, reply_to=reply_to)
        msg_data = {
            "msg_id": sent.id,
            "direction": "out",
            "text": text,
            "timestamp": datetime.now().isoformat(),
            "media_type": None, "media_file": None,
            "reply_to": reply_to,
            "forwarded_from": None,
            "forwarded_from_username": None,
            "source": "bot",
        }
        await storage.save_message(uid, msg_data)
        await _notify_ws({"type": "message_sent", "user_id": uid, "message": msg_data})
        return web.json_response({"status": "ok", "message": msg_data})
    except Exception as exc:
        return web.json_response({"status": "error", "error": str(exc)}, status=500)


async def api_upload(request):
    reader = await request.multipart()
    uid = reply_to = None
    caption = ""
    file_data = file_name = None

    async for part in reader:
        if part.name == "user_id":
            uid = int(await part.text())
        elif part.name == "reply_to":
            v = await part.text()
            reply_to = int(v) if v else None
        elif part.name == "caption":
            caption = await part.text()
        elif part.name == "file":
            file_name = part.filename
            file_data = await part.read()

    if not uid or not file_data:
        return web.json_response({"status": "error", "error": "missing data"}, status=400)

    tmp = Path(tempfile.mkdtemp()) / file_name
    tmp.write_bytes(file_data)

    try:
        sent = await bot.send_file(uid, str(tmp), caption=caption or None, reply_to=reply_to)

        ext = Path(file_name).suffix
        media_file = f"{sent.id}{ext}"
        folder = storage.get_user_folder(uid)
        if folder:
            (folder / "media").mkdir(exist_ok=True)
            shutil.copy2(str(tmp), str(folder / "media" / media_file))

        mime, _ = mimetypes.guess_type(file_name)
        mime = mime or ""
        if mime.startswith("image"):
            mt = "photo"
        elif mime.startswith("video"):
            mt = "video"
        elif mime.startswith("audio"):
            mt = "audio"
        else:
            mt = "document"

        msg_data = {
            "msg_id": sent.id, "direction": "out",
            "text": caption, "timestamp": datetime.now().isoformat(),
            "media_type": mt, "media_file": media_file,
            "reply_to": reply_to,
            "forwarded_from": None, "forwarded_from_username": None,
            "source": "bot",
        }
        await storage.save_message(uid, msg_data)
        await _notify_ws({"type": "message_sent", "user_id": uid, "message": msg_data})
        return web.json_response({"status": "ok", "message": msg_data})
    except Exception as exc:
        return web.json_response({"status": "error", "error": str(exc)}, status=500)
    finally:
        shutil.rmtree(tmp.parent, ignore_errors=True)


async def api_delete_messages(request):
    data = await request.json()
    uid = data["user_id"]
    ids = data["msg_ids"]
    for_everyone = data.get("for_everyone", True)

    if for_everyone:
        try:
            await bot.delete_messages(int(uid), ids)
        except Exception as exc:
            print(f"[tg delete] {exc}")
            return web.json_response({"status": "error", "error": f"Failed to delete in Telegram: {exc}"}, status=400)

    await storage.delete_messages(uid, ids)
    await _notify_ws({"type": "messages_deleted", "user_id": int(uid), "msg_ids": ids, "for_everyone": for_everyone})
    return web.json_response({"status": "ok"})


async def api_forward_messages(request):
    data = await request.json()
    from_uid = int(data["from_user_id"])
    to_uids = [int(x) for x in data["to_user_ids"]]
    msg_ids = data["msg_ids"]

    all_msgs = await storage.get_all_messages(from_uid)
    to_fwd = [m for m in all_msgs if m["msg_id"] in msg_ids]

    from_user = storage.get_user(from_uid)
    label = f"@{from_user['username']}" if from_user.get("username") else from_user.get("full_name", "Unknown")

    results = []
    folder = storage.get_user_folder(from_uid)

    for tid in to_uids:
        for m in to_fwd:
            text = m.get("text", "")
            fwd_text = f"↗️ Forwarded from {label}\n\n{text}"
            try:
                if m.get("media_file") and folder:
                    mp = folder / "media" / m["media_file"]
                    if mp.exists():
                        sent = await bot.send_file(tid, str(mp), caption=fwd_text or None)
                    else:
                        sent = await bot.send_message(tid, fwd_text)
                else:
                    sent = await bot.send_message(tid, fwd_text)

                md = {
                    "msg_id": sent.id, "direction": "out",
                    "text": fwd_text, "timestamp": datetime.now().isoformat(),
                    "media_type": m.get("media_type"), "media_file": None,
                    "reply_to": None,
                    "forwarded_from": label,
                    "forwarded_from_username": from_user.get("username"),
                    "source": "bot",
                }
                await storage.save_message(tid, md)
                await _notify_ws({"type": "message_sent", "user_id": tid, "message": md})
                results.append({"to": tid, "msg_id": sent.id, "status": "ok"})
            except Exception as exc:
                results.append({"to": tid, "error": str(exc), "status": "error"})

    return web.json_response({"status": "ok", "results": results})


async def api_clear_unread(request):
    data = await request.json()
    await storage.clear_unread(data["user_id"])
    return web.json_response({"status": "ok"})


async def api_media(request):
    uid = request.match_info["user_id"]
    fname = request.match_info["filename"]
    folder = storage.get_user_folder(uid)
    if not folder:
        raise web.HTTPNotFound()
    fp = folder / "media" / fname
    if not fp.exists():
        raise web.HTTPNotFound()
    ct, _ = mimetypes.guess_type(fname)
    if not ct:
        ct = "application/octet-stream"
    return web.Response(body=fp.read_bytes(), content_type=ct)


async def api_bot_info(request):
    """Return the bot's display name and username."""
    global _bot_info_cache
    if not _bot_info_cache:
        me = await bot.get_me()
        _bot_info_cache = {
            "name": getattr(me, 'first_name', '') or 'Bot',
            "username": getattr(me, 'username', '') or '',
        }
    return web.json_response(_bot_info_cache)


async def api_avatar(request):
    """Serve cached user profile photo."""
    uid = request.match_info["user_id"]
    cached = avatar_dir / f"{uid}.jpg"

    if not cached.exists():
        if is_http_bot:
            ok = await bot.get_user_profile_photo(int(uid), str(cached))
        else:
            try:
                result = await bot.download_profile_photo(int(uid), file=str(cached))
                ok = result is not None
            except Exception:
                ok = False
        if not ok:
            raise web.HTTPNotFound()

    return web.FileResponse(cached)


# ── reactions API ──────────────────────────────────────
async def api_add_reaction(request):
    """React to a message — also sends the reaction to Telegram."""
    data = await request.json()
    uid = int(data["user_id"])
    msg_id = int(data["msg_id"])
    emoji = data["emoji"]

    msg = await storage.get_message_by_id(uid, msg_id)
    current_my_reaction = None
    if msg and "reactions" in msg:
        current_my_reaction = msg["reactions"].get("me")

    # Determine what to send to Telegram
    try:
        if current_my_reaction == emoji:
            # Was toggled off — clear the bot's reaction on Telegram
            await bot.set_reaction(uid, msg_id, emoji=None)
            await storage.remove_reaction(uid, msg_id, "me")
        else:
            # Set the reaction on Telegram
            await bot.set_reaction(uid, msg_id, emoji=emoji)
            await storage.add_reaction(uid, msg_id, emoji, "me")
    except Exception as exc:
        print(f"[api_react] Failed: {exc}")
        return web.json_response({"status": "error", "error": str(exc)}, status=400)

    # Notify web UI
    msg = await storage.get_message_by_id(uid, msg_id)
    await _notify_ws({
        "type": "reaction_update",
        "user_id": uid,
        "msg_id": msg_id,
        "reactions": msg.get("reactions", {}) if msg else {},
    })
    return web.json_response({"status": "ok"})


async def api_remove_reaction(request):
    """Remove the bot's reaction from a message."""
    data = await request.json()
    uid = int(data["user_id"])
    msg_id = int(data["msg_id"])

    try:
        await bot.set_reaction(uid, msg_id, emoji=None)
        await storage.remove_reaction(uid, msg_id, "me")
    except Exception as exc:
        print(f"[api_unreact] Failed: {exc}")
        return web.json_response({"status": "error", "error": str(exc)}, status=400)

    msg = await storage.get_message_by_id(uid, msg_id)
    await _notify_ws({
        "type": "reaction_update",
        "user_id": uid,
        "msg_id": msg_id,
        "reactions": msg.get("reactions", {}) if msg else {},
    })
    return web.json_response({"status": "ok"})


# ── admin actions API ──────────────────────────────────
async def api_ban_member(request):
    data = await request.json()
    chat_id = int(data["chat_id"])
    user_id = int(data["user_id"])
    try:
        await bot.ban_member(chat_id, user_id)
        return web.json_response({"status": "ok"})
    except Exception as exc:
        return web.json_response({"status": "error", "error": str(exc)}, status=400)

async def api_unban_member(request):
    data = await request.json()
    chat_id = int(data["chat_id"])
    user_id = int(data["user_id"])
    try:
        await bot.unban_member(chat_id, user_id)
        return web.json_response({"status": "ok"})
    except Exception as exc:
        return web.json_response({"status": "error", "error": str(exc)}, status=400)

async def api_pin_message(request):
    data = await request.json()
    chat_id = int(data["chat_id"])
    msg_id = int(data["msg_id"])
    try:
        await bot.pin_message(chat_id, msg_id)
        return web.json_response({"status": "ok"})
    except Exception as exc:
        return web.json_response({"status": "error", "error": str(exc)}, status=400)

async def api_unpin_message(request):
    data = await request.json()
    chat_id = int(data["chat_id"])
    msg_id = int(data["msg_id"])
    try:
        await bot.unpin_message(chat_id, msg_id)
        return web.json_response({"status": "ok"})
    except Exception as exc:
        return web.json_response({"status": "error", "error": str(exc)}, status=400)

from src.config import update_banned_users

async def api_block_user(request):
    data = await request.json()
    user_id = data["user_id"]
    from src.config import update_banned_users
    update_banned_users(user_id, block=True)
    return web.json_response({"status": "ok"})

async def api_unblock_user(request):
    data = await request.json()
    user_id = data["user_id"]
    from src.config import update_banned_users
    update_banned_users(user_id, block=False)
    return web.json_response({"status": "ok"})

async def api_leave_group(request):
    data = await request.json()
    chat_id = int(data["chat_id"])
    try:
        await bot.leave_chat(chat_id)
        return web.json_response({"status": "ok"})
    except Exception as exc:
        return web.json_response({"status": "error", "error": str(exc)}, status=400)


async def api_group_info(request):
    chat_id = int(request.match_info["chat_id"])
    
    # Get active members from local DB
    msgs = storage._users.get(str(chat_id))
    active = {}
    if msgs:
        all_m = await storage.get_all_messages(chat_id)
        for m in all_m:
            sid = m.get("sender_id")
            if sid:
                active[str(sid)] = m.get("sender_name", f"User {sid}")

    count = 0
    admins = []
    try:
        count = await bot.get_chat_member_count(chat_id)
        admins = await bot.get_chat_administrators(chat_id)
    except Exception as e:
        print(f"[api_group_info] {e}")
        pass
        
    return web.json_response({
        "status": "ok", 
        "member_count": count, 
        "admins": admins,
        "active_members": [{"id": k, "name": v} for k, v in active.items()]
    })


# ── edit history API ───────────────────────────────────
async def api_edit_message(request):
    """Edit a sent message's text. Old text is saved in edit_history."""
    data = await request.json()
    uid = int(data["user_id"])
    msg_id = int(data["msg_id"])
    new_text = data["text"]

    await storage.edit_message(uid, msg_id, new_text)

    # Also edit on Telegram (best effort)
    try:
        await bot.edit_message(uid, msg_id, new_text)
    except Exception as exc:
        print(f"[tg edit] {exc}")

    msg = await storage.get_message_by_id(uid, msg_id)
    await _notify_ws({
        "type": "message_edited",
        "user_id": uid,
        "msg_id": msg_id,
        "message": msg,
    })
    return web.json_response({"status": "ok", "message": msg})


async def api_get_edit_history(request):
    """Return edit history for a message."""
    uid = request.match_info["user_id"]
    msg_id = int(request.match_info["msg_id"])
    msg = await storage.get_message_by_id(uid, msg_id)
    history = msg.get("edit_history", []) if msg else []
    return web.json_response({"edit_history": history})


# websocket

async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    ws_clients.add(ws)
    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.ERROR:
                break
    finally:
        ws_clients.discard(ws)
    return ws


# app factory

def create_app():
    app = web.Application(client_max_size=50 * 1024 * 1024)

    app.router.add_get("/api/bot-info", api_bot_info)
    app.router.add_get("/api/avatar/{user_id}", api_avatar)
    app.router.add_get("/api/users", api_get_users)
    app.router.add_get("/api/messages/{user_id}", api_get_messages)
    app.router.add_post("/api/send", api_send_message)
    app.router.add_post("/api/upload", api_upload)
    app.router.add_delete("/api/messages", api_delete_messages)
    app.router.add_post("/api/forward", api_forward_messages)
    app.router.add_post("/api/clear-unread", api_clear_unread)
    app.router.add_get("/api/media/{user_id}/{filename:.*}", api_media)

    # reactions
    app.router.add_post("/api/react", api_add_reaction)
    app.router.add_post("/api/unreact", api_remove_reaction)

    # edit
    app.router.add_post("/api/edit-message", api_edit_message)
    app.router.add_get("/api/edit-history/{user_id}/{msg_id}", api_get_edit_history)

    # admin actions
    app.router.add_post("/api/ban", api_ban_member)
    app.router.add_post("/api/unban", api_unban_member)
    app.router.add_post("/api/pin", api_pin_message)
    app.router.add_post("/api/unpin", api_unpin_message)
    app.router.add_post("/api/block", api_block_user)
    app.router.add_post("/api/unblock", api_unblock_user)
    app.router.add_post("/api/leave", api_leave_group)
    app.router.add_get("/api/group-info/{chat_id}", api_group_info)

    app.router.add_get("/ws", websocket_handler)

    app.router.add_get("/", index)
    app.router.add_get("/static/{path:.*}", static_handler)

    return app
