# 大肥鱼亲密度节奏仿真（写报告用）。只用标准库。
# 现行规则 = 策划表示例数值；建议规则 = 报告第 6 章提出的默认值。
import random, statistics, math, json, sys

STAGES = [0, 100, 300, 700]           # 阶段门槛（两套规则都一样）
NAMES = ['刚认识', '熟悉', '好朋友', '家人']
DAYS = 240
N = 3000

def pois(lam, rng):
    # Knuth
    if lam <= 0: return 0
    L = math.exp(-lam); k = 0; p = 1.0
    while True:
        p *= rng.random()
        if p <= L: return k
        k += 1

# 每种用户「打开的那天」平均做多少次（都是能计分的次数，已经避开冷却）
PROFILES = {
    'light':  dict(click=3, pat=1.5, chat=3, screen=0.2, poke=0.05, throw=0.05, halfhours=3,  short_chat=0.10),
    'heavy':  dict(click=10, pat=8, chat=15, screen=3, poke=0.4, throw=0.3, halfhours=10, short_chat=0.25),
    'medium': dict(click=5, pat=3, chat=6, screen=1, poke=0.1, throw=0.1, halfhours=5,  short_chat=0.15),
}

def day_points(p, rng, rules):
    c = pois(p['click'], rng); pt = pois(p['pat'], rng); ch = pois(p['chat'], rng)
    sc = pois(p['screen'], rng); pk = pois(p['poke'], rng); th = pois(p['throw'], rng)
    hh = pois(p['halfhours'], rng)
    if rules == 'cur':
        gain = 5 + min(c * 1, 5) + min(pt * 2, 10) + min(ch * 2, 20) + min(sc * 1, 3)
        loss = max(-3 * pk, -9) + max(-1 * th, -3)
        return gain + loss
    else:
        # 建议：聊天一条至少 4 个字、30 秒冷却、同句不重复 -> 去掉一部分短消息
        valid_ch = sum(1 for _ in range(ch) if rng.random() > p['short_chat'])
        gain = 5 + min(c, 5) + min(pt * 2, 10) + min(valid_ch * 2, 20) + min(sc, 3) + min(hh, 4)
        loss = max(-2 * pk, -6) + max(-1 * th, -3)
        coax = min(sum(1 for _ in range(pk) if rng.random() < 0.5), 3)   # 生气后哄好 +1
        return gain + loss + coax

def stage_of(score):
    s = 0
    for i, t in enumerate(STAGES):
        if score >= t: s = i
    return s

GATES = [0, 3, 10, 25]   # 建议：每个阶段至少见面几天

def run(profile, rules, absence='cur', pattern='daily', seed=0):
    """pattern: daily | workdays | away_after_stage3 (刚升到好朋友就离开 7 天)"""
    rng = random.Random(seed)
    p = PROFILES[profile]
    score = 0; stage = 0; stage_max = 0
    last_open = None; streak = 0; days_met = 0; first = None
    done = set(); reach = {}; drops = 0; away_until = None; away_loss = 0
    hist = []
    for d in range(1, DAYS + 1):
        opened = True
        if pattern == 'workdays': opened = (d % 7) not in (6, 0)
        if pattern == 'occasional': opened = (d == 1) or (rng.random() < 0.55)
        if pattern == 'away_after_stage3' and away_until is not None and d <= away_until: opened = False
        if not opened:
            hist.append(score); continue
        if first is None: first = d
        gap = None if last_open is None else d - last_open
        missed = 0 if gap is None else gap - 1
        # 1) 缺席结算
        if missed > 0:
            before = score
            if rules == 'cur' or absence == 'cur':
                score = max(0, score - 5 * missed)
            elif absence == 'none':
                pass
            elif absence == 'capped':           # 宽限 2 天；回来只扣一次 -5；不跌破本阶段起点
                if missed >= 3:
                    score = max(STAGES[stage], score - 5)
            if pattern == 'away_after_stage3' and missed >= 7: away_loss = before - score
        # 2) 连续天数、见面天数
        streak = streak + 1 if gap == 1 else 1
        days_met += 1
        known = d - first + 1
        # 3) 事件
        if 'E001' not in done: score += 10; done.add('E001')
        if 'E003' not in done and known >= 7: score += 10; done.add('E003')
        if 'E007' not in done:
            ok = (streak >= 7) if rules == 'cur' else (days_met >= 7)
            if ok: score += 15; done.add('E007')
        # 4) 当天互动
        score = max(0, score + day_points(p, rng, rules))
        # 5) 阶段
        if rules == 'cur':
            ns = stage_of(score)
        else:
            ns = stage
            for k in range(stage + 1, 4):
                if score >= STAGES[k] and days_met >= GATES[k]: ns = k
                else: break
            ns = max(ns, stage)               # 只升不降
        if ns < stage: drops += 1
        stage = ns; stage_max = max(stage_max, stage)
        for k in range(1, stage + 1):
            reach.setdefault(k, d)
        if pattern == 'away_after_stage3' and away_until is None and stage >= 2 and 2 in reach and reach[2] == d:
            away_until = d + 7
        last_open = d
        hist.append(score)
    return dict(reach=reach, drops=drops, final=score, stage=stage, away_loss=away_loss, hist=hist)

def summarize(profile, rules, absence, pattern):
    res = [run(profile, rules, absence, pattern, seed=s) for s in range(N)]
    out = {}
    for k in (1, 2, 3):
        vals = [r['reach'].get(k, 10**9) for r in res]
        vals.sort()
        med = vals[len(vals) // 2]; p10 = vals[len(vals) // 10]; p90 = vals[len(vals) * 9 // 10]
        out[NAMES[k]] = (p10, med, p90)
    out['降阶比例'] = sum(1 for r in res if r['drops'] > 0) / N + 1e-12
    out['第90天分数中位数'] = statistics.median(r['hist'][89] for r in res)
    out['第240天分数中位数'] = statistics.median(r['hist'][-1] for r in res)
    if pattern == 'away_after_stage3':
        out['回来时被扣分中位数'] = statistics.median(r['away_loss'] for r in res)
    return out

def fmt(v):
    if isinstance(v, tuple):
        return '/'.join('—' if x >= 10**9 else str(x) for x in v)
    if isinstance(v, float) and 0 < v < 1: return f'{v:.0%}'
    if isinstance(v, float): return f'{v:.0f}'
    return str(v)

CASES = [
    ('每天开·轻度', 'light', 'daily'),
    ('每天开·重度', 'heavy', 'daily'),
    ('中度·刚到好朋友就离开一周', 'medium', 'away_after_stage3'),
    ('附加：每天开·中度', 'medium', 'daily'),
    ('附加：只在工作日开·中度', 'medium', 'workdays'),
    ('附加：偶尔开（每天 55% 概率）·轻度', 'light', 'occasional'),
]
RULES = [('现行示例数值', 'cur', 'cur'), ('建议A（缺席不扣）', 'new', 'none'), ('建议B（缺席扣一次封顶）', 'new', 'capped')]

if __name__ == '__main__':
    # 每天期望净增（解析估计，用 2 万次单日抽样）
    rng = random.Random(42)
    for prof in PROFILES:
        for r in ('cur', 'new'):
            xs = [day_points(PROFILES[prof], rng, r) for _ in range(20000)]
            print(f'每天净增 {prof} {r}: 均值 {statistics.mean(xs):.1f}')
    print()
    for cname, prof, pat in CASES:
        for rname, rules, ab in RULES:
            s = summarize(prof, rules, ab, pat)
            print(cname, '|', rname, '|', ' | '.join(f'{k} {fmt(v)}' for k, v in s.items()))
        print()
