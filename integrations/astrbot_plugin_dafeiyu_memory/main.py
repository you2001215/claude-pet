# Makes an AstrBot bot the same 大肥鱼 as the desktop pet.
# The pet (AI 设置 → 人格和记忆存在哪 → 文件夹) and this plugin read and write the same files in one folder:
#   人设.md         the persona, used as the bot's persona in every chat
#   记忆.json       things the owner told her
#   聊天记录.json    the recent chat with the owner, on every computer and here
#   陪伴状态.json    which day they first met, days in a row, when and where they saw each other today and last
# Everything except the persona is only used, and only added to, in the owner's private chat.
# Files are written to a temp file of their own and then renamed over the old one, and a file that can't be parsed is never
# overwritten (the pet sets a broken chat file aside itself). A file that doesn't exist yet is only started in a
# folder that really is the pet's (记忆.json is there), so a half-synced folder can't get a second, empty copy.
import json
import os
import random
import re
import time
from datetime import date, datetime, timedelta, timezone

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import LLMResponse, ProviderRequest
from astrbot.api.star import Context, Star, register
import astrbot.api.message_components as Comp

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python 3.8 and older
    ZoneInfo = None

PERSONA_FILE = "人设.md"
MEMORY_FILE = "记忆.json"
CHAT_FILE = "聊天记录.json"
STATE_FILE = "陪伴状态.json"
MAX_NOTES = 120    # the notebook is full at this many: new ones are refused, old ones are never pushed out
MAX_PER_REPLY = 3  # same limits as the pet: at most 3 memories per reply, each at most 100 characters
MAX_NOTE_CHARS = 100
MAX_MSGS = 200
RECENT = 12        # how many messages from the pet to show her
FROM = "AstrBot"
DEFAULT_TZ = "Asia/Shanghai"
TAG = re.compile(r"<memory\b[^>]*>([\s\S]*?)</memory\s*>", re.I)
OPEN_TAG = re.compile(r"<memory\b[^\n]*", re.I)  # an unclosed tag takes the rest of its line with it
# same wording the pet uses, so both sides write memories the same way
MEMORY_RULE = (
    "当用户告诉你关于他自己、值得长期记住的信息（名字、喜好、习惯、重要安排等）时，在回复最后另起一行写 "
    "<memory>要记住的一句话</memory>，用户看不到这一行；已经记住的不要重复记，不要记临时的小事。"
)
FULL_RULE = (
    f"你的记忆本已经满了（{MAX_NOTES} 条），这次不要再写 <memory>。用户让你记东西时，告诉他记忆本满了，"
    "请他在桌宠的「AI 设置」里删掉一些旧的。"
)
NOTE = "大肥鱼的共享记忆。桌宠和 AstrBot 插件都会读写这个文件；可以直接改，一条记忆一项，text 是内容，from 是在哪边记下的。"
FOLLOW_UP = "看看你们最近的聊天里他说过要去做什么（比如去吃饭、去开会、出门），还没下文的话自然地接着问一句（比如\"吃完啦？\"）。"


def _when(t: int, tz) -> str:
    d = datetime.fromtimestamp(t / 1000, tz)
    return d.strftime("%H:%M") if d.date() == datetime.now(tz).date() else d.strftime("%m-%d %H:%M")


def _ago(t: int) -> str:
    m = round((time.time() * 1000 - t) / 60000)
    return "刚刚" if m < 2 else f"{m} 分钟前" if m < 60 else f"{round(m / 60)} 小时前" if m < 1440 else f"{round(m / 1440)} 天前"


def _place(f: str) -> str:
    return "聊天软件里" if f == FROM else f"「{f}」上"


