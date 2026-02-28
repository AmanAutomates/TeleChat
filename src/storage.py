"""
SQLite database storage for users and messages using aiosqlite.
Messages are stored as JSON blobs in a hyper-fast indexed SQLite database.
Media still goes to: data/chats/{folder_name}/media/
"""

import json
import shutil
from datetime import datetime
from pathlib import Path

import aiosqlite

from src.config import data_dir, chats_dir

db_path = data_dir / "telechat.db"


class Storage:
    def __init__(self):
        self._users: dict = {}

    async def init(self):
        """Must be called on startup to create tables if they do not exist."""
        # Enable WAL via synchronous driver before async connections to prevent locking deadlocks
        import sqlite3
        raw_db = sqlite3.connect(db_path, isolation_level=None)
        raw_db.execute("PRAGMA journal_mode=WAL;")
        raw_db.close()
        
        async with aiosqlite.connect(db_path, timeout=30.0) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    first_name TEXT,
                    last_name TEXT,
                    username TEXT,
                    full_name TEXT,
                    type TEXT,
                    folder_name TEXT,
                    unread_count INTEGER DEFAULT 0,
                    last_seen TEXT,
                    last_interaction TEXT
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    msg_id INTEGER,
                    chat_id TEXT,
                    direction TEXT,
                    timestamp TEXT,
                    payload TEXT,
                    PRIMARY KEY (msg_id, chat_id)
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_id, timestamp)")
            await db.commit()

    async def load_users(self):
        """Load users into memory cache on startup."""
        self._users = {}
        async with aiosqlite.connect(db_path, timeout=30.0) as db:
            async with db.execute("SELECT * FROM users") as cursor:
                columns = [col[0] for col in cursor.description]
                for row in await cursor.fetchall():
                    user_dict = dict(zip(columns, row))
                    self._users[user_dict["user_id"]] = user_dict
        return self._users

    async def _save_user_to_db(self, uid):
        """Push memory user dict to SQL."""
        user = self._users[uid]
        async with aiosqlite.connect(db_path, timeout=30.0) as db:
            await db.execute("""
                INSERT INTO users (user_id, first_name, last_name, username, full_name, type, folder_name, unread_count, last_seen, last_interaction)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET 
                    first_name=excluded.first_name,
                    last_name=excluded.last_name,
                    username=excluded.username,
                    full_name=excluded.full_name,
                    type=excluded.type,
                    folder_name=excluded.folder_name,
                    unread_count=excluded.unread_count,
                    last_seen=excluded.last_seen,
                    last_interaction=excluded.last_interaction
            """, (
                uid, user.get("first_name"), user.get("last_name"), user.get("username"),
                user.get("full_name"), user.get("type"), user.get("folder_name"),
                user.get("unread_count", 0), user.get("last_seen"), user.get("last_interaction")
            ))
            await db.commit()

    async def update_user(self, user) -> dict:
        uid = str(user.id)
        if hasattr(user, 'title') and user.title:
            full = user.title
            first = user.title
            last = ""
        else:
            first = getattr(user, 'first_name', '') or ""
            last = getattr(user, 'last_name', '') or ""
            full = f"{first} {last}".strip()
        folder = uid

        if uid not in self._users:
            self._users[uid] = {
                "user_id": uid,
                "first_name": first,
                "last_name": last,
                "username": getattr(user, 'username', ''),
                "full_name": full,
                "type": getattr(user, 'type', 'private'),
                "folder_name": folder,
                "unread_count": 0,
            }
        else:
            old_folder = self._users[uid].get("folder_name", "")
            if old_folder != folder:
                old_dir = chats_dir / old_folder
                new_dir = chats_dir / folder
                if old_dir.exists() and not new_dir.exists():
                    old_dir.rename(new_dir)
                self._users[uid]["folder_name"] = folder

            self._users[uid].update(
                first_name=first, last_name=last,
                username=getattr(user, 'username', ''), full_name=full,
                type=getattr(user, 'type', 'private')
            )

        self._users[uid]["last_seen"] = datetime.now().isoformat()

        user_dir = chats_dir / folder
        user_dir.mkdir(parents=True, exist_ok=True)
        (user_dir / "media").mkdir(exist_ok=True)

        await self._save_user_to_db(uid)
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
            shutil.rmtree(folder, ignore_errors=True)
        self._users.pop(str(user_id), None)
        async with aiosqlite.connect(db_path, timeout=30.0) as db:
            await db.execute("DELETE FROM users WHERE user_id = ?", (str(user_id),))
            await db.execute("DELETE FROM messages WHERE chat_id = ?", (str(user_id),))
            await db.commit()

    # unread count
    async def increment_unread(self, user_id):
        info = self._users.get(str(user_id))
        if info:
            info["unread_count"] = info.get("unread_count", 0) + 1
            await self._save_user_to_db(str(user_id))

    async def clear_unread(self, user_id):
        info = self._users.get(str(user_id))
        if info:
            info["unread_count"] = 0
            await self._save_user_to_db(str(user_id))

    async def touch_interaction(self, user_id):
        info = self._users.get(str(user_id))
        if info:
            info["last_interaction"] = datetime.now().isoformat()
            await self._save_user_to_db(str(user_id))


    # messages
    async def save_message(self, user_id, msg: dict):
        uid = str(user_id)
        async with aiosqlite.connect(db_path, timeout=30.0) as db:
            await db.execute("""
                INSERT INTO messages (msg_id, chat_id, direction, timestamp, payload)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(msg_id, chat_id) DO UPDATE SET 
                    direction=excluded.direction,
                    timestamp=excluded.timestamp,
                    payload=excluded.payload
            """, (
                msg["msg_id"], uid, msg.get("direction"), msg.get("timestamp"), json.dumps(msg)
            ))
            await db.commit()

    async def get_messages(self, user_id, offset=0, limit=30):
        uid = str(user_id)
        async with aiosqlite.connect(db_path, timeout=30.0) as db:
            # Count total
            async with db.execute("SELECT COUNT(*) FROM messages WHERE chat_id = ?", (uid,)) as cursor:
                total = (await cursor.fetchone())[0]
            
            # Fetch slice (oldest first logic) by querying latest N sorted by time DESC, then reverse
            # Wait, the frontend wants N messages offset by user scroll.
            # Assuming offset 0 means the newest 30 messages.
            # "SELECT payload FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?"
            async with db.execute(
                "SELECT payload FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?", 
                (uid, limit, offset)
            ) as cursor:
                rows = await cursor.fetchall()
                # we need to reverse rows so they return in chronological order [oldest ... newest]
                msgs = [json.loads(r[0]) for r in reversed(rows)]
                
        return msgs, total

    async def get_all_messages(self, user_id) -> list:
        uid = str(user_id)
        async with aiosqlite.connect(db_path, timeout=30.0) as db:
            async with db.execute("SELECT payload FROM messages WHERE chat_id = ? ORDER BY timestamp ASC", (uid,)) as cursor:
                rows = await cursor.fetchall()
                return [json.loads(r[0]) for r in rows]

    async def get_message_by_id(self, user_id, msg_id) -> dict | None:
        uid, mid = str(user_id), msg_id
        async with aiosqlite.connect(db_path, timeout=30.0) as db:
            async with db.execute("SELECT payload FROM messages WHERE chat_id = ? AND msg_id = ?", (uid, mid)) as cursor:
                row = await cursor.fetchone()
                if row:
                    return json.loads(row[0])
        return None

    async def get_chat_id_by_msg_id(self, msg_id) -> str | None:
        async with aiosqlite.connect(db_path, timeout=30.0) as db:
            async with db.execute("SELECT chat_id FROM messages WHERE msg_id = ?", (msg_id,)) as cursor:
                row = await cursor.fetchone()
                return str(row[0]) if row else None



    async def delete_messages(self, user_id, msg_ids: list):
        uid = str(user_id)
        
        # We must physically delete media if present, so we first fetch payloads 
        # before wiping the rows from SQL.
        folder = self.get_user_folder(uid)
        
        async with aiosqlite.connect(db_path, timeout=30.0) as db:
            if folder:
                for mid in msg_ids:
                    async with db.execute("SELECT payload FROM messages WHERE chat_id = ? AND msg_id = ?", (uid, mid)) as cursor:
                        row = await cursor.fetchone()
                        if row:
                            msg = json.loads(row[0])
                            if msg.get("media_file"):
                                fp = folder / "media" / msg["media_file"]
                                if fp.exists():
                                    fp.unlink()
            
            # Now wipe rows
            placeholders = ",".join("?" for _ in msg_ids)
            await db.execute(f"DELETE FROM messages WHERE chat_id = ? AND msg_id IN ({placeholders})", [uid] + msg_ids)
            await db.commit()

    async def add_reaction(self, user_id, msg_id, emoji, reactor="me", reactor_name=None):
        uid = str(user_id)
        m = await self.get_message_by_id(uid, msg_id)
        if not m:
            return
            
        if "reactions" not in m:
            m["reactions"] = {}
        if "reactor_names" not in m:
            m["reactor_names"] = {}
            
        current = m["reactions"].get(str(reactor))
        if current == emoji:
            del m["reactions"][str(reactor)]
            m["reactor_names"].pop(str(reactor), None)
        else:
            m["reactions"][str(reactor)] = emoji
            if reactor_name:
                m["reactor_names"][str(reactor)] = reactor_name
                
        if not m["reactions"]:
            m.pop("reactions", None)
            m.pop("reactor_names", None)
            
        await self.save_message(uid, m)

    async def remove_reaction(self, user_id, msg_id, reactor="me"):
        uid = str(user_id)
        m = await self.get_message_by_id(uid, msg_id)
        if not m:
            return
            
        if "reactions" in m:
            m["reactions"].pop(str(reactor), None)
            if "reactor_names" in m:
                m["reactor_names"].pop(str(reactor), None)
            if not m["reactions"]:
                m.pop("reactions", None)
                m.pop("reactor_names", None)
            await self.save_message(uid, m)

    async def edit_message(self, user_id, msg_id, new_text):
        uid = str(user_id)
        m = await self.get_message_by_id(uid, msg_id)
        if not m:
            return
            
        if "edit_history" not in m:
            m["edit_history"] = []
        m["edit_history"].append({
            "text": m.get("text", ""),
            "edited_at": datetime.now().isoformat(),
        })
        m["text"] = new_text
        m["edited"] = True
        
        await self.save_message(uid, m)


storage = Storage()
