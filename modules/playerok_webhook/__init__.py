from logging import getLogger

from playerokapi.enums import EventTypes
from core.modules import Module

from .plbot.handlers import on_new_deal, on_item_paid, on_new_message, on_playerok_bot_init, on_deal_status_changed
from .meta import *

logger = getLogger(NAME)
_module: Module | None = None


def set_module(new: Module):
    global _module
    _module = new


def get_module():
    return _module


async def on_module_enabled(module: Module):
    set_module(module)
    logger.info(f"{PREFIX} модуль подключен и активен")


BOT_EVENT_HANDLERS = {
    "ON_MODULE_ENABLED": [on_module_enabled],
    "ON_PLAYEROK_BOT_INIT": [on_playerok_bot_init],
}
PLAYEROK_EVENT_HANDLERS = {
    EventTypes.NEW_MESSAGE: [on_new_message],
    EventTypes.NEW_DEAL: [on_new_deal],
    EventTypes.ITEM_PAID: [on_item_paid],
    EventTypes.DEAL_STATUS_CHANGED: [on_deal_status_changed],
}
