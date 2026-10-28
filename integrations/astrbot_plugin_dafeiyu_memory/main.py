# Makes an AstrBot bot the same 大肥鱼 as the desktop pet.
# The pet (AI 设置 → 人格和记忆存在哪 → 文件夹) and this plugin read and write the same files in one folder:
#   人设.md         the persona, used as the bot's persona in every chat
#   记忆.json       things the owner told her
#   聊天记录.json    the recent chat with the owner, on every computer and here
#   陪伴状态.json    which day they first met, days in a row, when and where they saw each other today and last
# Everything except the persona is only used, and only added to, in the owner's private chat.
import json
import os
import random
import re
import time
from datetime import date, datetime

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import LLMResponse, ProviderRequest
from astrbot.api.star import Context, Star, register
import astrbot.api.message_components as Comp

PERSONA_FILE = "人设.md"
MEMORY_FILE = "记忆.json"
CHAT_FILE = "聊天记录.json"
STATE_FILE = "陪伴状态.json"
MAX_NOTES = 120
MAX_MSGS = 200
RECENT = 12        # how many messages from the pet to show her
FROM = "AstrBot"
TAG = re.compile(r"<memory>([\s\S]*?)</memory>")
# same wording the pet uses, so both sides write memories the same way
MEMORY_RULE = (
    "当用户告诉你关于他自己、值得长期记住的信息（名字、喜好、习惯、重要安排等）时，在回复最后另起一行写 "
    "<memory>要记住的一句话</memory>，用户看不到这一行；已经记住的不要重复记，不要记临时的小事。"
)
NOTE = "大肥鱼的共享记忆。桌宠和 AstrBot 插件都会读写这个文件；可以直接改，一条记忆一项，text 是内容，from 是在哪边记下的。"
FOLLOW_UP = "看看你们最近的聊天里他说过要去做什么（比如去吃饭、去开会、出门），还没下文的话自然地接着问一句（比如\"吃完啦？\"）。"


def _when(t: int) -> str:
    d = datetime.fromtimestamp(t / 1000)
    return d.strftime("%H:%M") if d.date() == date.today() else d.strftime("%m-%d %H:%M")


def _ago(t: int) -> str:
    m = round((time.time() * 1000 - t) / 60000)
    return "刚刚" if m < 2 else f"{m} 分钟前" if m < 60 else f"{round(m / 60)} 小时前" if m < 1440 else f"{round(m / 1440)} 天前"


def _place(f: str) -> str:
    return "聊天软件里" if f == FROM else f"「{f}」上"


# only worth saying when the day is new, or he just came over from the pet
def _meet_hint(m: dict) -> str:
    prev = m.get("prev") or {}
    if m.get("firstToday"):
        gap = m.get("daysAway")
        return f"你们已经 {gap} 天没见了，这是今天第一次聊，可以说说想他了。" if gap and gap >= 3 else ""
    if not prev or prev.get("from") == FROM:
        return ""
    first = m.get("todayFirst") or {}
    return (f"今天你们已经见过了（{_when(first.get('t', 0))} 在{_place(first.get('from', ''))}第一次见，"
            f"最近一次是 {_ago(prev.get('t', 0))} 在{_place(prev.get('from', ''))}）。他刚从桌宠那边来找你，"
            f"不要当成今天第一次聊。{FOLLOW_UP}")


