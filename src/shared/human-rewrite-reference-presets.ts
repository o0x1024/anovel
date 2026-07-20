import type { HumanRewriteReferenceInput } from './human-rewrite-reference-types'

export interface HumanRewriteReferencePreset {
  id: string
  name: string
  description: string
  sourceTitle: string
  examples: HumanRewriteReferenceInput[]
}

const SOURCE_TITLE = '我不过作作妖，怎么就成了白月光'

export const HUMAN_REWRITE_REFERENCE_PRESETS: HumanRewriteReferencePreset[] = [{
  id: 'baiyueguang-human-rewrite',
  name: '《白月光》场景改写案例',
  description: '从小说中提取的十类人类写法，覆盖对话、动作、环境、心理、外貌、情感、打斗、信息揭示、过渡和人物叙述。',
  sourceTitle: SOURCE_TITLE,
  examples: [
    {
      title: '《白月光》·用人物逻辑改写针锋相对的对话',
      sceneTypes: ['dialogue', 'emotional_conflict'],
      aiSymptoms: ['dialogue_template', 'generic_voice'],
      originalText: '姜花杉听到沈兰曦的指责，心中十分生气。她挑眉看着电话，冷冷地反问：“我只是出门看病，你却和别的女人开房，难道这不比我更加过分吗？”她的话语中充满了讽刺。',
      rewrittenText: '兴风作浪？姜花杉挑眉，“沈兰曦我出门看个病就是兴风作浪？那你跟别的女人开房又算什么？是想刮龙卷风吗？”',
      rewritePrinciples: [
        '让反击沿用对方刚说过的词，形成角色当场接招的感觉',
        '用符合人物性格的夸张比喻代替通用的生气和讽刺说明',
        '台词已经表达情绪时，不再补写话语中充满讽刺'
      ],
      preservedFacts: ['姜花杉反驳沈兰曦', '争执涉及看病和酒店事件'],
      forbiddenChanges: ['不得改变双方立场', '不得把人物改成礼貌克制的通用口吻'],
      priority: 80
    },
    {
      title: '《白月光》·用结果和意外改写连续动作',
      sceneTypes: ['action'],
      aiSymptoms: ['shot_chain', 'regular_sentence_rhythm'],
      originalText: '沈归灵先抬起胳膊，随后双手握紧鱼竿。他深吸一口气，用力向后一拉。鱼线立刻绷紧，泥潭表面泛起波纹。紧接着，一只巨大的蓝龙虾慢慢钻出泥潭，飞溅的泥水落在傅绥尔脸上。',
      rewrittenText: '她话还没说完，沈归灵抬着胳膊用力一拉，听见“波”的一声，一只巨大的蓝龙从泥潭里钻了出来，泥水飞溅滋了傅绥尔一嘴的泥。',
      rewritePrinciples: [
        '删除握紧、深呼吸、绷紧等可由结果推断的逐帧动作',
        '从人物说到一半切入，让动作打断台词并制造喜剧节拍',
        '把注意力落在声音和泥水入口这两个有效感官结果上'
      ],
      preservedFacts: ['沈归灵拉出泥潭里的蓝龙虾', '泥水溅到傅绥尔嘴里'],
      forbiddenChanges: ['不得新增招式或慢动作', '不得把喜剧结果改成危险事件'],
      priority: 75
    },
    {
      title: '《白月光》·让环境服务人物处境',
      sceneTypes: ['environment', 'psychology'],
      aiSymptoms: ['uniform_information', 'emotion_telling'],
      originalText: '小沈园后园有一座美丽的花园。花园里曾经种植着许多来自世界各地的名贵玫瑰，现在则种满了牡丹。四月的雨水落在花瓣上，微风轻轻吹拂，景色十分优美。姜花衫看到这样的景色，心情逐渐变得放松。',
      rewrittenText: '小沈园后园有一片花海。三年前这里种满了来自世界各地的名贵玫瑰，但自从沈老爷子去世后就换成了牡丹。四月微雨，眼下正是牡丹盛放的季节，满园花海连叶，姹紫嫣红。',
      rewritePrinciples: [
        '环境只保留与人物关系和时间变化有关的细节',
        '用玫瑰换成牡丹承载人物失去亲人的背景，不直接解释悲伤',
        '避免把视觉、雨声、气味和微风平均罗列'
      ],
      preservedFacts: ['地点是小沈园后园', '玫瑰在沈老爷子去世后换成牡丹', '时间为四月微雨'],
      forbiddenChanges: ['不得增加原文没有的景物象征', '不得直接总结人物心情'],
      priority: 75
    },
    {
      title: '《白月光》·用突兀自嘲改写心理说明',
      sceneTypes: ['psychology'],
      aiSymptoms: ['emotion_telling', 'over_explanation'],
      originalText: '看到手机里“老公”这个备注，姜花杉感到十分厌恶。她回想起自己曾经对沈兰曦的迷恋，不禁觉得过去的自己十分可笑，同时也为这个亲密的称呼感到反感。',
      rewrittenText: '备注是：老公。姜花杉指尖一顿，眼神里的厌倦一下凝固，这还是老爷子去世后沈兰曦第一次主动联系她……不是，她当初脑子也萎缩了？这什么恶心备注？！？',
      rewritePrinciples: [
        '先呈现触发心理的具体物件，再让念头突然转向',
        '保留人物会真正使用的自嘲词，而不是概括她觉得可笑',
        '让省略号、反问和感叹承担思维跳跃，不解释完整心理因果'
      ],
      preservedFacts: ['手机备注是老公', '这是沈兰曦久违的主动联系', '姜花杉已经厌恶旧日迷恋'],
      forbiddenChanges: ['不得把内心独白改成作者总结', '不得弱化人物尖锐自嘲'],
      priority: 80
    },
    {
      title: '《白月光》·用社会位置改写人物外貌',
      sceneTypes: ['appearance'],
      aiSymptoms: ['uniform_information', 'generic_voice'],
      originalText: '苗韵是一个身材瘦弱、皮肤白皙的女孩。她留着整齐的学生头和厚厚的齐刘海，鼻梁上戴着一副黑框眼镜。她的衣服很普通，整个人看起来朴素而不起眼。',
      rewrittenText: '被叫苗韵的女生白白瘦瘦，简单清爽的学生头，厚厚的齐刘海，还有戴着一副又笨又土的眼镜，乍一看简直是翻版沈眠枝，但她身上的东西廉价很多，看上去灰扑扑的一点都不起眼。',
      rewritePrinciples: [
        '外貌描写要带观察者的比较和判断，不做中性五官清单',
        '选择能暴露人物经济处境的眼镜和穿着，而不是平均描写全身',
        '允许又笨又土、灰扑扑等带立场的词进入叙述声音'
      ],
      preservedFacts: ['苗韵白瘦、学生头、齐刘海、戴眼镜', '她的物品廉价且不起眼'],
      forbiddenChanges: ['不得美化成精致少女', '不得添加身高、眸色等无关五官参数'],
      priority: 75
    },
    {
      title: '《白月光》·用来不及回应改写离别情绪',
      sceneTypes: ['emotional_conflict', 'dialogue'],
      aiSymptoms: ['emotion_telling', 'summary_closure'],
      originalText: '汽车即将离开，傅绥尔依依不舍地向母亲告别。她探出车窗亲吻了母亲，并大声表达自己的爱。沈娇听后十分感动，眼眶湿润地目送女儿远去。这一刻，她意识到女儿真的长大了。',
      rewrittenText: '傅绥尔探出头，贴着沈娇的脸轻轻吻下。还是一头叛逆的绿毛，但笑容却明媚发着光。“妈妈，你是我在这个世界上最爱的人，你等我！我一定会找到魔法保护你的。”沈娇怔然，一下失神僵在原地。傅绥尔笑着朝她招手，等沈娇反应过来，她们已经隔了很远的距离。',
      rewritePrinciples: [
        '用叛逆外形与直白爱意形成反差，不概括依依不舍',
        '让被告别的人来不及回应，距离已经拉开，情绪自然留下余量',
        '删除她意识到女儿长大的总结句'
      ],
      preservedFacts: ['傅绥尔亲吻并向沈娇告白', '汽车正在离开', '沈娇一时没有反应过来'],
      forbiddenChanges: ['不得增加哭泣拥抱', '不得用作者结论封闭余韵'],
      priority: 85
    },
    {
      title: '《白月光》·用阵营关系改写群体打斗',
      sceneTypes: ['combat', 'action'],
      aiSymptoms: ['shot_chain', 'over_explanation'],
      originalText: '姚淄磊趁沈归灵不注意抬腿发动攻击。就在这千钧一发之际，沈清予迅速冲进人群。他伸出手抓住姚淄磊的衣领，另一只手握成拳头，狠狠击中对方的脸。随后双方摆开架势，激烈地打斗起来。',
      rewrittenText: '“狗逼东西！”一道懒洋洋的声音响起，两道人影加入战场。沈清予一把揪住姚淄磊的衣襟对着他的脸一拳揍去，“踩我家的车就算了，还敢踩我家的脸，真当你爸爸没脾气？”姚淄磊一看是沈清予，发了疯似的打癫架。“来啊。新仇旧恨一起算。”',
      rewritePrinciples: [
        '用声音和立场先让人物入场，不交代冲刺路线',
        '动作只写决定攻防结果的一抓一拳，其余交给打癫架概括',
        '让台词同时交代参战原因、阵营关系和人物脾气'
      ],
      preservedFacts: ['沈清予加入战斗并攻击姚淄磊', '冲突涉及沈家的车和脸面', '双方有旧仇'],
      forbiddenChanges: ['不得添加武术招式和慢镜头', '不得改写成单方面轻松获胜'],
      priority: 85
    },
    {
      title: '《白月光》·把规则说明压进人物生存压力',
      sceneTypes: ['exposition', 'narration'],
      aiSymptoms: ['over_explanation', 'uniform_information', 'written_connectors'],
      originalText: '育才学校设置了严格的奖学金制度。首先，每个学期会提供十个学费全免名额。其次，德才班学生必须达到标准线，如果补考仍然失败就会被勒令转学。此外，毕业生的大学费用将由财阀家族承担，但他们毕业后需要进入相应企业工作。',
      rewrittenText: '德才内部的竞争机制很残酷，英才班的同学过及格线就可以，但德才班的却要过标准线。英才班的同学不及格可以补考一次，不合格顶多就是留级，德才班的同学补考不过将被取消就读资格，强制勒令转学。尽管育才学费昂贵，淘汰机制残酷，但它依旧是无数寒门学子削尖了头都想跨入的门槛。因为如果能顺利能从德才班毕业，A国顶级财阀家族将会资助他们上大学期间所有的费用，作为回报，学生在毕业后必须进入这些家族企业为其效力。在A国，关乎民生的行业基本已经被财阀家族垄断了，一般人已经很难实现阶级跨越，所以入德才对寒门学子来说无异于鲤鱼跃龙门。育才每学期都有十个学费全免的名额，为了这十个名额大家都是不要命的学习。',
      rewritePrinciples: [
        '规则只保留会改变人物命运的差异、门槛和代价',
        '先写不同班级失败后的不同结果，让制度不公可被直接感受',
        '用削尖了头、不要命等人物世界里的措辞替代首先其次此外'
      ],
      preservedFacts: ['德才班补考失败会被勒令转学', '育才每学期有十个全免名额', '寒门学生高度依赖名额'],
      forbiddenChanges: ['不得虚构新的校规数字', '不得把说明写成条款列表'],
      priority: 80
    },
    {
      title: '《白月光》·用动作余波完成场景过渡',
      sceneTypes: ['transition', 'action'],
      aiSymptoms: ['summary_closure', 'written_connectors'],
      originalText: '告别终于结束了。随后，汽车缓缓离开沈园，驶向远方的盘山公路。经过刚才感人的一幕，车内的众人都久久不能平静。与此同时，姜花衫坐在后排，准备开始新的旅程。',
      rewrittenText: '汽车驶向盘山公路，沈让眼眶微红，通过后视镜朝傅绥尔竖起大拇指。有时候孩子长大也只是一瞬间的事。姜花衫侧头看了傅绥尔一眼，情绪很淡，抱着小乌龟玩它的肚皮。',
      rewritePrinciples: [
        '新场景从仍在持续的情绪余波切入，不写随后、与此同时',
        '用后视镜和竖拇指交代人物仍在车里以及上一幕的影响',
        '让另一个人物的冷淡小动作打破统一感动，顺势开启车内关系'
      ],
      preservedFacts: ['汽车驶上盘山公路', '沈让受到傅绥尔告别的触动', '姜花衫在车内抱着小乌龟'],
      forbiddenChanges: ['不得用新旅程开始了概括过渡', '不得让所有人物拥有相同情绪'],
      priority: 75
    },
    {
      title: '《白月光》·先立人物锋芒再交代履历',
      sceneTypes: ['narration'],
      aiSymptoms: ['over_explanation', 'regular_sentence_rhythm', 'generic_voice'],
      originalText: '沈清予是沈家的少爷，性格桀骜不驯。他除了沈庄之外不服从任何人。上一世，在沈庄宣布继承人以后，他与家族产生矛盾并选择离开沈家。后来他依靠母家的帮助发展事业，最终拥有了强大的商业实力。',
      rewrittenText: '沈清予。沈家最混不吝的小霸王。整个沈家除了沈庄他就没服过谁。上一世，老爷子召开家族会议，宣布百年之后由沈兰曦继承沈家家主之位，沈清予当场发飙，第一次跟老爷子红了脸转头出了沈园，第二天就登报单方面宣布与沈家断绝关系。',
      rewritePrinciples: [
        '先用姓名和带立场的短句钉住人物印象，再展开关键履历',
        '履历只选择最能证明性格的一次公开决裂，不概括全部人生',
        '用当场发飙、登报断绝关系等可验证行动代替桀骜不驯标签'
      ],
      preservedFacts: ['沈清予只服沈庄', '他反对沈兰曦成为继承人', '他公开与沈家断绝关系'],
      forbiddenChanges: ['不得罗列完整人物简历', '不得把锋利人物写成中性介绍'],
      priority: 80
    }
  ]
}]
