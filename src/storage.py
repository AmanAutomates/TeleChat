"""
JSON file storage for users and messages.
Each user gets: data/chats/{FullName$$UserId}/messages.json + media/
Global user list: data/users.json
"""

import json
import shutil
from datetime import datetime
from pathlib import Path

import aiofiles

from src.config import chats_dir, users_file


class Storage:
    def __init__(self):
        self._users: dict = {}

    # users

    async def load_users(self):
        if users_file.exists():
            async with aiofiles.open(users_file, "r", encoding="utf-8") as f:
                raw = await f.read()
                self._users = json.loads(raw) if raw.strip() else {}
        return self._users

    async def _save_users(self):
        async with aiofiles.open(users_file, "w", encoding="utf-8") as f:
            await f.write(json.dumps(self._users, indent=2, ensure_ascii=False))

    async def update_user(self, user) -> dict:
        uid = str(user.id)
        first = user.first_name or ""
        last = user.last_name or ""
        full = f"{first} {last}".strip()
        folder = f"{full}$${uid}"

        if uid not in self._users:
            self._users[uid] = {
                "user_id": user.id,
                "first_name": first,
                "last_name": last,
                "username": user.username,
                "full_name": full,
                "folder_name": folder,
                "unread_count": 0,
            }
        else:
            self._users[uid].update(
                first_name=first, last_name=last,
                username=user.username, full_name=full,
            )

        self._users[uid]["last_seen"] = datetime.now().isoformat()

        user_dir = chats_dir / folder
        user_dir.mkdir(exist_ok=True)
        (user_dir / "media").mkdir(exist_ok=True)

        await self._save_users()
        return self._users[uid]

    def get_user_folder(self, user_id) -> Path | None:
        info = self._users.get(str(user_id))
        return chats_dir / info["folder_name"] if info else None

    def get_user(self, user_id) -> dict | None:
        return self._users.get(str(user_id))

    def get_all_users(self) -> dict:
        return self._users

    async def delete_user(self, user_id):
        folder = self.get_user_folder(user_id)
        if folder and folder.exists():
            shutil.rmtree(folder)
        self._users.pop(str(user_id), None)
        await self._save_users()

    # unread count

    async def increment_unread(self, user_id):
        info = self._users.get(str(user_id))
        if info:
            info["unread_count"] = info.get("unread_count", 0) + 1
            await self._save_users()

    async def clear_unread(self, user_id):
        info = self._users.get(str(user_id))
        if info:
            info["unread_count"] = 0
            await self._save_users()

    async def touch_interaction(self, user_id):
        """Record current time as last interaction for afk cooldown."""
        info = self._users.get(str(user_id))
        if info:
            info["last_interaction"] = datetime.now().isoformat()
            await self._save_users()

    # messages

    async def _read_msgs(self, path: Path) -> list:
        if path.exists():
            async with aiofiles.open(path, "r", encoding="utf-8") as f:
                raw = await f.read()
                return json.loads(raw) if raw.strip() else []
        return []

    async def _write_msgs(self, path: Path, msgs: list):
        async with aiofiles.open(path, "w", encoding="utf-8") as f:
            await f.write(json.dumps(msgs, indent=2, ensure_ascii=False))

    async def save_message(self, user_id, msg: dict):
        folder = self.get_user_folder(user_id)
        if not folder:
            return
        path = folder / "messages.json"
        msgs = await self._read_msgs(path)
        msgs.append(msg)
        await self._write_msgs(path, msgs)

    async def get_messages(self, user_id, offset=0, limit=30):
        folder = self.get_user_folder(user_id)
        if not folder:
            return [], 0
        msgs = await self._read_msgs(folder / "messages.json")
        total = len(msgs)
        start = max(0, total - offset - limit)
        end = total - offset
        return msgs[start:end], total

    async def get_all_messages(self, user_id) -> list:
        folder = self.get_user_folder(user_id)
        if not folder:
            return []
        return await self._read_msgs(folder / "messages.json")

    async def delete_messages(self, user_id, msg_ids: list):
        folder = self.get_user_folder(user_id)
        if not folder:
            return
        path = folder / "messages.json"
        msgs = await self._read_msgs(path)
        keep = []
        for m in msgs:
            if m["msg_id"] in msg_ids:
                if m.get("media_file"):
                    fp = folder / "media" / m["media_file"]
                    if fp.exists():
                        fp.unlink()
            else:
                keep.append(m)
        await self._write_msgs(path, keep)


storage = Storage()
