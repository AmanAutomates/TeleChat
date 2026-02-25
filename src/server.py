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
    users = storage.get_all_users()
    result = []
    for uid, u in users.items():
        folder = storage.get_user_folder(uid)
        last = None
        if folder:
            msgs = await storage._read_msgs(folder / "messages.json")
            if msgs:
                last = msgs[-1]
        result.append({**u, "last_message": last})
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

    # try to delete from telegram (best effort, may fail for old msgs)
    try:
        await bot.delete_messages(int(uid), ids)
    except Exception as exc:
        print(f"[tg delete] {exc}")

    await storage.delete_messages(uid, ids)
    await _notify_ws({"type": "messages_deleted", "user_id": int(uid), "msg_ids": ids})
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
    return web.FileResponse(fp)


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

    app.router.add_get("/ws", websocket_handler)

    app.router.add_get("/", index)
    app.router.add_get("/static/{path:.*}", static_handler)

    return app
