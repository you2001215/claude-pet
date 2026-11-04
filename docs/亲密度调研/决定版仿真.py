# 按用户 2026-11-04 的决定重跑亲密度节奏仿真。只用标准库，直接 python 决定版仿真.py 运行。
# 决定（见 工作档案.md 日志 ⑪）：
#   缺席不扣；生气时摸头立刻消气 +1（每天最多 3）；阶段只升不降，「家人」要她开口问、你答应；
#   只在 QQ 上见面的日子算见面天数（但 QQ 上不加见面分，QQ 戳一戳也不算点她）；
#   老用户按认识天数给阶段（选项 c）：≥3 天熟悉、≥10 天好朋友，分数设成该阶段起点，「家人」不直接给。
# 其余数值沿用报告第 6 章的建议默认值（与 仿真.py 的「建议」规则相同）。
import random, statistics, math

STAGES = [0, 100, 300, 700]
NAMES = ['刚认识', '熟悉', '好朋友', '家人']
GATES = [0, 3, 10, 25]          # 每个阶段至少见面几天（报告 1.4 的建议）
DAYS = 240
N = 3000

def pois(lam, rng):
    if lam <= 0: return 0
    L = math.exp(-lam); k = 0; p = 1.0
    while True:
        p *= rng.random()
        if p <= L: return k
        k += 1

PROFILES = {
    'light':  dict(click=3, pat=1.5, chat=3, screen=0.2, poke=0.05, throw=0.05, halfhours=3,  short_chat=0.10),
    'medium': dict(click=5, pat=3, chat=6, screen=1, poke=0.1, throw=0.1, halfhours=5,  short_chat=0.15),
    'heavy':  dict(click=10, pat=8, chat=15, screen=3, poke=0.4, throw=0.3, halfhours=10, short_chat=0.25),
}
COAX_CHANCE = 0.8   # 她生气时你去摸头的概率（假设；改成 0.5 或 1 看敏感性）

def day_points(p, rng):
    c = pois(p['click'], rng); pt = pois(p['pat'], rng); ch = pois(p['chat'], rng)
    sc = pois(p['screen'], rng); pk = pois(p['poke'], rng); th = pois(p['throw'], rng)
    hh = pois(p['halfhours'], rng)
    valid_ch = sum(1 for _ in range(ch) if rng.random() > p['short_chat'])
    gain = 5 + min(c, 5) + min(pt * 2, 10) + min(valid_ch * 2, 20) + min(sc, 3) + min(hh, 4)
    loss = max(-2 * pk, -6) + max(-1 * th, -3)
    coax = min(sum(1 for _ in range(pk) if rng.random() < COAX_CHANCE), 3)
    return gain + loss + coax

def start_state(known_days):
    """选项 (c)：按认识天数给阶段，分数设成该阶段起点；家人不直接给。"""
    if known_days >= 10: return 2, STAGES[2]
    if known_days >= 3: return 1, STAGES[1]
    return 0, 0

def run(profile, pattern='daily', old=None, seed=0):
    """pattern: daily | workdays_qq（工作日开电脑、周末只在 QQ 上聊）| away（刚到好朋友就离开 7 天，期间也不上 QQ）
       old: None（新用户）或 (认识天数, 已记的见面天数)"""
    rng = random.Random(seed)
    p = PROFILES[profile]
    if old:
        known0, met0 = old
        stage, score = start_state(known0)
        days_met = met0
        done = {'E001'}                        # 补看版 E001 当天播（+10），见下
        score += 10
        if known0 >= 7: score += 10; done.add('E003')   # 认识满一周早就过了，上线当天补播一次
    else:
        known0, stage, score, days_met, done = 0, 0, 0, 0, set()
    reach = {k: 0 for k in range(1, stage + 1)}
    streak = 0; last_meet = None; away_until = None; away_loss = 0
    for d in range(1, DAYS + 1):
        weekday = d % 7
        pc = True; qq = False
        if pattern == 'workdays_qq':
            pc = weekday not in (6, 0); qq = not pc
        if pattern == 'away' and away_until is not None and d <= away_until:
            pc = False
        if not (pc or qq):
            continue
        gap = None if last_meet is None else d - last_meet
        streak = streak + 1 if gap == 1 else 1
        days_met += 1
        known = known0 + d
        before = score
        if pc:
            if 'E001' not in done: score += 10; done.add('E001')
            if 'E003' not in done and known >= 7: score += 10; done.add('E003')
            if 'E007' not in done and streak >= 7: score += 15; done.add('E007')
            score = max(0, score + day_points(p, rng))
        elif 'E007' not in done and streak >= 7:
            pass                               # 事件只在桌宠上播：QQ 日子续上连续天数，下次开电脑再播
        if pattern == 'away' and gap and gap > 1: away_loss = max(away_loss, 0)   # 缺席不扣，恒为 0
        # 阶段：只升不降；「家人」要她开口问、你答应（这里假设够条件的当天就问、你当天答应）
        for k in range(stage + 1, 4):
            if score >= STAGES[k] and days_met >= GATES[k]:
                stage = k; reach.setdefault(k, d)
            else:
                break
        if pattern == 'away' and away_until is None and stage >= 2 and reach.get(2) == d:
            away_until = d + 7
        last_meet = d
    return dict(reach=reach, final=score, stage=stage)

def summarize(profile, pattern='daily', old=None):
    res = [run(profile, pattern, old, seed=s) for s in range(N)]
    out = {}
    for k in (1, 2, 3):
        vals = sorted(r['reach'].get(k, 10**9) for r in res)
        out[NAMES[k]] = (vals[len(vals) // 10], vals[len(vals) // 2], vals[len(vals) * 9 // 10])
    out['240 天内到家人'] = sum(1 for r in res if r['stage'] == 3) / N
    return out

def fmt(v):
    if isinstance(v, tuple):
        return '/'.join('第0天(起步就是)' if x == 0 else '—' if x >= 10**9 else f'第{x}天' for x in v)
    return f'{v:.0%}'

CASES = [
    ('新用户·每天开·轻度', 'light', 'daily', None),
    ('新用户·每天开·中度', 'medium', 'daily', None),
    ('新用户·每天开·重度', 'heavy', 'daily', None),
    ('新用户·工作日开电脑、周末只在 QQ 聊·中度', 'medium', 'workdays_qq', None),
    ('新用户·中度·刚到好朋友就离开一周', 'medium', 'away', None),
    ('老用户·认识 5 天（起步熟悉）·已记见面 3 天·中度', 'medium', 'daily', (5, 3)),
    ('老用户·认识 20 天（起步好朋友）·已记见面 7 天·轻度', 'light', 'daily', (20, 7)),
    ('老用户·认识 20 天（起步好朋友）·已记见面 7 天·中度', 'medium', 'daily', (20, 7)),
    ('老用户·认识 120 天（起步好朋友）·已记见面 7 天·工作日电脑+周末 QQ', 'medium', 'workdays_qq', (120, 7)),
]

if __name__ == '__main__':
    print(f'每种情形 {N} 次随机、每次 {DAYS} 天；p10/中位数/p90 = 最快一成 / 一般 / 最慢一成的人第几天到这个阶段')
    print(f'假设：她生气时你去摸头的概率 {COAX_CHANCE:.0%}；「家人」够条件当天她就开口问、你当天答应\n')
    for name, prof, pat, old in CASES:
        s = summarize(prof, pat, old)
        print(name)
        print('   ' + ' | '.join(f'{k} {fmt(v)}' for k, v in s.items()))
