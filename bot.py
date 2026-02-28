"""Entry point. Starts the bot (and optionally userbot), then the web server."""

import asyncio
import signal
import sys

from aiohttp import web

from src.config import web_host, web_port, bot_token, phone_number, create_user_bot
from src.clients import userbot, bot, is_http_bot
from src.handlers import setup_handlers
from src.storage import storage
from src.server import create_app


async def main():
    await storage.init()
    await storage.load_users()
    print("[+] storage loaded")

    setup_handlers()

    # start clients
    if is_http_bot:
        print("[...] connecting bot (http mode)")
        bot_me = await bot.start()
        print(f"[+] bot connected as @{bot_me.username}")
    else:
        if create_user_bot and userbot is not None:
            print("[...] connecting userbot")
            await userbot.start(phone=phone_number)
            me = await userbot.get_me()
            print(f"[+] userbot connected as {me.first_name} (@{me.username})")

        print("[...] connecting bot (telethon)")
        await bot.start(bot_token=bot_token)
        bot_me = await bot.get_me()
        print(f"[+] bot connected as @{bot_me.username}")

    # start web server
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()

    try:
        site = web.TCPSite(runner, web_host, web_port)
        await site.start()
    except OSError as exc:
        if "address already in use" in str(exc).lower() or "10048" in str(exc):
            print(f"\n[x] port {web_port} is already in use!")
            print(f"    kill the other process or change WEB_PORT in .env")
            print(f"    to find it: netstat -ano | findstr :{web_port}")
            await _cleanup(runner)
            return
        raise

    mode = "bot-only (http)" if is_http_bot else (
        "userbot + bot (telethon)" if create_user_bot else "bot-only (telethon)")
    bot_name = getattr(bot_me, 'first_name', '') or getattr(bot_me, 'username', 'Bot')

    print()
    print("=" * 52)
    print(f"   {bot_name} is live!")
    print(f"   chat ui  ->  http://{web_host}:{web_port}")
    print(f"   mode     ->  {mode}")
    print("   press ctrl+c to stop")
    print("=" * 52)
    print()

    poll_task = None
    if is_http_bot:
        poll_task = asyncio.create_task(bot.start_polling())

    stop = asyncio.Event()

    def _signal_handler():
        print("\n[...] shutting down")
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal_handler)
        except NotImplementedError:
            pass

    try:
        await stop.wait()
    except KeyboardInterrupt:
        print("\n[...] shutting down")
    finally:
        if poll_task:
            poll_task.cancel()
            try:
                await poll_task
            except asyncio.CancelledError:
                pass
        await _cleanup(runner)
        print("[+] stopped.")


async def _cleanup(runner):
    await runner.cleanup()
    if userbot is not None:
        await userbot.disconnect()
    await bot.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
