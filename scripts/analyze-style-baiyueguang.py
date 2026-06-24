#!/usr/bin/env python3
"""StyleOS statistical analysis for 我不过作作妖，怎么就成了白月光"""
import re
import json
from collections import Counter
from pathlib import Path

FILE = Path("/Users/like/code/anovel/docs/我不过作作妖，怎么就成了白月光.txt")

def load_body(text: str) -> str:
    # Start from chapter 1
    m = re.search(r'第1章', text)
    if m:
        text = text[m.start():]
    # Remove site boilerplate lines
    lines = []
    skip_patterns = [
        r'本小章还未完',
        r'爱下电子书',
        r'------章节',
        r'致各位亲爱',
        r'^\s*第\d+章',  # keep chapter headers but process separately
    ]
    for line in text.split('\n'):
        stripped = line.strip()
        if not stripped:
            lines.append('')
            continue
        if any(re.search(p, stripped) for p in skip_patterns[:3]):
            continue
        lines.append(line)
    return '\n'.join(lines)

def clean_para(p: str) -> str:
    return p.replace('\u3000', '').replace(' ', '').strip()

def split_paragraphs(text: str):
    paras = []
    for block in re.split(r'\n+', text):
        p = clean_para(block)
        if p and not p.startswith('第') or re.match(r'第\d+章', p):
            if re.match(r'第\d+章', p):
                paras.append(p)
            elif p:
                paras.append(p)
    return [p for p in paras if len(p) > 1 or p in ('……', '*')]

def split_sentences(text: str):
    # Chinese sentence split
    parts = re.split(r'([。！？!?…]+)', text)
    sents = []
    buf = ''
    for i, part in enumerate(parts):
        if re.match(r'^[。！？!?…]+$', part):
            buf += part
            if buf.strip():
                sents.append(buf.strip())
            buf = ''
        else:
            buf += part
    if buf.strip():
        sents.append(buf.strip())
    return [s for s in sents if s]

def is_dialogue(para: str) -> bool:
    return bool(re.match(r'^[「""].*[」""]$', para)) or bool(re.match(r'^".*"$', para)) or (
        '，' not in para[:5] and re.search(r'[""「].+[""」]', para) and len(para) < 80
    )

def extract_dialogue(text: str):
    patterns = [
        r'[""]([^""]+)[""]',
        r'「([^」]+)」',
        r'"([^"]+)"',
    ]
    dialogs = []
    for pat in patterns:
        dialogs.extend(re.findall(pat, text))
    return dialogs

def char_len(s: str) -> int:
    return len(re.sub(r'\s', '', s))

def word_freq(text: str, min_len=2):
    # Extract Chinese character sequences and common terms
    words = re.findall(r'[\u4e00-\u9fff]{2,4}', text)
    return Counter(words)