@register("astrbot_plugin_dafeiyu_memory", "you2001215", "和大肥鱼桌宠共用人格和记忆", "1.0.0")
class DafeiyuMemory(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config

    # ---- files
    def _dir(self) -> str:
        return os.path.expanduser(str(self.config.get("shared_dir", "")).strip())

    def _read_persona(self) -> str:
        try:
            with open(os.path.join(self._dir(), PERSONA_FILE), encoding="utf-8") as f:
                return f.read().strip()
        except OSError as e:
            logger.warning(f"[大肥鱼记忆] 读不到人设：{e}")
            return ""

    def _read_memories(self) -> list:
        try:
            with open(os.path.join(self._dir(), MEMORY_FILE), encoding="utf-8") as f:
                raw = json.load(f)
        except FileNotFoundError:
            return []
        items = raw.get("memories") if isinstance(raw, dict) else None
        return [m for m in (items or []) if isinstance(m, dict) and str(m.get("text", "")).strip()]

    def _add_memories(self, texts: list) -> None:
        try:
            items = self._read_memories()
        except (OSError, ValueError) as e:
            logger.warning(f"[大肥鱼记忆] 记忆.json 读不了，这次不写：{e}")
            return
        have = {str(m["text"]).strip() for m in items}
        stamp = time.strftime("%Y-%m-%d %H:%M")
        new = [{"text": t, "from": FROM, "time": stamp} for t in dict.fromkeys(texts) if t not in have]
        if not new:
            return
        body = {"说明": NOTE, "memories": (items + new)[-MAX_NOTES:]}
        with open(os.path.join(self._dir(), MEMORY_FILE), "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=1)
        logger.info(f"[大肥鱼记忆] 记住了：{'；'.join(m['text'] for m in new)}")

    def _read_json(self, name: str, default: dict) -> dict:
        try:
            with open(os.path.join(self._dir(), name), encoding="utf-8") as f:
                raw = json.load(f)
            return raw if isinstance(raw, dict) else default
        except FileNotFoundError:
            return default

    def _write_json(self, name: str, body: dict) -> None:
        with open(os.path.join(self._dir(), name), "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=1)

    # chat: the pet merges by id, so appending here is enough
    def _add_message(self, role: str, content: str) -> None:
        if not content.strip():
            return
        chat = self._read_json(CHAT_FILE, {"clearedAt": 0, "messages": []})
        now = int(time.time() * 1000)
        msg = {"id": f"{FROM}-{now:x}-{random.randrange(16 ** 4):04x}", "role": role, "content": content.strip(), "t": now, "from": FROM}
        chat["messages"] = (list(chat.get("messages") or []) + [msg])[-MAX_MSGS:]
        self._write_json(CHAT_FILE, chat)

    def _recent_elsewhere(self) -> list:
        msgs = [m for m in self._read_json(CHAT_FILE, {}).get("messages") or [] if isinstance(m, dict)]
        return [m for m in msgs if m.get("from") != FROM][-RECENT:]

    # same rules as the pet's seen(): a new day counts once, wherever it happens
    def _seen(self) -> dict:
        st = self._read_json(STATE_FILE, {})
        now = int(time.time() * 1000)
        today = date.today().isoformat()
        prev = st.get("lastSeen")
        if st.get("lastDay") != today:
            gap = (date.fromisoformat(today) - date.fromisoformat(st["lastDay"])).days if st.get("lastDay") else None
            st["streak"] = (st.get("streak") or 0) + 1 if gap == 1 else 1
            st["daysMet"] = (st.get("daysMet") or 0) + 1
            st["firstMet"] = st.get("firstMet") or today
            st["lastDay"] = today
            st["todayFirst"] = {"t": now, "from": FROM}
            info = {"firstToday": True, "daysAway": gap, "prev": prev}
        else:
            info = {"firstToday": False, "todayFirst": st.get("todayFirst"), "prev": prev}
        st["lastSeen"] = {"t": now, "from": FROM}
        self._write_json(STATE_FILE, st)
        return info

    # ---- who is talking
    def _owner_private(self, event: AstrMessageEvent) -> bool:
        owners = {str(x).strip() for x in (self.config.get("owner_ids") or []) if str(x).strip()}
        return not event.get_group_id() and str(event.get_sender_id()) in owners

    # ---- hooks
    @filter.on_llm_request()
    async def add_persona_and_memory(self, event: AstrMessageEvent, req: ProviderRequest):
        if not self._dir():
            return
        parts = []
        persona = self._read_persona()
        if persona:
            parts.append(persona)
            hint = str(self.config.get("platform_hint", "")).strip()
            if hint:
                parts.append(hint)
        if self._owner_private(event):
            try:
                notes = [str(m["text"]).strip() for m in self._read_memories()]
            except (OSError, ValueError) as e:
                logger.warning(f"[大肥鱼记忆] 记忆.json 读不了：{e}")
                notes = []
            if notes:
                parts.append("你记得的关于用户的事：\n" + "\n".join("- " + n for n in notes))
            parts.append(MEMORY_RULE)
            try:
                recent = self._recent_elsewhere()
                if recent:
                    lines = [f"[{_when(m.get('t', 0))}，{m.get('from', '')}] {'他' if m.get('role') == 'user' else '你'}：{m.get('content', '')}" for m in recent]
                    parts.append("你们最近在桌宠上的聊天（按时间顺序，「他」是用户，「你」是你自己）：\n" + "\n".join(lines))
                hint = _meet_hint(self._seen())
                if hint:
                    parts.append(hint)
                self._add_message("user", getattr(event, "message_str", "") or "")
            except (OSError, ValueError) as e:
                logger.warning(f"[大肥鱼记忆] 聊天记录或陪伴状态读写失败：{e}")
        if parts:
            # the shared persona goes first; whatever AstrBot already put in the system prompt follows
            req.system_prompt = "\n\n".join(parts + ([req.system_prompt] if req.system_prompt else []))

    @filter.on_llm_response()
    async def take_memories(self, event: AstrMessageEvent, resp: LLMResponse):
        text = resp.completion_text or ""
        found = [m.strip() for m in TAG.findall(text) if m.strip()]
        reply = TAG.sub("", text).strip()
        if self._owner_private(event) and self._dir():
            try:
                if found:
                    self._add_memories(found)
                self._add_message("assistant", reply)
            except (OSError, ValueError) as e:
                logger.warning(f"[大肥鱼记忆] 写不进共享文件夹：{e}")
        if found:
            resp.completion_text = reply

    # in case the tag got into the outgoing message some other way (e.g. streaming), drop it before sending
    @filter.on_decorating_result()
    async def hide_tags(self, event: AstrMessageEvent):
        result = event.get_result()
        if not result or not result.chain:
            return
        for c in result.chain:
            if isinstance(c, Comp.Plain) and "<memory" in c.text:
                c.text = TAG.sub("", c.text).strip()