def _ms(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _strip_tags(text: str) -> str:
    return OPEN_TAG.sub("", TAG.sub("", text)).strip()


# write a temp file, then rename it over the old file: a crash leaves the old or the new version, never half of one.
# The temp name is this process's own, so the pet (or a second writer) on the same computer can't truncate it.
def _atomic_write(path: str, text: str) -> None:
    tmp = f"{path}.{os.getpid()}-{random.randrange(16 ** 6):06x}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass  # some network and virtual drives can't fsync; the rename still protects the file
        for i in range(6):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                # Windows: a sync client or a virus scanner may hold the file for a moment
                if i == 5:
                    raise
                time.sleep(0.05 * (i + 1))
    finally:
        # gone after a successful rename; anything left over would be synced to every computer
        try:
            os.remove(tmp)
        except OSError:
            pass


# only worth saying when the day is new, or he just came over from the pet
def _meet_hint(m: dict, tz) -> str:
    prev = m.get("prev") or {}
    if m.get("firstToday"):
        gap = m.get("daysAway")
        return f"你们已经 {gap} 天没见了，这是今天第一次聊，可以说说想他了。" if gap and gap >= 3 else ""
    if not prev or prev.get("from") == FROM:
        return ""
    first = m.get("todayFirst") or {}
    return (f"今天你们已经见过了（{_when(_ms(first.get('t')), tz)} 在{_place(first.get('from', ''))}第一次见，"
            f"最近一次是 {_ago(_ms(prev.get('t')))} 在{_place(prev.get('from', ''))}）。他刚从桌宠那边来找你，"
            f"不要当成今天第一次聊。{FOLLOW_UP}")


@register("astrbot_plugin_dafeiyu_memory", "you2001215", "和大肥鱼桌宠共用人格和记忆", "1.1.0")
class DafeiyuMemory(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self._tz_name = None
        self._tz_obj = None

    # ---- time: "today" and the stamps follow the configured time zone, not the server's
    def _tz(self):
        name = str(self.config.get("timezone", "") or DEFAULT_TZ).strip() or DEFAULT_TZ
        if name != self._tz_name:
            self._tz_name = name
            try:
                if ZoneInfo is None:
                    raise ValueError("这个 Python 没有 zoneinfo")
                self._tz_obj = ZoneInfo(name)
            except (KeyError, ValueError, OSError) as e:
                # e.g. Windows without the tzdata package; China has no daylight saving, so +8 is exact
                self._tz_obj = timezone(timedelta(hours=8)) if name == DEFAULT_TZ else datetime.now().astimezone().tzinfo
                logger.warning(f"[大肥鱼记忆] 时区「{name}」用不了（{e}），先用 {self._tz_obj}")
        return self._tz_obj

    def _now(self) -> datetime:
        return datetime.now(self._tz())

    # ---- files
    def _dir(self) -> str:
        return os.path.expanduser(str(self.config.get("shared_dir", "")).strip())

    def _path(self, name: str) -> str:
        return os.path.join(self._dir(), name)

    # the pet sets the folder up; until 记忆.json is there (or synced) nothing new is started in it
    def _folder_ready(self) -> bool:
        return os.path.isfile(self._path(MEMORY_FILE))

    def _read_persona(self) -> str:
        try:
            with open(self._path(PERSONA_FILE), encoding="utf-8-sig") as f:
                return f.read().strip()
        except OSError as e:
            logger.warning(f"[大肥鱼记忆] 读不到人设：{e}")
            return ""

    # raises ValueError for a file that isn't a memory list, so it is never treated as empty and overwritten
    def _read_memories(self) -> list:
        try:
            with open(self._path(MEMORY_FILE), encoding="utf-8-sig") as f:
                raw = json.load(f)
        except FileNotFoundError:
            return []
        if not isinstance(raw, dict) or not isinstance(raw.get("memories", []), list):
            raise ValueError("记忆.json 里不是记忆列表")
        items = [{"text": m} if isinstance(m, str) else m for m in raw.get("memories") or []]
        return [m for m in items if isinstance(m, dict) and str(m.get("text", "")).strip()]

    def _add_memories(self, texts: list) -> None:
        if not self._folder_ready():
            logger.warning("[大肥鱼记忆] 共享文件夹里还没有 记忆.json（桌宠还没选这个文件夹，或者云盘还没同步好），这次不记")
            return
        try:
            items = self._read_memories()
        except (OSError, ValueError) as e:
            logger.warning(f"[大肥鱼记忆] 记忆.json 读不了，这次不写：{e}")
            return
        have = {str(m["text"]).strip() for m in items}
        new = [t for t in dict.fromkeys(texts) if t not in have]
        if not new:
            return
        room = max(0, MAX_NOTES - len(items))
        if len(new) > room:
            logger.warning(f"[大肥鱼记忆] 记忆本满了（{MAX_NOTES} 条），这些没记：{'；'.join(new[room:])}")
            new = new[:room]
        if not new:
            return
        stamp = self._now().strftime("%Y-%m-%d %H:%M")
        body = {"说明": NOTE, "memories": items + [{"text": t, "from": FROM, "time": stamp} for t in new]}
        _atomic_write(self._path(MEMORY_FILE), json.dumps(body, ensure_ascii=False, indent=1))
        logger.info(f"[大肥鱼记忆] 记住了：{'；'.join(new)}")

    # None when the file doesn't exist; raises ValueError when it can't be parsed (it is left alone then)
    def _read_json(self, name: str):
        try:
            with open(self._path(name), encoding="utf-8-sig") as f:
                raw = json.load(f)
        except FileNotFoundError:
            return None
        if not isinstance(raw, dict):
            raise ValueError(f"{name} 的内容格式不对")
        return raw

    def _write_json(self, name: str, body: dict) -> None:
        _atomic_write(self._path(name), json.dumps(body, ensure_ascii=False, indent=1))

    # chat: the pet merges by id, so appending here is enough
    def _add_message(self, role: str, content: str) -> None:
        if not content.strip():
            return
        chat = self._read_json(CHAT_FILE)
        if chat is None:
            if not self._folder_ready():
                return
            chat = {"clearedAt": 0, "messages": []}
        if not isinstance(chat.get("messages", []), list):
            raise ValueError(f"{CHAT_FILE} 里的 messages 不是列表")
        now = int(time.time() * 1000)
        msg = {"id": f"{FROM}-{now:x}-{random.randrange(16 ** 4):04x}", "role": role, "content": content.strip(), "t": now, "from": FROM}
        chat["messages"] = (list(chat.get("messages") or []) + [msg])[-MAX_MSGS:]
        self._write_json(CHAT_FILE, chat)

    def _recent_elsewhere(self) -> list:
        msgs = [m for m in (self._read_json(CHAT_FILE) or {}).get("messages") or [] if isinstance(m, dict)]
        return [m for m in msgs if m.get("from") != FROM][-RECENT:]

    # same rules as the pet's seen(): a new day counts once, wherever it happens. Like the pet, only a state file that
    # is already there is updated (the pet creates it when it joins the folder).
    def _seen(self) -> dict:
        st = self._read_json(STATE_FILE)
        exists = st is not None
        st = st or {}
        now = int(time.time() * 1000)
        today = self._now().date().isoformat()
        prev = st.get("lastSeen")
        if st.get("lastDay") != today:
            gap = (date.fromisoformat(today) - date.fromisoformat(str(st["lastDay"]))).days if st.get("lastDay") else None
            st["streak"] = (st.get("streak") or 0) + 1 if gap == 1 else 1
            st["daysMet"] = (st.get("daysMet") or 0) + 1
            st["firstMet"] = st.get("firstMet") or today
            st["lastDay"] = today
            st["todayFirst"] = {"t": now, "from": FROM}
            info = {"firstToday": True, "daysAway": gap, "prev": prev}
        else:
            info = {"firstToday": False, "todayFirst": st.get("todayFirst"), "prev": prev}
        st["lastSeen"] = {"t": now, "from": FROM}
        if exists:
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
            parts.append(FULL_RULE if len(notes) >= MAX_NOTES else MEMORY_RULE)
            tz = self._tz()
            # each on its own: a broken state or chat file must not keep the owner's message from being recorded
            try:
                recent = self._recent_elsewhere()
                if recent:
                    lines = [f"[{_when(_ms(m.get('t')), tz)}，{m.get('from', '')}] {'他' if m.get('role') == 'user' else '你'}：{m.get('content', '')}" for m in recent]
                    parts.append("你们最近在桌宠上的聊天（按时间顺序，「他」是用户，「你」是你自己）：\n" + "\n".join(lines))
            except (OSError, ValueError) as e:
                logger.warning(f"[大肥鱼记忆] 聊天记录读不了：{e}")
            try:
                hint = _meet_hint(self._seen(), tz)
                if hint:
                    parts.append(hint)
            except (OSError, ValueError) as e:
                logger.warning(f"[大肥鱼记忆] 陪伴状态读写失败：{e}")
            try:
                self._add_message("user", getattr(event, "message_str", "") or "")
            except (OSError, ValueError) as e:
                logger.warning(f"[大肥鱼记忆] 聊天记录写不进去：{e}")
        if parts:
            # the shared persona goes first; whatever AstrBot already put in the system prompt follows
            req.system_prompt = "\n\n".join(parts + ([req.system_prompt] if req.system_prompt else []))

    @filter.on_llm_response()
    async def take_memories(self, event: AstrMessageEvent, resp: LLMResponse):
        text = resp.completion_text or ""
        found = []
        for m in TAG.findall(text):
            t = re.sub(r"\s*\n+\s*", " ", m).strip()
            if t and t not in found:
                found.append(t)
        kept = [t for t in found if len(t) <= MAX_NOTE_CHARS][:MAX_PER_REPLY]
        if len(kept) < len(found):
            logger.warning(f"[大肥鱼记忆] 这次回复里的记忆太多或太长，{len(found) - len(kept)} 条没记")
        tagged = bool(found) or "<memory" in text.lower()
        reply = _strip_tags(text) if tagged else text.strip()
        if self._owner_private(event) and self._dir():
            try:
                if kept:
                    self._add_memories(kept)
                self._add_message("assistant", reply)
            except (OSError, ValueError) as e:
                logger.warning(f"[大肥鱼记忆] 写不进共享文件夹：{e}")
        if tagged:
            resp.completion_text = reply

    # in case the tag got into the outgoing message some other way (e.g. streaming), drop it before sending
    @filter.on_decorating_result()
    async def hide_tags(self, event: AstrMessageEvent):
        result = event.get_result()
        if not result or not result.chain:
            return
        for c in result.chain:
            if isinstance(c, Comp.Plain) and "<memory" in c.text.lower():
                c.text = _strip_tags(c.text)