def extract_pos_like(text: str):
    # Heuristic POS via suffix patterns
    verbs = re.findall(r'[\u4e00-\u9fff]{0,2}(?:了|着|过|起来|下去|上来|回去|出来|进去|过来|过去|住|掉|到|成|得|说|看|想|走|站|坐|笑|问|答|转|抬|低|皱|握|拿|放|推|拉|打|骂|听|说|愣|怔|瞥|盯|望|扫|瞥|抿|扯|勾|挑|耸|摊|叹|哼|啧|叩|敲|拍|摸|握|攥|掐|按|点|挂|断|开|关|跑|冲|飞|驶|踩|刹|转|弯|靠|倚|躺|卧|跪|蹲|伏|扑|撞|摔|跌|滑|滚|颤|抖|僵|缩|绷|松|舒|展|弯|直|挺|弓|仰|俯|侧|歪|偏|回头|转身|起身|坐下|站起|开口|闭嘴|沉默|无言|摇头|点头|颔首|摆手|挥手|招手|耸肩|扶额|捂脸|捂嘴|捂心|闭眼|睁眼|垂眸|抬眸|眯眼|瞪眼|瞥眼|扫视|打量|审视|凝视|注视|对视|避开|别过|转过|回头|愣住|怔住|呆住|僵住|顿住|停住|止住|收住|忍住|憋住|堵住|哽住|噎住|卡住|宕机|放空|走神|回神|醒神|定神|凝神|聚神|分神|失神|无神|有神|出神|入神|专心|分心|用心|费心|操心|担心|忧心|揪心|闹心|堵心|寒心|死心|灰心|伤心|痛心|心碎|心凉|心暖|心热|心冷|心沉|心提|心放|心悬|心定|心安|心乱|心静|心焦|心急|心缓|心慢|心快|心重|心轻|心实|心虚|心硬|心软|心狠|心善|心恶|心正|心邪|心明|心暗|心清|心浊|心高|心低|心大|心小|心宽|心窄|心深|心浅|心远|心近|心开|心闭|心通|心塞|心堵|心闷|心透|心亮|心灰|心黑|心白|心红|心绿|心黄|心紫|心蓝|心青|心橙|心粉|心金|心银|心铜|心铁|心钢|心玉|心石|心木|心水|心火|心土|心风|心云|心雨|心雪|心霜|心露|心雾|心烟|心尘|心沙|心浪|心潮|心流|心河|心海|心湖|心池|心泉|心源|心根|心芽|心苗|心花|心果|心实|心籽|心核|心壳|心皮|心肉|心骨|心血|心脉|心筋|心膜|心腔|心室|心房|心尖|心底|心头|心间|心口|心窝|心坎|心结|心锁|心链|心网|心笼|心罩|心墙|心门|心窗|心镜|心灯|心烛|心焰|心火|心光|心影|心形|心相|心像|心画|心图|心谱|心曲|心歌|心诗|心词|心句|心段|心章|心篇|心卷|心册|心本|心书|心文|心字|心音|心声|心语|心言|心话|心辞|心意|心愿|心望|心盼|心愿|心期|心待|心候|心等|心寻|心找|心觅|心求|心索|心取|心得|心失|心忘|心记|心忆|心念|心思|心虑|心忧|心愁|心恨|心爱|心喜|心乐|心欢|心悦|心慰|心满|心足|心缺|心空|心虚|心幻|心梦|心醒|心睡|心眠|心倦|心疲|心累|心乏|心慵|心懒|心勤|心奋|心勇|心怯|心胆|心魄|心魂|心灵|心神|心智|心慧|心聪|心愚|心钝|心敏|心钝|心利|心钝|心快|心慢|心急|心缓|心紧|心松|心绷|心弛|心张|心收|心放|心开|心合|心分|心聚|心散|心离|心合|心连|心断|心续|心止|心行|心止|心动|心止|心起|心落|心升|心降|心浮|心沉|心扬|心抑|心鼓|心瘪|心胀|心缩|心扩|心张|心弛|心紧|心软|心硬|心化|心凝|心融|心结|心解|心缠|心绕|心绕|心萦|心牵|心挂|心念|心惦|心记|心忘|心抛|心弃|心留|心守|心护|心卫|心保|心卫|心防|心攻|心守|心战|心和|心争|心斗|心竞|心比|心较|心量|心衡|心称|心评|心判|心断|心裁|心决|心定|心选|心挑|心拣|心择|心取|心舍|心留|心弃|心抛|心丢|心捡|心拾|心收|心藏|心露|心显|心隐|心藏|心埋|心掘|心挖|心刨|心翻|心搅|心扰|心乱|心宁|心安|心定|心稳|心晃|心摇|心颤|心抖|心震|心惊|心骇|心吓|心惧|心怕|心畏|心服|心不服|心甘|心不甘|心愿|心不愿|心肯|心不肯|心可|心不可|心能|心不能|心会|心不会|心懂|心不懂|心知|心不知|心明|心不明|心白|心不白|心清|心不清|心楚|心不楚|心透|心不透|心亮|心不亮|心暗|心不暗|心黑|心不黑|心灰|心不灰|心红|心不红|心热|心不热|心冷|心不冷|心凉|心不凉|心暖|心不暖|心温|心不温|心烫|心不烫|心冰|心不冰|心冻|心不冻|心融|心不融|心化|心不化|心凝|心不凝|心固|心不固|心硬|心不硬|心软|心不软|心脆|心不脆|心韧|心不韧|心坚|心不坚|心弱|心不弱|心强|心不强|心大|心不大|心小|心不小|心高|心不高|心低|心不低|心远|心不远|心近|心不近|心深|心不深|心浅|心不浅|心厚|心不厚|心薄|心不薄|心宽|心不宽|心窄|心不窄|心广|心不广|心狭|心不狭|心阔|心不阔|心隘|心不隘|心开|心不开|心闭|心不闭|心通|心不通|心塞|心不塞|心堵|心不堵|心闷|心不闷|心透|心不透|心亮|心不亮|心明|心不明|心清|心不清|心浊|心不浊|心净|心不净|心脏|心不脏|心纯|心不纯|心杂|心不杂|心乱|心不乱|心整|心不整|心齐|心不齐|心正|心不正|心歪|心不歪|心斜|心不斜|心直|心不直|心曲|心不曲|心弯|心不弯|心折|心不折|心断|心不断|心连|心不连|心续|心不续|心接|心不接|心合|心不合|心分|心不分|心离|心不离|心聚|心不聚|心散|心不散|心集|心不集|心汇|心不汇|心流|心不留|心停|心不停|心动|心不动|心静|心不静|心安|心不安|心宁|心不宁|心定|心不定|心稳|心不稳|心晃|心不晃|心摇|心不摇|心颤|心不颤|心抖|心不抖|心震|心不震|心惊|心不惊|心骇|心不骇|心吓|心不吓|心惧|心不惧|心怕|心不怕|心畏|心不畏|心服|心不服|心甘|心不甘|心愿|心不愿|心肯|心不肯)', text)
    # Simpler verb extraction
    verb_suffix = re.findall(r'[\u4e00-\u9fff]{1,3}(?:了|着|过|起来|下去|出来|进去|过来|过去)', text)
    adjs = re.findall(r'(?:很|极|颇|略|微|稍|颇|十分|格外|异常|格外|格外|格外)?[\u4e00-\u9fff]{1,2}(?:的|地)', text)
    advs = re.findall(r'[\u4e00-\u9fff]{1,2}地', text)
    return verb_suffix, adjs, advs

