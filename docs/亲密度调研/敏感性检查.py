# 敏感性检查：聊天门槛从「≥4 字」改成「≥2 字 + 去重复」后短消息比例减半；以及不加「哄好她」
import sys, random, statistics
sys.path.insert(0, '.')
import sim_base as S
S.N = 1500
orig = {k: dict(v) for k, v in S.PROFILES.items()}
def setp(short_scale):
    for k, v in orig.items():
        S.PROFILES[k] = dict(v, short_chat=v['short_chat'] * short_scale)
orig_dp = S.day_points
def dp_nocoax(p, rng, rules):
    if rules == 'cur': return orig_dp(p, rng, rules)
    c = S.pois(p['click'], rng); pt = S.pois(p['pat'], rng); ch = S.pois(p['chat'], rng)
    sc = S.pois(p['screen'], rng); pk = S.pois(p['poke'], rng); th = S.pois(p['throw'], rng)
    hh = S.pois(p['halfhours'], rng)
    valid_ch = sum(1 for _ in range(ch) if rng.random() > p['short_chat'])
    gain = 5 + min(c, 5) + min(pt * 2, 10) + min(valid_ch * 2, 20) + min(sc, 3) + min(hh, 4)
    loss = max(-2 * pk, -6) + max(-1 * th, -3)
    return gain + loss
for label, scale, nocoax in [('原报告（4字门槛估计，有哄好）', 1.0, False), ('2字门槛（短消息比例减半），有哄好', 0.5, False), ('2字门槛，不加哄好（保持现状 a）', 0.5, True)]:
    setp(scale)
    S.day_points = dp_nocoax if nocoax else orig_dp
    rng = random.Random(42)
    nets = {prof: statistics.mean(S.day_points(S.PROFILES[prof], rng, 'new') for _ in range(20000)) for prof in S.PROFILES}
    print('==', label, '每天净增', {k: round(v, 1) for k, v in nets.items()})
    for cname, prof, pat in S.CASES:
        s = S.summarize(prof, 'new', 'none', pat)
        print('  ', cname, '| 建议A |', ' | '.join(f'{k} {S.fmt(v)}' for k, v in s.items() if k in ('熟悉','好朋友','家人')))
