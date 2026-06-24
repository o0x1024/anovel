/**
 * 可读 n-gram 断裂实验
 *
 * 基于 WS 系列实验结论：朱雀检测粒度 = 相邻 2-3 词 n-gram 共现概率。
 * 本脚本测试三种保持可读性的 n-gram 断裂策略：
 *
 *   RB1 — 虚词微插入（在内容词之间插入助词/语气词/量词）
 *   RB2 — 密集同义替换（用更大词表替换常见双字词）
 *   RB3 — 句法重构（把字句、分句重组、状语移位）
 *   RB4 — RB1+RB2+RB3 组合
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

// ────────────────── 伪随机 ──────────────────

function hashSeed(text) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function createRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return state / 0x100000000
  }
}

function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)]
}

// ────────────────── RB1: 虚词微插入 ──────────────────
// 在动词后插入「了/着/过/了一下」，在形容词前插入「很/挺/有些」
// 在分句尾偶尔加「呢/吧/嘛」—— 打断相邻词的 bigram

const VERB_SUFFIXES = ['了', '了', '着', '过', '了一下', '了一声']
const ADJ_PREFIXES = ['很', '挺', '有些', '有点', '颇为']
const CLAUSE_PARTICLES = ['呢', '吧', '嘛', '啊', '哦']

// 常见可接助词的动词尾字（排除名词性、形容词性的）
const VERB_TAIL_CHARS = new Set('看走跑坐站停放拿开关说问听想到过来去出入回拉推拍打扫搬抱端拧扭蹲靠挤掀揭翻拆摸捏握抓摔丢甩踩碾系拎挑扛搅拌切剁擦洗扫拖晒缝编织补递送买卖换吃喝唱读写算拧拨转搅敲碰撞推搡抖甩晃摇摆挥舞刺穿折断裂磨劈砸锤凿涂画填盖搭架围绕绑缠捆扎系浇灌育培扶牵领伸缩弯腰蹲踢跳蹦爬滚摔倒躺卧趴靠歇停留挂贴钉绑')

function rb1_insertParticles(text, rand) {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const lines = text.split('\n')

  return lines.map(line => {
    if (!line.trim()) return line
    const segments = [...segmenter.segment(line)]
    const result = []

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const next = segments[i + 1]
      result.push(seg.segment)

      if (!seg.isWordLike) continue
      const w = seg.segment
      const lastChar = w[w.length - 1]

      // 只在动词性词语后插入助词（约 20%），且后面跟的不是助词
      if (
        w.length >= 1 &&
        VERB_TAIL_CHARS.has(lastChar) &&
        next && next.isWordLike &&
        !/^[了着过的地得吗呢吧啊]/.test(next.segment) &&
        !/[了着过]$/.test(w) &&
        rand() < 0.20
      ) {
        result.push(pick(VERB_SUFFIXES, rand))
      }

      // 逗号前偶尔加语气词（约 6%）
      if (next && /^[，,]$/.test(next.segment) && rand() < 0.06) {
        result.push(pick(CLAUSE_PARTICLES, rand))
      }
    }

    return result.join('')
  }).join('\n')
}

// ────────────────── RB2: 密集同义替换 ──────────────────
// 比现有 humanize-text 更密集的替换，覆盖常见双字实词

const SYNONYM_MAP = [
  ['看着', ['瞧着', '望着', '盯着', '瞅着']],
  ['看了', ['瞧了', '望了', '瞅了']],
  ['走到', ['踱到', '挪到', '凑到']],
  ['走过', ['路过', '经过', '穿过']],
  ['站着', ['杵着', '立着', '待着']],
  ['站在', ['立在', '待在', '杵在']],
  ['坐在', ['窝在', '歪在', '蹲在']],
  ['放在', ['搁在', '摆在', '搁到']],
  ['放下', ['搁下', '撂下', '丢下']],
  ['拿起', ['抄起', '捡起', '提起']],
  ['打开', ['推开', '掀开', '拉开']],
  ['关上', ['带上', '阖上', '合上']],
  ['回头', ['扭头', '转头', '回过头']],
  ['抬头', ['仰头', '抬起头', '扬起脸']],
  ['低头', ['埋头', '垂头', '低下头']],
  ['转身', ['扭身', '回身', '侧过身']],
  ['发现', ['瞅见', '发觉', '察觉']],
  ['觉得', ['寻思', '琢磨', '感觉']],
  ['知道', ['晓得', '清楚', '明白']],
  ['一下', ['一瞬', '一刹', '一霎']],
  ['突然', ['忽然', '冷不丁', '猛地']],
  ['已经', ['早已', '早就', '都']],
  ['终于', ['总算', '可算', '到底']],
  ['马上', ['赶紧', '立刻', '麻利']],
  ['慢慢', ['渐渐', '缓缓', '一点点']],
  ['轻轻', ['悄悄', '柔柔', '轻手轻脚']],
  ['声音', ['嗓音', '动静', '音儿']],
  ['眼睛', ['眼珠', '双眼', '眼']],
  ['脸上', ['面上', '脸面上', '面庞上']],
  ['手里', ['手上', '掌心', '手中']],
  ['身上', ['身子上', '浑身', '周身']],
  ['门口', ['门前', '门边', '门跟前']],
  ['旁边', ['边上', '一旁', '跟前']],
  ['前面', ['前头', '前边', '前方']],
  ['后面', ['后头', '后边', '身后']],
  ['里面', ['里头', '内里', '当中']],
  ['外面', ['外头', '外边']],
  ['上面', ['上头', '上边']],
  ['这时', ['这会儿', '这当口', '这时节']],
  ['那时', ['那会儿', '那阵子', '当时']],
  ['一些', ['几分', '些许', '若干']],
  ['好像', ['仿佛', '似乎', '像是']],
  ['因为', ['因着', '只因', '缘由是']],
  ['所以', ['因此', '故而', '这才']],
  ['但是', ['可是', '不过', '然而']],
  ['非常', ['十分', '甚是', '极为']],
  ['安静', ['静悄悄', '寂静', '无声']],
  ['开始', ['起先', '起初', '着手']],
  ['继续', ['接着', '接茬', '又']],
  ['周围', ['四周', '左右', '四下']],
  ['一直', ['始终', '一路', '一径']],
  ['还是', ['依旧', '照旧', '仍然']],
  ['赶紧', ['连忙', '急忙', '赶忙']],
  ['不大', ['不太', '不甚', '不怎么']],
  ['那个', ['那位', '那人']],
  ['这个', ['这位', '此人']],
  ['什么', ['啥', '甚么']],
  ['怎么', ['咋', '如何']],
]

function rb2_synonymReplace(text, rand) {
  let result = text
  for (const [source, targets] of SYNONYM_MAP) {
    const re = new RegExp(source, 'g')
    result = result.replace(re, (match) => {
      if (rand() < 0.55) return pick(targets, rand)
      return match
    })
  }
  return result
}

// ────────────────── RB3: 句法重构 ──────────────────
// 把字句转换、分句重组、定语后置

function rb3_syntacticRestructure(text, rand) {
  let result = text

  // 1. SVO → 把字句: "他打开了门" → "他把门打开了"
  //    匹配: 他/她 + 2字动词 + 了 + 1-4字名词
  result = result.replace(
    /([她他它])([^\s，。！？]{2})(了)([^\s，。！？]{1,4})/g,
    (m, subj, verb, le, obj) => {
      if (rand() < 0.35) return `${subj}把${obj}${verb}${le}`
      return m
    }
  )

  // 2. 定语提取: "穿灰T恤的男生" 类结构不好通用处理，跳过

  // 3. 逗号分句前后交换（约 20%）
  result = result.replace(
    /([^，。！？\n]{4,20})，([^，。！？\n]{4,20})/g,
    (m, a, b) => {
      if (rand() < 0.20 && !a.startsWith('"') && !b.endsWith('"')) {
        return `${b}，${a}`
      }
      return m
    }
  )

  // 4. 在 "在...的时候" 结构后移
  result = result.replace(
    /在([^，。]{3,12})的时候，([^。]{5,30}。)/g,
    (m, when, what) => {
      if (rand() < 0.30) return `${what.replace(/。$/, '')}——${when}的时候。`
      return m
    }
  )

  return result
}

// ────────────────── 组合与输出 ──────────────────

const STRATEGIES = {
  rb1: { name: 'RB1-虚词插入', fn: rb1_insertParticles },
  rb2: { name: 'RB2-同义替换', fn: rb2_synonymReplace },
  rb3: { name: 'RB3-句法重构', fn: rb3_syntacticRestructure },
  rb4: {
    name: 'RB4-组合',
    fn: (text, rand) => {
      let r = text
      r = rb3_syntacticRestructure(r, rand)
      r = rb2_synonymReplace(r, rand)
      r = rb1_insertParticles(r, rand)
      return r
    }
  },
}

const TEST_SOURCES = [
  'A2-ai.txt',
  'A1-human.txt',
  'F1-ai-novel.txt',
  'M4-deepseek.txt',
  'Q6-50human-50ai.txt',
]

function main() {
  const experimentsDir = path.join(projectRoot, 'docs/experiments')
  const results = []

  for (const src of TEST_SOURCES) {
    const srcPath = path.join(experimentsDir, src)
    if (!fs.existsSync(srcPath)) { console.log(`跳过 ${src}`); continue }
    const text = fs.readFileSync(srcPath, 'utf8').trimEnd()

    const base = src.replace(/\.txt$/, '')

    for (const [key, strategy] of Object.entries(STRATEGIES)) {
      const seed = hashSeed(`${base}:${key}`)
      const rand = createRng(seed)
      const out = strategy.fn(text, rand)
      const outName = `${key.toUpperCase()}-${base}.txt`
      const outPath = path.join(experimentsDir, outName)
      fs.writeFileSync(outPath, out + '\n', 'utf8')
      results.push({ strategy: key, source: src, output: outName, chars: out.replace(/\s/g, '').length })
      console.log(`✓ ${outName}`)
    }
  }

  // 打印预览
  console.log('\n=== 预览 RB1 (A2 前3行) ===')
  const rb1a2 = fs.readFileSync(path.join(experimentsDir, 'RB1-A2-ai.txt'), 'utf8')
  rb1a2.split('\n').slice(0, 3).forEach(l => console.log(l.slice(0, 80)))

  console.log('\n=== 预览 RB2 (A2 前3行) ===')
  const rb2a2 = fs.readFileSync(path.join(experimentsDir, 'RB2-A2-ai.txt'), 'utf8')
  rb2a2.split('\n').slice(0, 3).forEach(l => console.log(l.slice(0, 80)))

  console.log('\n=== 预览 RB3 (A2 前3行) ===')
  const rb3a2 = fs.readFileSync(path.join(experimentsDir, 'RB3-A2-ai.txt'), 'utf8')
  rb3a2.split('\n').slice(0, 3).forEach(l => console.log(l.slice(0, 80)))

  console.log('\n=== 预览 RB4 (A2 前3行) ===')
  const rb4a2 = fs.readFileSync(path.join(experimentsDir, 'RB4-A2-ai.txt'), 'utf8')
  rb4a2.split('\n').slice(0, 3).forEach(l => console.log(l.slice(0, 80)))

  console.log(`\n共生成 ${results.length} 个文件`)
}

main()