def analyze():
    raw = FILE.read_text(encoding='utf-8')
    body = load_body(raw)
    total_chars = char_len(body)
    
    paragraphs = split_paragraphs(body)
    para_lens = [char_len(p) for p in paragraphs if p not in ('*', '……') and not re.match(r'^第\d+章', p)]
    
    all_sents = []
    for p in paragraphs:
        if p in ('*', '……') or re.match(r'^第\d+章', p):
            continue
        all_sents.extend(split_sentences(p))
    
    sent_lens = [char_len(s) for s in all_sents]
    
    # Paragraph categories
    short_para = sum(1 for l in para_lens if l <= 20)
    mid_para = sum(1 for l in para_lens if 20 < l <= 80)
    long_para = sum(1 for l in para_lens if l > 80)
    total_para = len(para_lens) or 1
    
    # Single sentence paragraphs
    single_sent_para = 0
    multi_sent_para = 0
    for p in paragraphs:
        if p in ('*', '……') or re.match(r'^第\d+章', p):
            continue
        sents = split_sentences(p)
        if len(sents) == 1:
            single_sent_para += 1
        elif len(sents) > 1:
            multi_sent_para += 1
    total_content_para = single_sent_para + multi_sent_para or 1
    
    # Sentence categories
    short_sent = sum(1 for l in sent_lens if l <= 15)
    mid_sent = sum(1 for l in sent_lens if 15 < l <= 40)
    long_sent = sum(1 for l in sent_lens if l > 40)
    total_sent = len(sent_lens) or 1
    
    # Punctuation
    punct = {
        '。': body.count('。'),
        '，': body.count('，'),
        '、': body.count('、'),
        '？': body.count('？') + body.count('?'),
        '！': body.count('！') + body.count('!'),
        '…': body.count('…'),
        '——': body.count('——'),
        '：': body.count('：') + body.count(':'),
        '（': body.count('（') + body.count('('),
        '《': body.count('《'),
        '"': body.count('"') + body.count('"') + body.count('"'),
    }
    
    # Dialogue
    dialogs = extract_dialogue(body)
    dialog_chars = sum(char_len(d) for d in dialogs)
    
    # Content type estimation per paragraph
    narr, desc, psych, action, dial_para = 0, 0, 0, 0, 0
    action_words = ['走','跑','站','坐','转身','抬','低','握','拿','推','拉','笑','皱眉','愣','怔','瞥','盯','挂','断','冲','飞','踩','靠','躺','扑','撞','摔','跌','颤','抖','僵','缩','绷','点头','摇头','颔首','摆手','闭眼','睁眼','垂眸','抬眸','眯眼','瞪','扫','打量','凝视','注视','避开','别过','顿','停','收','忍','捂','扶','拍','敲','叩','摸','攥','掐','按','点','开','关','驶','刹','弯','倚','卧','跪','蹲','伏','滑','滚','舒','弯','挺','弓','仰','俯','侧','歪','偏']
    psych_words = ['心想','心里','内心','暗想','暗道','腹诽','思索','思忖','意识到','觉得','感到','以为','知道','明白','清楚','意识到','回忆','想起','记起','记得','忘了','怀疑','担心','害怕','恐惧','紧张','不安','焦虑','烦躁','不耐烦','厌倦','厌倦','无趣','无趣','得意','窃喜','暗喜','不悦','不满','生气','愤怒','震怒','愕然','惊讶','诧异','意外','没想到','不料','果然','难怪','原来','看来','似乎','好像','仿佛','宛如','如同','犹如','好似','像是']
    desc_words = ['阳光','夜色','月光','灯光','风','雨','雪','云','天空','空气','温度','气息','香味','味道','声音','目光','眼神','脸色','神情','表情','模样','姿态','身形','轮廓','侧脸','背影','房间','大厅','走廊','车内','办公室','花园','花海','庄园','酒店','医院','学校','教室','窗边','门口','台阶','路面','街道','城市','海面','港口','码头','火焰','浓烟','硝烟','暴雨','微雨','春风','秋风','冬','夏','春','秋']
    
    for p in paragraphs:
        if p in ('*', '……') or re.match(r'^第\d+章', p):
            continue
        if is_dialogue(p) or re.match(r'^[""「]', p):
            dial_para += char_len(p)
        elif any(w in p for w in psych_words):
            psych += char_len(p)
        elif any(w in p for w in action_words):
            action += char_len(p)
        elif any(w in p for w in desc_words):
            desc += char_len(p)
        else:
            narr += char_len(p)
    
    content_total = narr + desc + psych + action + dial_para or 1
    
    # Connectors
    connectors = ['但是','然而','不过','只是','于是','因此','随后','接着','旋即','紧接着','与此同时','片刻后','下一秒','忽然','突然','这时','这时','蓦地','转眼','很快','不久','稍后','稍后','稍后','稍后','原来','果然','难怪','看来','似乎','好像','其实','毕竟','反正','总之','所以','因为','如果','虽然','尽管','即使','哪怕','除非','一旦','既然','何况','况且','况且','况且','况且']
    conn_counter = Counter()
    for c in connectors:
        conn_counter[c] += body.count(c)
    
    # Sentence starts
    sent_starts = Counter()
    sent_ends = Counter()
    for s in all_sents:
        s_clean = re.sub(r'^[""「\s]+', '', s)
        if len(s_clean) >= 2:
            start = s_clean[:2]
            sent_starts[start] += 1
        end = s_clean[-4:] if len(s_clean) >= 4 else s_clean
        sent_ends[end] += 1
    
    # Metaphors
    metaphor_patterns = [
        r'像[^。！？\n]{2,25}(?:一样|似的|般)',
        r'如同[^。！？\n]{2,25}',
        r'仿佛[^。！？\n]{2,25}',
        r'宛如[^。！？\n]{2,25}',
        r'好似[^。！？\n]{2,25}',
        r'犹如[^。！？\n]{2,25}',
        r'像是[^。！？\n]{2,25}',
    ]
    metaphors = 0
    for pat in metaphor_patterns:
        metaphors += len(re.findall(pat, body))
    
    # Personification, exaggeration
    personify = len(re.findall(r'[^。]{0,5}(?:冷笑|轻笑|低笑|笑了|开口|说道|呢喃|叹息)', body))
    exaggeration = body.count('无比') + body.count('极其') + body.count('格外') + body.count('万分') + body.count('简直')
    
    # Time transitions
    time_trans = Counter()
    for t in ['片刻后','十分钟后','当天晚上','第二天','翌日','三天后','数月后','不久后','很快','不久','这时','此时','与此同时','另一边','转眼','眨眼','瞬间','刹那','良久','许久','半天','一会儿','一会']:
        time_trans[t] += body.count(t)
    
    # Interjections / mood particles in dialogue
    mood = Counter()
    for m in ['啊','哦','嗯','吧','吗','呢','呵','哈','啧','诶','唉','哼','咦','哇','呀','咯','嘛','呗','咧','喽','嘞','呐','噢','哎','唉']:
        mood[m] += len(re.findall(m, ''.join(dialogs)))
    
    # Word frequency
    wf = word_freq(body)
    
    # Emotion words
    emotion_words = ['笑','怒','气','恼','烦','厌','喜','悲','伤','痛','惧','怕','惊','愕','愣','怔','呆','僵','冷','热','暖','凉','酸','苦','甜','闷','堵','慌','急','躁','静','默','沉默','无言','哽咽','泣','哭','泪','红','红着眼','眼眶','心酸','心碎','心寒','心凉','心暖','心动','心累','心焦','心虚','心虚','心虚']
    emo_counter = Counter()
    for e in ['笑','怒','气','恼','烦','厌','喜','悲','伤','痛','惧','怕','惊','愕','愣','怔','呆','僵','冷','热','暖','凉','酸','苦','甜','闷','堵','慌','急','躁','静','默','沉默','无言','哭','泪','心酸','心碎','心寒','心凉','心暖','心动','心累','心焦','心虚','不悦','不满','开心','难过','绝望','无奈','尴尬','窘迫','狼狈','窘迫','窘迫']:
        emo_counter[e] += body.count(e)
    
    # Action words freq
    action_top = Counter()
    for a in ['点头','摇头','皱眉','愣','怔','瞥','盯','看','望','扫','打量','凝视','注视','转身','抬眸','垂眸','眯眼','瞪','笑','冷笑','轻笑','扯','勾','挑','耸肩','扶额','捂','拍','敲','握','攥','掐','按','点','推','拉','走','跑','站','坐','靠','躺','扑','撞','摔','跌','颤','抖','僵','缩','绷','开口','闭嘴','沉默','挂','断','顿','停','收','忍','深吸','长舒','叹气','叹息']:
        action_top[a] += body.count(a)
    
    # Expression patterns
    expression_top = Counter()
    for e in ['神情','表情','脸色','目光','眼神','眼眸','眼底','眼里','眼中','眉','唇','嘴角','声音','语气','语调','音色','神色','姿态','身形','侧脸','背影','轮廓']:
        expression_top[e] += body.count(e)
    
    # Scene words
    scene_top = Counter()
    for s in ['房间','大厅','走廊','车内','办公室','花园','花海','庄园','酒店','医院','学校','窗边','门口','台阶','街道','城市','海面','港口','火焰','雨','风','夜色','月光','灯光','阳光','空气','气息','氛围','寂静','安静','喧嚣','热闹','冷清','昏暗','明亮','璀璨','华丽','奢华','精致','简陋','破旧']:
        scene_top[s] += body.count(s)
    
    # Network slang
    net_words = ['摆烂','躺平','社死','内卷','绝绝子','yyds','破防','cpu','pua','上头','下头','拿捏','整活','整活','癫','疯批','修罗场','甜宠','磕','嗑','真香','打脸','开挂','开摆','摆了','无语','离谱','炸裂','炸裂','炸裂']
    net_counter = Counter()
    for n in net_words:
        net_counter[n] += body.count(n)
    
    # Idioms (4-char common)
    idioms_sample = ['不动声色','若有所思','意味深长','猝不及防','大吃一惊','无言以对','哭笑不得','不以为然','不怒反喜','不卑不亢','不紧不慢','不紧不慢','不紧不慢']
    idiom_count = sum(body.count(i) for i in idioms_sample)
    
    # Chapters
    chapters = re.findall(r'第(\d+)章', body)
    chapter_count = len(chapters)
    
    # Question, exclamation sentences
    q_sent = sum(1 for s in all_sents if '？' in s or '?' in s)
    ex_sent = sum(1 for s in all_sents if '！' in s or '!' in s)
    rhetorical = sum(1 for s in all_sents if ('？' in s or '?' in s) and any(w in s for w in ['难道','莫非','何必','怎能','怎么','为何','岂不是','岂不是']))
    
    # Ellipsis standalone paragraphs
    ellipsis_para = sum(1 for p in paragraphs if p.strip() in ('……', '"……"', '"……"'))
    
    # Chapter avg length
    chapter_splits = re.split(r'(第\d+章[^\n]*)', body)
    chapter_lens = []
    current = ''
    for part in chapter_splits:
        if re.match(r'第\d+章', part):
            if current:
                chapter_lens.append(char_len(current))
            current = part
        else:
            current += part
    if current:
        chapter_lens.append(char_len(current))
    
    result = {
        'total_chars': total_chars,
        'chapter_count': chapter_count,
        'avg_chapter_chars': round(sum(chapter_lens)/len(chapter_lens)) if chapter_lens else 0,
        'paragraph_count': len(para_lens),
        'avg_para_chars': round(sum(para_lens)/len(para_lens), 1) if para_lens else 0,
        'avg_sent_chars': round(sum(sent_lens)/len(sent_lens), 1) if sent_lens else 0,
        'short_para_pct': round(short_para/total_para*100, 1),
        'mid_para_pct': round(mid_para/total_para*100, 1),
        'long_para_pct': round(long_para/total_para*100, 1),
        'single_sent_para_pct': round(single_sent_para/total_content_para*100, 1),
        'multi_sent_para_pct': round(multi_sent_para/total_content_para*100, 1),
        'short_sent_pct': round(short_sent/total_sent*100, 1),
        'mid_sent_pct': round(mid_sent/total_sent*100, 1),
        'long_sent_pct': round(long_sent/total_sent*100, 1),
        'dialogue_pct': round(dialog_chars/total_chars*100, 1),
        'narr_pct': round(narr/content_total*100, 1),
        'desc_pct': round(desc/content_total*100, 1),
        'psych_pct': round(psych/content_total*100, 1),
        'action_pct': round(action/content_total*100, 1),
        'dial_content_pct': round(dial_para/content_total*100, 1),
        'avg_dialog_len': round(sum(char_len(d) for d in dialogs)/len(dialogs), 1) if dialogs else 0,
        'dialog_count': len(dialogs),
        'punct_per_1k': {k: round(v/(total_chars/1000), 2) for k,v in punct.items()},
        'metaphor_per_500': round(metaphors/(total_chars/500), 2),
        'metaphor_count': metaphors,
        'q_sent_pct': round(q_sent/total_sent*100, 1),
        'ex_sent_pct': round(ex_sent/total_sent*100, 1),
        'ellipsis_para_count': ellipsis_para,
        'top_words': wf.most_common(80),
        'top_connectors': conn_counter.most_common(30),
        'top_sent_starts': sent_starts.most_common(40),
        'top_sent_ends': sent_ends.most_common(30),
        'top_emotions': emo_counter.most_common(40),
        'top_actions': action_top.most_common(50),
        'top_expressions': expression_top.most_common(30),
        'top_scenes': scene_top.most_common(30),
        'top_mood': mood.most_common(20),
        'top_time_trans': time_trans.most_common(20),
        'top_net': net_counter.most_common(20),
        'avg_dialog_round_estimate': round(len(dialogs) / chapter_count, 1) if chapter_count else 0,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    analyze()
