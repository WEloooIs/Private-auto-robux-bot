import asyncio
import json
import os
from logging import getLogger

import requests

logger = getLogger("playerok_webhook")

_cached_webhook = None
_proxy_server_started = False
_plbot_instance = None


def _load_webhook_config() -> dict:
    global _cached_webhook
    if _cached_webhook is not None:
        return _cached_webhook

    url = os.getenv("PLAYEROK_WEBHOOK_URL", "").strip()
    token = os.getenv("PLAYEROK_WEBHOOK_TOKEN", "").strip()

    if not url:
        config_path = os.path.join("bot_settings", "webhook.json")
        if os.path.exists(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                url = str(data.get("url", "")).strip()
                token = str(data.get("token", "")).strip()
            except Exception as exc:
                logger.error(f"Webhook config read failed: {exc}")

    _cached_webhook = {"url": url, "token": token}
    if url:
        logger.info(f"Webhook enabled: {url}")
    else:
        logger.warning("Webhook disabled: PLAYEROK_WEBHOOK_URL not set and bot_settings/webhook.json missing")
    return _cached_webhook


def _proxy_config() -> dict:
    data = _load_webhook_config()
    config_path = os.path.join("bot_settings", "webhook.json")
    port = 3201
    token = ""
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            port = int(cfg.get("proxy_port", port))
            token = str(cfg.get("proxy_token", "")).strip()
        except Exception as exc:
            logger.error(f"Proxy config read failed: {exc}")
    return {"port": port, "token": token, "url": data.get("url", "")}


def _webhook_url() -> str:
    return _load_webhook_config().get("url", "")


def _webhook_headers() -> dict:
    headers = {"Content-Type": "application/json"}
    token = _load_webhook_config().get("token", "").strip()
    if token:
        headers["x-webhook-token"] = token
    return headers


def _post_event(payload: dict):
    url = _webhook_url()
    if not url:
        logger.warning("Webhook URL not configured; skipping send")
        return
    try:
        response = requests.post(url, json=payload, headers=_webhook_headers(), timeout=5)
        logger.info(f"Webhook sent type={payload.get('type')} status={response.status_code}")
    except Exception as exc:
        logger.error(f"Webhook send failed: {exc}")


def _start_proxy_server():
    global _proxy_server_started
    if _proxy_server_started:
        return

    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading
    from playerokapi.enums import ItemDealStatuses

    cfg = _proxy_config()
    port = cfg["port"]
    token = cfg["token"]

    class Handler(BaseHTTPRequestHandler):
        def _unauthorized(self):
            self.send_response(401)
            self.end_headers()

        def _ok(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OK")

        def do_POST(self):
            if token:
                header_token = self.headers.get("X-Webhook-Token", "")
                if header_token != token:
                    return self._unauthorized()

            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
            try:
                data = json.loads(raw)
            except Exception:
                self.send_response(400)
                self.end_headers()
                return

            if self.path == "/send-message":
                chat_id = str(data.get("chat_id", "")).strip()
                text = str(data.get("text", "")).strip()
                if chat_id and text and _plbot_instance:
                    _plbot_instance.account.send_message(chat_id, text)
                    logger.info(f"Proxy send-message chat_id={chat_id}")
                    return self._ok()
                self.send_response(400)
                self.end_headers()
                return

            if self.path == "/complete-deal":
                deal_id = str(data.get("deal_id", "")).strip()
                if deal_id and _plbot_instance:
                    try:
                        _plbot_instance.account.update_deal(deal_id, ItemDealStatuses.SENT)
                        logger.info(f"Proxy complete-deal deal_id={deal_id}")
                    except Exception as exc:
                        logger.warning(f"Proxy complete-deal failed deal_id={deal_id}: {exc}")
                    return self._ok()
                self.send_response(400)
                self.end_headers()
                return

            self.send_response(404)
            self.end_headers()

        def log_message(self, format, *args):
            return

    server = HTTPServer(("0.0.0.0", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    logger.info(f"Proxy server listening on :{port}")
    _proxy_server_started = True


async def _send_async(payload: dict):
    await asyncio.to_thread(_post_event, payload)


def _extract_chat_id(event) -> str | None:
    chat = getattr(event, "chat", None)
    if chat and getattr(chat, "id", None):
        return str(chat.id)
    deal = getattr(event, "deal", None)
    if deal and getattr(deal, "chat", None) and getattr(deal.chat, "id", None):
        return str(deal.chat.id)
    return None


def _deal_payload(event) -> dict:
    deal = getattr(event, "deal", None)
    item = getattr(deal, "item", None) if deal else None
    item_name = getattr(item, "name", None) if item else None
    amount_robux = _extract_robux_amount(item_name) if item_name else None
    return {
        "deal_id": str(getattr(deal, "id", "")) if deal else None,
        "chat_id": _extract_chat_id(event),
        "amount_robux": amount_robux,
        "product_id": str(getattr(item, "id", "")) if item else None,
        "offer_url": None,
        "item_name": item_name,
    }


def _message_payload(event) -> dict:
    message = getattr(event, "message", None)
    text = getattr(message, "text", None)
    deal = getattr(message, "deal", None)
    item = getattr(message, "item", None)

    if not deal and _plbot_instance:
        chat_id = _extract_chat_id(event)
        if chat_id:
            try:
                chat = _plbot_instance.account.get_chat(chat_id)
                deals = getattr(chat, "deals", None) or []
                if deals:
                    deal = deals[0]
                    item = getattr(deal, "item", None)
            except Exception as exc:
                logger.error(f"Failed to resolve deal from chat {chat_id}: {exc}")

    if not deal and _plbot_instance:
        chat_id = _extract_chat_id(event)
        if chat_id:
            try:
                from playerokapi.enums import ItemDealDirections
                deals_page = _plbot_instance.account.get_deals(
                    count=24,
                    direction=ItemDealDirections.IN
                )
                for d in getattr(deals_page, "deals", []) or []:
                    deal_chat = getattr(d, "chat", None)
                    if deal_chat and str(getattr(deal_chat, "id", "")) == str(chat_id):
                        deal = d
                        item = getattr(d, "item", None)
                        break
            except Exception as exc:
                logger.error(f"Failed to resolve deal via get_deals for chat {chat_id}: {exc}")

    if deal and not item and _plbot_instance:
        try:
            full = _plbot_instance.account.get_deal(str(getattr(deal, "id", "")))
            item = getattr(full, "item", None)
            deal = full
        except Exception as exc:
            logger.error(f"Failed to resolve deal item for deal {getattr(deal, 'id', '')}: {exc}")

    payload = {
        "chat_id": _extract_chat_id(event),
        "text": text,
        "message": text,
        "deal_id": str(getattr(deal, "id", "")) if deal else None,
        "amount_robux": _extract_robux_amount(getattr(item, "name", None)) if item else None,
        "product_id": str(getattr(item, "id", "")) if item else None,
        "item_name": getattr(item, "name", None) if item else None,
    }
    return payload


def _extract_robux_amount(name: str | None) -> int | None:
    if not name:
        return None
    import re
    match = re.search(r"(\d{1,6})\s*(robux|rbx|робук)", name, re.IGNORECASE)
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            return None
    return None


async def on_new_deal(plbot, event):
    await _send_async(
        {
            "type": "NEW_DEAL",
            "payload": _deal_payload(event),
        }
    )


async def on_item_paid(plbot, event):
    await _send_async(
        {
            "type": "ITEM_PAID",
            "payload": _deal_payload(event),
        }
    )


async def on_new_message(plbot, event):
    await _send_async(
        {
            "type": "NEW_MESSAGE",
            "payload": _message_payload(event),
        }
    )


async def on_deal_status_changed(plbot, event):
    deal = getattr(event, "deal", None)
    status = getattr(deal, "status", None)
    if status is None:
        return

    # Если NEW_DEAL не приходит, пробуем создавать заказ по смене статуса на PAID/PENDING.
    if getattr(status, "name", "") in ("PAID", "PENDING"):
        await _send_async(
            {
                "type": "NEW_DEAL",
                "payload": _deal_payload(event),
            }
        )


async def on_playerok_bot_init(plbot):
    global _plbot_instance
    _plbot_instance = plbot
    _start_proxy_server()
