/**
 * SR30 + 组合策略实验
 *
 * 目标：把 SR30 的 100%疑似AI 推向人工特征
 *
 * 实验组：
 * T1: SR30 + H1 低频词替换（纯技术，无人类文本）
 * T2: 20%人类前置 + 80% SR30
 * T3: 30%人类前置 + 70% SR30
 * T4: 人类段落逐段交替插入 SR30（~30%人类）
 * T5: 人类段落逐段交替插入 SR30（~50%人类）
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const expDir = path.join(projectRoot, 'docs/experiments')

// ── 人类文本（凡人修仙传原文，从 Q4 提取前 13 行）──

const HUMAN_LINES = [
  '这是一个小城，说是小城其实只是一个大点的镇子，名字也叫青牛镇，只有那些住在附近山沟里、没啥见识的土人，才"青牛城""青牛城"的叫个不停。这是干了十几年门丁的张二心里话。',
  '青牛镇的确不大，主街道只有一条东西方向的青牛街，连客栈也只有一家青牛客栈，客栈坐落在长条形状的镇子西端，所以过往的商客不想露宿野外的话，也只能住在这里。',
  '现在有一辆一看就是赶了不少路的马车，从西边驶入青牛镇，飞快的驶过青牛客栈的大门前，停都不停，一直飞驰到镇子的另一端，春香酒楼的门口前，才停了下来。',
  '春香酒楼不算大，甚至还有些陈旧，但却有一种古色古香的韵味。因为现在正是午饭时分，酒楼里用饭的客人还很多，几乎称得上是座无虚席。',
  '从车上下来一个圆脸带着小胡子的胖男子和一个皮肤黝黑的、十来岁的小孩，男子带着孩童直接就大摇大摆地进了酒楼。有酒楼里的熟客认得胖子，知道他是这个酒楼的掌柜"韩胖子"，那个小孩是谁却无人认得。',
  '"老韩，这个黑小子长的和你很像，不会是你背着家里婆娘生的儿子吧。"有个人突然打趣道。',
  '这句话一出，惹得旁边的众人哈哈一阵大笑。',
  '"呸！这是我本家带来的亲侄子，当然和我有几分像了。"胖子不但没生气，还有几分得意。',
  '这二人正是一连赶了三天路，才刚进镇子的韩立和他的三叔——别人口中的"韩胖子"。',
  '韩胖子招呼了几位熟客一声，便把韩立带到酒楼后面，来到了一个偏僻小院子里。',
  '"小立，你在这屋里好好休息下，养好精神，等内门的管事一来，我就叫你过去。我要先出去一下，招呼几位熟客。"韩胖子指着院里的厢房，和蔼的对他说道。',
  '说完，便转身匆忙地向外走去。',
  '到门口时，他似乎心里又有些不太放心，又嘱咐了一句："别乱跑啊，镇子里人太多，别走丢了，最好别出院子。"',
  '看到韩立老实的答应了一声，他才真正放心的走了出去。',
  '韩立见到三叔走出了屋子，感到很累，便一头倒在床上呼呼的睡了起来，竟然没有一点小孩子怕生的感觉。',
  '到晚上，有个小厮送来了饭菜，虽然不是大鱼大肉，倒也算是可口。吃完后，一小厮又走了进来，把吃剩饭碗给端了出去，这时三叔才不慌不忙的走了进来。',
  '"怎么样，饭菜还合你胃口吧，有些想家了吧？"',
]

const humanText = HUMAN_LINES.join('\n')
const humanChars = humanText.length

// ── H1 低频词替换表（从 builtin-anti-ai-vocab.ts 提取核心条目）──

const H1_REPLACEMENTS = [
  ['然而', ['可', '但', '不过']],
  ['因此', ['所以', '这才']],
  ['仿佛', ['好像', '活像', '跟']],
  ['宛如', ['好似', '活像']],
  ['犹如', ['好像', '跟']],
  ['随即', ['转眼', '紧跟着']],
  ['不禁', ['忍不住', '没忍住', '']],
  ['缓缓', ['慢悠悠', '']],
  ['微微', ['略微', '稍稍', '有点']],
  ['静静', ['安静地', '就那么']],
  ['默默', ['没吱声', '']],
  ['凝视', ['盯着', '瞅着']],
  ['注视', ['看着', '瞅着']],
  ['目光', ['眼神', '视线']],
  ['端详', ['打量', '看了看']],
  ['伫立', ['站着', '杵着']],
  ['思绪', ['念头', '想法']],
  ['忽然', ['冷不丁', '猛不防']],
  ['似乎', ['像是', '好像', '八成']],
  ['显然', ['明摆着', '一看就', '分明']],
  ['迅速', ['麻溜', '飞快', '赶紧']],
  ['立刻', ['赶忙', '当即']],
  ['顿时', ['一下子', '登时']],
  ['非常', ['特别', '格外']],
  ['十分', ['挺', '相当', '怪']],
  ['意识到', ['回过味来', '琢磨明白']],
  ['注意到', ['瞅见', '留意到']],
  ['惊讶', ['吃了一惊', '一愣']],
  ['不由自主', ['鬼使神差', '下意识', '没过脑子']],
  ['嘴角上扬', ['嘴角一歪', '咧了咧嘴']],
  ['点了点头', ['嗯了一声', '应了一声']],
  ['摇了摇头', ['晃了下脑袋', '摆了摆手']],
  ['陷入沉思', ['出了一会儿神', '琢磨了半天']],
  ['愣在原地', ['整个人定住了', '呆了一呆']],
  ['没等她开口', ['她话还没出口', '她嘴刚张开']],
]

function applyH1(text) {
  let result = text
  for (const [source, targets] of H1_REPLACEMENTS) {
    const regex = new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    result = result.replace(regex, () => {
      const validTargets = targets.filter(t => t.length > 0)
      if (validTargets.length === 0) return ''
      return validTargets[Math.floor(Math.random() * validTargets.length)]
    })
  }
  return result
}

function splitIntoParas(text) {
  return text.split('\n').filter(l => l.trim().length > 0)
}

function interleave(humanParas, aiParas, humanRatio) {
  const result = []
  const totalTarget = humanParas.length + aiParas.length
  const humanTarget = Math.round(totalTarget * humanRatio)

  if (humanRatio <= 0.35) {
    const step = Math.max(1, Math.floor(aiParas.length / humanTarget))
    let hi = 0
    for (let i = 0; i < aiParas.length; i++) {
      if (i % step === 0 && hi < humanParas.length && result.length < totalTarget) {
        result.push(humanParas[hi++])
      }
      result.push(aiParas[i])
    }
    while (hi < humanParas.length) result.push(humanParas[hi++])
  } else {
    let hi = 0, ai = 0
    while (hi < humanParas.length || ai < aiParas.length) {
      if (hi < humanParas.length) result.push(humanParas[hi++])
      if (ai < aiParas.length) result.push(aiParas[ai++])
    }
  }
  return result
}

// ── 主流程 ──

const sr30Text = fs.readFileSync(path.join(expDir, 'SR30-F1-ai-novel.txt'), 'utf8').trimEnd()
const sr30Chars = sr30Text.length
const sr30Paras = splitIntoParas(sr30Text)
const humanParas = splitIntoParas(humanText)

console.log(`SR30: ${sr30Chars} 字, ${sr30Paras.length} 段`)
console.log(`人类文本: ${humanChars} 字, ${humanParas.length} 段\n`)

// T1: SR30 + H1 低频词替换
{
  const result = applyH1(sr30Text)
  const outPath = path.join(expDir, 'T1-SR30-H1-F1.txt')
  fs.writeFileSync(outPath, result + '\n', 'utf8')
  console.log(`T1 (SR30+H1): ${outPath}`)
}

// T2: 20%人前置 + 80%SR30
{
  const targetHumanChars = Math.round((sr30Chars + humanChars) * 0.20)
  let humanPortion = ''
  for (const line of HUMAN_LINES) {
    if (humanPortion.length + line.length > targetHumanChars) break
    humanPortion += line + '\n'
  }
  const result = humanPortion + sr30Text
  const outPath = path.join(expDir, 'T2-20human-SR30-F1.txt')
  fs.writeFileSync(outPath, result + '\n', 'utf8')
  const actualHumanPct = (humanPortion.length / result.length * 100).toFixed(0)
  console.log(`T2 (${actualHumanPct}%人前置+SR30): ${outPath}`)
}

// T3: 30%人前置 + 70%SR30
{
  const targetHumanChars = Math.round((sr30Chars + humanChars) * 0.30)
  let humanPortion = ''
  for (const line of HUMAN_LINES) {
    if (humanPortion.length + line.length > targetHumanChars) break
    humanPortion += line + '\n'
  }
  const result = humanPortion + sr30Text
  const outPath = path.join(expDir, 'T3-30human-SR30-F1.txt')
  fs.writeFileSync(outPath, result + '\n', 'utf8')
  const actualHumanPct = (humanPortion.length / result.length * 100).toFixed(0)
  console.log(`T3 (${actualHumanPct}%人前置+SR30): ${outPath}`)
}

// T4: ~30%人类交替插入SR30
{
  const hParas = humanParas.slice(0, 6)
  const combined = interleave(hParas, sr30Paras, 0.3)
  const result = combined.join('\n')
  const hChars = hParas.join('').length
  const actualPct = (hChars / result.length * 100).toFixed(0)
  const outPath = path.join(expDir, 'T4-30human-interleave-SR30-F1.txt')
  fs.writeFileSync(outPath, result + '\n', 'utf8')
  console.log(`T4 (~${actualPct}%人交替+SR30): ${outPath}`)
}

// T5: ~50%人类交替插入SR30
{
  const combined = interleave(humanParas, sr30Paras, 0.5)
  const result = combined.join('\n')
  const hChars = humanParas.join('').length
  const actualPct = (hChars / result.length * 100).toFixed(0)
  const outPath = path.join(expDir, 'T5-50human-interleave-SR30-F1.txt')
  fs.writeFileSync(outPath, result + '\n', 'utf8')
  console.log(`T5 (~${actualPct}%人交替+SR30): ${outPath}`)
}

console.log('\n完成！')
