#!/usr/bin/env python3
import re, json
from collections import Counter
from pathlib import Path

FILE = Path("/Users/like/code/anovel/docs/我不过作作妖，怎么就成了白月光.txt")

def load_body(text):
    m = re.search(r'第1章', text)
    text = text[m.start():] if m else text
    skip = ['本小章还未完', '爱下电子书', '------章节', '致各位亲爱']
    lines = [l for l in text.split('\n') if not any(s in l for s in skip)]
    return '\n'.join(lines)

def clen(s): return len(re.sub(r'\s|\u3000', '', s))

def split_sents(text):
    parts = re.split(r'([。！？!?…]+)', text)
    out, buf = [], ''
    for p in parts:
        if re.match(r'^[。！？!?…]+$', p):
            buf += p
            if buf.strip(): out.append(buf.strip())
            buf = ''
        else: buf += p
    if buf.strip(): out.append(buf.strip())
    return out

def main():
    body = load_body(FILE.read_text(encoding='utf-8'))
    tc = clen(body)
    
    # Paragraphs (indented lines)
    raw_paras = []
    for line in body.split('\n'):
        p = line.replace('\u3000','').strip()
        if p: raw_paras.append(p)
    
    para_lens = [clen(p) for p in raw_paras if not re.match(r'^第\d+章', p)]
    
    # Dialogue: lines starting with quote or speaker tag pattern
    dial_lines = []
    narr_lines = []
    for p in raw_paras:
        if re.match(r'^[""「]', p) or re.match(r'^[^，。！？]{1,8}[，,]', p) and '"' in p[:30]:
            dial_lines.append(p)
        elif re.match(r'^[""「]', p) or (p.startswith('"') or p.startswith('"')):
            dial_lines.append(p)
        else:
            narr_lines.append(p)
    
    # Better dialogue: extract quoted segments only
    quoted = []
    for m in re.finditer(r'[""]([^""]{1,200})[""]', body):
        quoted.append(m.group(1))
    for m in re.finditer(r'「([^」]{1,200})」', body):
        quoted.append(m.group(1))
    # Also speaker-attributed: Name，"text" or Name，"text"
    for m in re.finditer(r'[，,][""]([^""]{1,150})[""]', body):
        quoted.append(m.group(1))
    
    dial_chars = sum(clen(q) for q in quoted)
    
    # All sentences
    sents = []
    for p in raw_paras:
        if re.match(r'^第\d+章', p): continue
        sents.extend(split_sents(p))
    sl = [clen(s) for s in sents]
    
    # Single vs multi sentence para
    sp, mp = 0, 0
    for p in raw_paras:
        if re.match(r'^第\d+章', p) or p in ('*','……'): continue
        ns = len(split_sents(p))
        if ns == 1: sp += 1
        elif ns > 1: mp += 1
    
    # Sentence starts (first char after strip)
    starts = Counter()
    ends = Counter()
    for s in sents:
        c = re.sub(r'^[""「\s]+','',s)
        if c: starts[c[0]] += 1
        if len(c)>=2: starts[c[:2]] += 1
        if c.endswith('。'): ends[c[-3:]] += 1
        elif c.endswith('了。'): ends['…了。'] += 1
        tail = re.sub(r'[。！？…]+$', '', c)
        if tail: ends[tail[-2:]] += 1
    
    # 2-char starts more useful
    starts2 = Counter()
    for s in sents:
        c = re.sub(r'^[""「\s]+','',s)
        if len(c)>=2: starts2[c[:2]] += 1
    
    ends2 = Counter()
    for s in sents:
        c = re.sub(r'^[""「\s]+','',s)
        c2 = re.sub(r'[。！？…!?.]+$', '', c)
        if len(c2)>=2: ends2[c2[-2:]] += 1
    
    # Word freq - single chars excluding punctuation
    chars = [c for c in body if '\u4e00' <= c <= '\u9fff']
    char_freq = Counter(chars)
    
    # 2-gram
    bigrams = Counter()
    for i in range(len(chars)-1):
        bigrams[chars[i]+chars[i+1]] += 1
    
    # Verbs (common)
    verbs = ['说','看','想','走','站','坐','笑','问','答','转','抬','低','皱','握','拿','放','推','拉','打','听','愣','怔','瞥','盯','望','扫','抿','扯','挑','耸','叹','敲','拍','摸','攥','掐','按','点','挂','断','跑','冲','飞','踩','靠','躺','扑','撞','摔','跌','颤','抖','僵','缩','绷','松','弯','挺','弓','仰','俯','侧','歪','偏','回','出','进','开','关','送','接','迎','送','拉','拽','拖','扯','推','搡','摁','压','捂','盖','遮','挡','避','躲','闪','逃','追','赶','跟','随','陪','等','候','守','护','卫','防','攻','战','斗','争','抢','夺','占','占','占']
    verb_c = Counter({v: body.count(v) for v in verbs})
    
    adjs = ['美','漂亮','好看','英俊','帅气','温柔','冷漠','冰冷','冷淡','淡然','平静','阴沉','苍白','苍白','苍白','苍白','苍白']
    adj_list = ['美','漂亮','好看','温柔','冷漠','冰冷','冷淡','淡然','平静','阴沉','苍白','精致','华丽','奢华','璀璨','耀眼','动人','动人','娇羞','飒气','温婉','凌厉','冷冽','低沉','暗哑','清越','清脆','沙哑','嘶哑','疲惫','憔悴','狼狈','窘迫','尴尬','诡异','诡异','诡异','诡异']
    adj_c = Counter({a: body.count(a) for a in adj_list})
    
    advs = ['缓缓','慢慢','轻轻','微微','淡淡','冷冷','狠狠','猛然','骤然','陡然','倏然','忽然','突然','立刻','立马','顿时','瞬间','渐渐','默默','静静','悄悄','暗暗','公然','公然','公然']
    adv_c = Counter({a: body.count(a) for a in advs})
    
    # Templates
    templates = {
        '姜花衫+动词': len(re.findall(r'姜花衫[\u4e00-\u9fff]{1,2}', body)),
        'XX愣了愣': body.count('愣了愣'),
        'XX怔了怔': body.count('怔了怔'),
        'XX沉默了': body.count('沉默了'),
        'XX无言以对': body.count('无言以对'),
        '片刻后': body.count('片刻后'),
        '与此同时': body.count('与此同时'),
        '就在这时': body.count('就在这时'),
        '说罢': body.count('说罢'),
        '话音刚落': body.count('话音刚落'),
        '不等XX说完': body.count('不等') ,
        'XX挑眉': body.count('挑眉'),
        'XX勾唇': body.count('勾') + body.count('扯了扯嘴角'),
        '不怒反喜': body.count('不怒反喜'),
        '不卑不亢': body.count('不卑不亢'),
        '若有所思': body.count('若有所思'),
        '意味深长': body.count('意味深长'),
        '猝不及防': body.count('猝不及防'),
        '岂有此理': body.count('岂有此理'),
        '眼底': body.count('眼底'),
        '眸光': body.count('眸光'),
        '眼眸': body.count('眼眸'),
        '神情': body.count('神情'),
        '语气': body.count('语气'),
        '语调': body.count('语调'),
        '神色': body.count('神色'),
        '脸色': body.count('脸色'),
        '目光': body.count('目光'),
        '眼神': body.count('眼神'),
    }
    
    # Rhetoric
    metaphor = sum(len(re.findall(p, body)) for p in [
        r'像[^。！？\n]{2,25}(?:一样|似的|般)', r'如同[^。！？\n]{2,25}', r'仿佛[^。！？\n]{2,25}',
        r'宛如[^。！？\n]{2,25}', r'好似[^。！？\n]{2,25}', r'犹如[^。！？\n]{2,25}'
    ])
    personify = body.count('风') + body.count('花') # rough
    paibi = len(re.findall(r'[^。]{4,15}，[^。]{4,15}，[^。]{4,15}，', body))
    
    # Ellipsis standalone
    ell_para = sum(1 for p in raw_paras if p.strip() in ('……','"……"','……'))
    
    # Asterisk scene break
    star_break = body.count('\n*\n') + raw_paras.count('*')
    
    # Network/modern
    net = ['摆烂','躺平','癫','疯批','修罗场','甜宠','无语','离谱','cpu','pua','上头','下头','拿捏','真香','打脸','开挂','小脑萎缩','死扑街','咸物','某物']
    net_c = {n: body.count(n) for n in net}
    
    # Mood in dialogue
    mood_d = Counter()
    dial_text = ''.join(quoted)
    for m in ['啊','哦','嗯','吧','吗','呢','呵','哈','啧','诶','唉','哼','咦','哇','呀','咯','嘛','呗','噢','哎']:
        mood_d[m] = dial_text.count(m)
    
    # Oral phrases
    oral = ['行了','算了','没事','没关系','无所谓','随便','罢了','而已','倒是','倒是','倒是','倒是','哈','抱歉哈','懂？','是吧','对吧','好吗','好不好']
    oral_c = {o: body.count(o) for o in oral}
    
    # Chapter count
    chs = len(re.findall(r'第\d+章', body))
    
    # Events per 1000 chars (scene shifts: * breaks + chapter internal scene markers)
    scene_shifts = star_break + body.count('另一边') + body.count('与此同时') + body.count('这时，') + body.count('这时，')
    events_per_1k = round(scene_shifts / (tc/1000), 2)
    
    # Dialogue line analysis
    dial_line_lens = [clen(q) for q in quoted if clen(q) > 0]
    
    # Paragraph structure patterns (sample)
    patterns = Counter()
    for i in range(min(len(raw_paras)-1, 50000)):
        p = raw_paras[i]
        if re.match(r'^第\d+章', p) or p in ('*','……'): continue
        n = raw_paras[i+1] if i+1 < len(raw_paras) else ''
        if re.match(r'^第\d+章', n): continue
        is_d1 = bool(re.match(r'^[""「]', p))
        is_d2 = bool(re.match(r'^[""「]', n))
        has_action = any(w in p for w in ['走','站','转身','抬','看','愣','怔','皱眉','点头','摇头'])
        has_psych = any(w in p for w in ['心想','觉得','意识到','看来','似乎','原来','难怪'])
        if has_action and is_d2: patterns['动作→对话'] += 1
        elif is_d1 and has_action and not is_d2: patterns['对话→动作'] += 1
        elif has_psych and has_action: patterns['心理→动作'] += 1
        elif has_action and has_psych: patterns['动作→心理'] += 1
        elif any(w in p for w in ['阳光','风','雨','夜色','大厅','房间']) and has_action: patterns['场景→人物'] += 1
    
    out = {
        'total_chars': tc,
        'chapters': chs,
        'avg_chapter': round(tc/chs),
        'paragraphs': len(para_lens),
        'avg_para': round(sum(para_lens)/len(para_lens),1),
        'avg_sent': round(sum(sl)/len(sl),1),
        'short_para_pct': round(sum(1 for l in para_lens if l<=20)/len(para_lens)*100,1),
        'mid_para_pct': round(sum(1 for l in para_lens if 20<l<=80)/len(para_lens)*100,1),
        'long_para_pct': round(sum(1 for l in para_lens if l>80)/len(para_lens)*100,1),
        'single_para_pct': round(sp/(sp+mp)*100,1),
        'short_sent_pct': round(sum(1 for l in sl if l<=15)/len(sl)*100,1),
        'mid_sent_pct': round(sum(1 for l in sl if 15<l<=40)/len(sl)*100,1),
        'long_sent_pct': round(sum(1 for l in sl if l>40)/len(sl)*100,1),
        'dialogue_pct': round(dial_chars/tc*100,1),
        'quoted_segments': len(quoted),
        'avg_quote_len': round(sum(dial_line_lens)/len(dial_line_lens),1) if dial_line_lens else 0,
        'ellipsis_para': ell_para,
        'star_breaks': star_break,
        'events_per_1k': events_per_1k,
        'punct_per_1k': {k: round(body.count(k)/(tc/1000),2) for k in '。，、？！…——：'},
        'metaphor_per_500': round(metaphor/(tc/500),2),
        'q_pct': round(sum(1 for s in sents if '？' in s)/len(sents)*100,1),
        'ex_pct': round(sum(1 for s in sents if '！' in s)/len(sents)*100,1),
        'top_chars': char_freq.most_common(50),
        'top_bigrams': bigrams.most_common(60),
        'top_verbs': verb_c.most_common(30),
        'top_adjs': adj_c.most_common(20),
        'top_advs': adv_c.most_common(20),
        'templates': templates,
        'net': net_c,
        'oral': oral_c,
        'mood_dialogue': mood_d.most_common(15),
        'starts2': starts2.most_common(40),
        'ends2': ends2.most_common(40),
        'para_patterns': patterns.most_common(10),
        'paibi_estimate': paibi,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
