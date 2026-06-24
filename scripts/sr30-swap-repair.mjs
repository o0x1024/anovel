/**
 * RE 系列：V5 (45% 叙述段 swap) + 程序化可读修复（不用 LLM）
 *
 * 修复：人名、量词、固定搭配、常见 swap 破坏模式
 * 保留大部分 swap 扰动以维持人工特征
 *
 * 用法: node scripts/sr30-swap-repair.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { hashSeed, createRng, splitSentences } from './word-shuffle.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const experimentsDir = path.join(projectRoot, 'docs/experiments')

const SR30 = path.join(experimentsDir, 'SR30-F1-ai-novel.txt')
const V5 = path.join(experimentsDir, 'V5-SR30-narr-swap45.txt')

function isDialogueLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^["\u201c\u300c]/.test(trimmed)) return true
  if (trimmed.length <= 6) return true
  return false
}

/** 宽保护：2 字以下 + 结构词均不 swap → 52% 名义率仅 ~4% 有效，朱雀 100% 疑似AI */
const SWAP_PROTECT_WIDE = /^[的了地得着过吗呢吧啊呀嘛在把被将给和与从向对就也都还又才已很太更最不没会要能可这那其而于以之]$/
/** 窄保护：仅单字助词不 swap */
const SWAP_PROTECT_NARROW = /^[的了地得着过吗呢吧啊呀嘛]$/
/** 虚词/结构词 — 仅 swap 含此类 token 的相邻对（RE7 全 swap 有效因打乱这类 bigram） */
const PARTICLE_TARGET = /^[的了地得着过吗呢吧啊呀嘛在把被给与到从向对了也都很就不没会]$/

function isParticleTarget(text) {
  if (!text) return false
  return PARTICLE_TARGET.test(text)
}

function canSwapPair(ta, tb, protectMode) {
  if (!protectMode) return true
  if (protectMode === 'wide') {
    return isSwappableToken(ta, 'wide') && isSwappableToken(tb, 'wide')
  }
  if (protectMode === 'narrow') {
    return isSwappableToken(ta, 'narrow') && isSwappableToken(tb, 'narrow')
  }
  if (protectMode === 'particle') {
    return isParticleTarget(ta) || isParticleTarget(tb)
  }
  return true
}

function isSwappableToken(text, protectMode) {
  if (!text || !/\p{Script=Han}/u.test(text)) return false
  if (!protectMode) return true
  if (protectMode === 'wide') {
    if (text.length < 2) return false
    if (SWAP_PROTECT_WIDE.test(text)) return false
    return true
  }
  if (protectMode === 'narrow') {
    if (SWAP_PROTECT_NARROW.test(text)) return false
    return true
  }
  return true
}

function swapAdjacentWords(sentence, rand, rate, { protectMode = false } = {}) {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const tokens = [...segmenter.segment(sentence)].map(s => ({
    text: s.segment,
    word: s.isWordLike,
  }))
  if (tokens.length <= 2) return sentence
  const wordIdx = tokens.map((t, i) => (t.word ? i : -1)).filter(i => i >= 0)
  if (wordIdx.length <= 1) return sentence
  for (let k = 0; k < wordIdx.length - 1; k++) {
    if (rand() > rate) continue
    const a = wordIdx[k]
    const b = wordIdx[k + 1]
    if (!canSwapPair(tokens[a].text, tokens[b].text, protectMode)) continue
    ;[tokens[a].text, tokens[b].text] = [tokens[b].text, tokens[a].text]
  }
  return tokens.map(t => t.text).join('')
}

function swapDual(sentence, rand, { particleRate = 0.88, fullRate = 0.25 } = {}) {
  let s = swapAdjacentWords(sentence, rand, particleRate, { protectMode: 'particle' })
  s = swapAdjacentWords(s, rand, fullRate, { protectMode: false })
  return s
}

function swapLine(original, line, lineIndex, rate, { protectMode = false, dual = false, seed = hashSeed(original) } = {}) {
  const trimmed = line.trim()
  if (!trimmed) return line
  const rand = createRng((seed + lineIndex * 9973) >>> 0)
  if (dual) {
    return splitSentences(trimmed)
      .map(s => swapDual(s, rand, { particleRate: rate, fullRate: Math.min(rate * 0.5, 0.3) }))
      .join('')
  }
  return splitSentences(trimmed)
    .map(s => swapAdjacentWords(s, rand, rate, { protectMode }))
    .join('')
}

function swapDocumentSelective(text, rate, { seed = hashSeed(text), protectMode = false, dual = false } = {}) {
  const lines = text.split('\n')
  return lines
    .map((line, i) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (isDialogueLine(trimmed)) return line
      return swapLine(text, line, i, rate, { protectMode, dual, seed })
    })
    .join('\n')
}

/** 全局替换（顺序：长词优先） */
const GLOBAL_FIXES = [
  // 人名
  ['林让晚他盯', '林晚让他盯'],
  ['林端着水杯晚', '林晚端着水杯'],
  ['晚这林才', '林晚这才'],
  ['晚林多打量', '林晚多打量'],
  ['晚喝了林', '林晚喝了'],
  ['晚翻了林', '林晚翻了'],
  ['晚林在蹲', '林晚蹲在'],
  ['林的晚手指', '林晚的手指'],
  ['林没晚合', '林晚没再合'],
  ['林让晚', '林晚让'],
  ['晚这林', '林晚这'],
  ['林的晚', '林晚'],
  ['林没晚', '林晚没'],
  ['晚林', '林晚'],
  ['苏给发糖', '给苏糖发'],
  ['发糖条', '发条'],
  ['糖苏', '苏糖'],
  ['苏秒回叫', '苏糖秒回'],
  // 量词 + 名词
  ['只三猫', '三只猫'],
  ['只猫三', '三只猫'],
  ['只三围', '三只围'],
  ['只三', '三只'],
  ['三猫', '三只猫'],
  ['两了步', '退了两步'],
  ['了一瞬', '停了一瞬'],
  ['了一行', '打了一行'],
  // 固定搭配
  ['屏幕签码收', '签收码'],
  ['签码收', '签收码'],
  ['诶，架爬', '诶，猫爬架'],
  ['诶架爬', '猫爬架'],
  ['猫，诶架爬', '诶，猫爬架'],
  ['爬架的猫', '猫爬架'],
  ['猫架爬', '猫爬架'],
  ['架爬', '爬架'],
  ['穴点了', '点了穴'],
  ['像穴点', '像点穴'],
  ['被像穴点了', '像被点了穴'],
  ['城同', '同城'],
  ['家福全', '全家福'],
  ['口水宿舍', '哪个宿舍'],
  ['晚晚糕', '晚晚糕'],
  ['晚"晚那句还"在糕', '那句"晚晚糕"还在'],
  ['晚"晚那句还"', '那句"晚晚糕"'],
  ['在糕打转', '在脑子里打转'],
  ['配送费', '配送费'],
  ['平台付过', '平台付过'],
  ['猫爬架', '猫爬架'],
  ['螺丝刀', '螺丝刀'],
  ['工具箱', '工具箱'],
  ['连接处', '连接处'],
  ['旧木地板', '旧木地板'],
  ['旧相框', '旧相框'],
  ['旧相册', '旧相册'],
  ['红浆果干', '红浆果干'],
  ['羊角辫', '羊角辫'],
  ['英短', '英短'],
  ['流浪猫', '流浪猫'],
  // 动宾常见颠倒
  ['把刀螺丝', '把螺丝刀'],
  ['刀螺丝', '螺丝刀'],
  ['搭没手上', '没搭理，手上'],
  ['的理动作停没', '理，动作没停'],
  ['他搭没', '他没搭'],
  ['回过男生神来', '男生回过神来'],
  ['把递手机', '把手机递'],
  ['递过来眼皮', '递过来。眼皮'],
  ['上是个屏幕', '屏幕上是个'],
  ['了拉开门', '拉开了门'],
  ['着脚光过踩', '光着脚踩过'],
  ['甩她了上甩手', '她甩了甩手上'],
  ['旧地板木', '旧木地板'],
  ['扶个半着人高', '扶着个半人高'],
  ['站个着穿', '站着个穿'],
  ['的瘦瘦', '瘦瘦的'],
  ['他抬头她看', '他抬头看她'],
  ['眼神刚她人', '眼神刚碰到她，人'],
  ['就碰到了僵住', '人就僵住了'],
  ['弯抱起箱子他', '他弯腰抱起箱子'],
  ['从她挤进旁边门', '从她旁边挤进门'],
  ['碎发着跟', '碎发炸着'],
  ['没梳炸似的头', '跟没梳头似的'],
  ['她上门关', '她关上门'],
  ['朝尽头指了客厅指', '朝客厅尽头指了指'],
  ['皮肤黑左', '皮肤偏黑，左'],
  ['小偏淡褐色', '小痣，淡褐色'],
  ['痣看，着', '，看着'],
  ['半一时想会不起哪儿见过在', '一时半会想不起在哪儿见过'],
  ['摇她头没，再摇琢磨', '她摇摇头，没再琢磨'],
  ['去厨房倒了转身水杯', '转身去厨房倒了杯水'],
  ['把猫爬男生搬到架阳台', '男生把猫爬架搬到阳台'],
  ['箱子上撕的封胶带', '撕箱子上的封胶带'],
  ['猫凑上去猫他的裤闻脚', '橘猫凑上去闻他的裤脚'],
  ['猫黑跳上了', '黑猫跳上了'],
  ['了两步退', '退了两步'],
  ['把他件一件件拿出来组', '他把组件一件件拿出来'],
  ['指尖过窗台蹭顿了，时一下', '指尖蹭过窗台时，顿了一下'],
  ['相框里头，个旧张是黄的全家福泛', '旧相框，里头是张泛黄的全家福'],
  ['照片扎里羊角辫的小被女孩抱在外婆里笑得，怀弯眼睛弯的', '照片里扎羊角辫的小女孩被外婆抱在怀里，笑得眼睛弯弯的'],
  ['盯他那着张看了两秒照片', '他盯着那张照片看了两秒'],
  ['目光把，猫爬移开架的底座正摆', '目光移开，把猫爬架的底座摆正'],
  ['只猫三着围打转他', '三只猫围着他打转'],
  ['猫橘蹭脚踝他的', '橘猫蹭他的脚踝'],
  ['黑伸猫拨爪子手里他的螺丝刀', '黑猫伸爪子拨他手里的螺丝刀'],
  ['他螺丝刀换到左手把', '他把螺丝刀换到左手'],
  ['指尖不自觉右手地蹭了掌心蹭', '右手指尖不自觉地蹭了蹭掌心'],
  ['纸箱还底压着', '纸箱底还压着'],
  ['红浆果干一袋', '一袋红浆果干'],
  ['随单送店家赠品', '店家随单送的赠品'],
  ['林端着水杯晚走过时来', '林晚端着水杯走过来时'],
  ['已经爬架的猫搭主体正，好了蹲', '已经把猫爬架的主体搭好了，正蹲'],
  ['拧在一个最后螺丝', '拧最后一个螺丝'],
  ['瞄了她一眼他手的边相，框全家福', '她瞄了一眼他手边的相框，全家福'],
  ['人没动过', '没人动过'],
  ['她点没，再问点头', '她点点头，没再问'],
  ['少得话但，活干得挺离谱索利', '话少得离谱，但活干得挺利索'],
  ['猫架爬得整整齐齐搭', '猫爬架搭得整整齐齐'],
  ['检查一遍连接了处', '检查了一遍连接处'],
  ['顺手了挠挠黑的下巴猫', '顺手挠了挠黑猫的下巴'],
  ['已经站起来男生', '男生已经站起来'],
  ['把刀螺丝工具箱动作，很放回轻', '把螺丝刀放回工具箱，动作很轻'],
  ['他眼抬扫了一圈目光，在阳台只猫身上三停了一瞬', '他抬眼扫了一圈阳台，目光在三只猫身上停了一瞬'],
  ['最后回她脸上落', '最后落回她脸上'],
  ['很声音轻', '声音很轻'],
  ['像是口说随的出来', '像是随口说出来的'],
  ['这她的是小名', '这是她的小名'],
  ['只有时候小喂的流浪猫那只她——知道', '只有小时候喂的那只流浪猫知道——她'],
  ['每次蹲在叫晚"晚糕巷口"', '每次蹲在巷口叫"晚晚糕"'],
  ['那只灰扑的扑英就会短墙从角出来钻', '那只灰扑扑的英短就会从墙角钻出来'],
  ['蹭掌心她的', '蹭她的掌心'],
  ['去世外婆再没，后这么人叫过她', '外婆去世后，再没人这么叫过她'],
  ['像男生呛到了被', '男生像被呛到了'],
  ['猛咳嗽地两声', '猛地咳嗽两声'],
  ['过头偏去', '偏过头去'],
  ['耳根发红眼下', '耳根有点发红，眼下'],
  ['有点的痣颜色了深几分', '痣颜色深了几分'],
  ['没她等开口', '没等她开口'],
  ['已经他起工具箱拎', '他已经拎起工具箱'],
  ['快步她从挤过去旁边', '快步从她旁边挤过去'],
  ['鞋都没直接，踩过换地板出了门', '鞋都没换，直接踩过地板出了门'],
  ['晚林在蹲手里，阳台还捏那着水杯', '林晚蹲在阳台，手里还捏着那杯水'],
  ['只三猫围过来', '三只猫围过来'],
  ['猫舔橘她的手指', '橘猫舔她的手指'],
  ['黑歪头看猫白猫', '黑猫歪头看她，白猫'],
  ['跳上她刚的搭好爬架趴在，猫最高处', '跳上刚搭好的猫爬架，趴在最高处'],
  ['苏给发糖条语音今天', '给苏糖发了条语音'],
  ['送了猫架爬学弟的怪好', '今天送猫爬架的学弟好怪'],
  ['全程就了三个蹦', '全程就蹦了三个'],
  ['的嗯时候突然我叫小完了，还名自己跑路咳嗽', '"嗯"。走的时候突然叫我小名，完了还自己咳嗽跑路'],
  ['苏秒回叫', '苏糖秒回'],
  ['？？糖小你他？名知道的怎么', '？？叫你小名？他怎么知道的'],
  ['苏糖沉默了几秒然后，发那边来一串哈哈哈', '苏糖那边沉默了几秒，然后发来一串哈哈哈'],
  ['完了桃花，运你来下次。了请喝人答谢奶茶', '你完了，桃花运来了。下次请人喝奶茶答谢'],
  ['晚"晚那句还"在糕打转脑子里', '那句"晚晚糕"还在脑子里打转'],
  ['她站把，起身的喝完水杯茶几上放到', '她站起身，把喝完的水杯放到茶几上'],
  ['书桌时瞥，见路过抽屉半开着', '路过书桌时，瞥见抽屉半开着'],
  ['前整理几天的旧物最上面，放出来外婆留下的着那旧本册相', '前几天整理出来的旧物，最上面放着外婆留下的那本旧相册'],
  ['已经毛了磨边', '已经磨毛了边'],
  ['那种的老式插塑料页', '那种老式的塑料插页'],
  ['几页是她前小学时的扎，照片歪歪的着辫蹲', '前几页是她小学时的照片，扎着歪歪的羊角辫'],
  ['在羊角房子的老门口院', '蹲在老房子的院门口'],
  ['灰扑扑的尾巴，尖有毛白斑一块', '灰扑扑的毛，尾巴尖有一块白斑'],
  ['蹲在猫她脚边', '猫蹲在她脚边'],
  ['去低头吃她的猫手心粮', '低头去吃她手心的猫粮'],
  ['她时候那不会相机调', '她那时候不会调相机'],
  ['拍了歪', '拍歪了'],
  ['只露了半张猫脸', '猫只露了半张脸'],
  ['眼下但淡褐色的拍得很清楚斑纹', '但眼下的淡褐色斑纹拍得很清楚'],
  ['左就在眼正下方', '就在左眼正下方'],
  ['和位置今天她的一，模一样看到', '位置和她今天看到的，一模一样'],
  ['相压册膝盖在沉甸甸，的上', '相册压在膝盖上，沉甸甸的'],
  ['猫爬被架动蹭的声响', '猫爬架被蹭动的声响'],
  ['从最高白猫平台的跳下来', '白猫从最高的平台跳下来'],
  ['到她蹭边脚', '蹭到她脚边'],
  ['低头她着看它', '她低头看着它'],
  ['林没晚合，再说下去上相册，把塞它回抽屉', '林晚没再说下去，合上相册，把它塞回抽屉'],
  ['手机震了又一下', '手机又震了一下'],
  ['苏糖发来的是消息', '是苏糖发来的消息'],
  ['你说翻上次旧相册', '你上次说翻旧相册'],
  ['发现没什么', '发现什么没'],
  ['明天过来一趟有，你东西给你看', '明天你过来一趟，有东西给你看'],
]

/** 仅修复「看不懂」的关键破坏（约 35 条，远少于 RE2 的 120 条） */
const CRITICAL_FIXES = [
  ['城同快递', '同城快递'],
  ['那会电话正', '电话那会儿，正'],
  ['三给猫换只水', '给三只猫换水'],
  ['换只水', '换水'],
  ['了拉开门', '拉开了门'],
  ['着脚光过踩', '光着脚踩过'],
  ['旧地板木', '旧木地板'],
  ['站个着穿', '站着个穿'],
  ['的瘦瘦', '瘦瘦的'],
  ['他抬头她看', '他抬头看她'],
  ['眼神刚她人，就碰到了僵住', '眼神刚碰到她，人就僵住了'],
  ['被像穴点了', '像被点了穴'],
  ['林晚让他得浑身盯', '林晚让他盯得浑身'],
  ['不自在他眼前', '在他眼前不自在'],
  ['诶，架爬', '诶，猫爬架'],
  ['诶架爬', '猫爬架'],
  ['签码收', '签收码'],
  ['屏幕签码收', '签收码'],
  ['弯腰抱起箱子他', '他弯腰抱起箱子'],
  ['没梳发似的', '跟没梳头似的'],
  ['她上门朝，关尽头指了客厅指', '她关上门，朝客厅尽头指了指'],
  ['皮肤黑左', '皮肤偏黑，左'],
  ['他搭没手上，的理动作停没', '他没搭理，手上的动作没停'],
  ['家福全', '全家福'],
  ['把猫爬男生搬到架阳台', '男生把猫爬架搬到阳台'],
  ['只三围过来橘', '三只猫围过来，橘'],
  ['只猫三着围', '三只猫围着'],
  ['回过男生神来', '男生回过神来'],
  ['林晚让他盯得浑身伸手，不自在在他眼前', '林晚让他盯得浑身不自在，伸手在他眼前'],
  ['林晚让他盯得浑身伸手', '林晚让他盯得浑身不自在，伸手'],
  ['他抱起箱子弯腰', '他弯腰抱起箱子'],
  ['朝尽头客厅指了指', '朝客厅尽头指了指'],
  ['看着眼熟有点', '看着有点眼熟'],
  ['想不起在见过哪儿', '想不起在哪儿见过'],
  ['去倒了厨房杯水', '去厨房倒了杯水'],
  ['黑猫跳上直接了白猫，纸箱呢', '黑猫直接跳上了纸箱，白猫呢'],
  ['被抱在外婆怀里，眼睛笑得弯弯的', '被外婆抱在怀里，笑得眼睛弯弯的'],
  ['橘猫蹭脚踝他的', '橘猫蹭他的脚踝'],
  ['螺丝刀左手换到', '螺丝刀换到左手'],
  ['林晚水杯走过端着来时', '林晚端着水杯走过来时'],
  ['检查了连接一遍处', '检查了一遍连接处'],
  ['已经站起来男生', '男生已经站起来'],
  ['把螺丝刀工具箱动作，放回很轻', '把螺丝刀放回工具箱，动作很轻'],
  ['扫了一圈目光，阳台在三只猫身上停了最后，一瞬落回她脸上', '抬眼扫了一圈阳台，目光在三只猫身上停了一瞬，最后落回她脸上'],
  ['流浪那只猫知道', '那只流浪猫知道'],
  ['蹭掌心她的', '蹭她的掌心'],
  ['去世外婆后', '外婆去世后'],
  ['耳根发红眼下，有点的痣颜色深了几分', '耳根有点发红，眼下痣颜色深了几分'],
  ['林晚蹲在手里，阳台还捏着那杯水', '林晚蹲在阳台，手里还捏着那杯水'],
  ['给苏糖发了条今天', '给苏糖发了条语音'],
  ['他知道怎么的', '他怎么知道的'],
  ['指尖不自觉右手地蹭了蹭掌心', '右手指尖不自觉地蹭了蹭掌心'],
  ['他抬眼抬眼', '他抬眼'],
  ['语音送猫爬架', '今天送猫爬架'],
  ['跳上白猫刚搭好的猫爬架', '白猫跳上刚搭好的猫爬架'],
  ['递过来眼皮。上是个', '递过来。眼皮耷拉下去。屏幕上是个'],
  ['晚忍不住', '林晚忍不住'], // 仅当行首缺「林」时
  ['林端着水杯晚', '林晚端着水杯'],
  ['糖苏', '苏糖'],
  ['晚林', '林晚'],
]

function applyNameRepair(line, orig) {
  let t = line
  if (!orig.includes('林晚')) return t
  t = t.replace(/晚林/g, '林晚')
  t = t.replace(/林让晚/g, '林晚让')
  t = t.replace(/晚这林/g, '林晚这')
  t = t.replace(/林的晚/g, '林晚')
  t = t.replace(/林端着水杯晚/g, '林晚端着水杯')
  t = t.replace(/(?<![林])晚忍不住/g, '林晚忍不住')
  t = t.replace(/晚喝了林/g, '林晚喝了')
  t = t.replace(/晚翻了林/g, '林晚翻了')
  return t
}

function applyMeasureRepair(line, orig) {
  let t = line
  if (orig.includes('苏糖')) t = t.replace(/糖苏/g, '苏糖')
  if (orig.includes('三只')) {
    t = t.replace(/只三/g, '三只')
    t = t.replace(/只猫三/g, '三只猫')
    t = t.replace(/([^只])三猫/g, '$1三只猫')
    t = t.replace(/三给猫/g, '给三只猫')
  }
  if (orig.includes('两步')) t = t.replace(/了两步退/g, '退了两步')
  return t
}

function applyCriticalRepair(text) {
  let t = text
  for (const [broken, fixed] of CRITICAL_FIXES) {
    if (broken === '晚忍不住') {
      t = t.replace(/(?<![林])晚忍不住/g, '林晚忍不住')
      continue
    }
    if (t.includes(broken)) t = t.split(broken).join(fixed)
  }
  return t
}

/** 从 GLOBAL_FIXES 取前 N 条有效规则（跳过同义替换） */
function applyGlobalFixesPartial(text, maxRules = 80) {
  let t = text
  let applied = 0
  for (const [broken, fixed] of GLOBAL_FIXES) {
    if (broken === fixed) continue
    if (applied >= maxRules) break
    if (t.includes(broken)) {
      t = t.split(broken).join(fixed)
      applied++
    }
  }
  return t
}

function applyLineRepair(line, orig, { names, measures }) {
  let r = line
  if (names) r = applyNameRepair(r, orig)
  if (measures) r = applyMeasureRepair(r, orig)
  return r
}

function resolveProtectMode({ protectMode, protectParticles }) {
  if (protectMode) return protectMode
  if (protectParticles) return 'wide'
  return false
}

function buildTieredRepair(
  original,
  rate,
  {
    names = false,
    measures = false,
    critical = false,
    extended = false,
    protectMode = false,
    protectParticles = false,
    dual = false,
  } = {}
) {
  const mode = resolveProtectMode({ protectMode, protectParticles })
  let t = swapDocumentSelective(original, rate, { protectMode: mode, dual })
  t = t
    .split('\n')
    .map((line, i) => {
      const orig = original.split('\n')[i] ?? ''
      if (!orig.trim() || isDialogueLine(orig)) return line
      return applyLineRepair(line, orig, { names, measures })
    })
    .join('\n')
  if (critical) t = applyCriticalRepair(t)
  if (extended) t = applyGlobalFixesPartial(t, 80)
  return t
}

/**
 * 混合行：部分叙述行全 swap（贡献人工分），其余窄保护 swap + tier2（保可读性）
 */
function buildMixedRepair(
  original,
  { fullRate = 0.52, fullLineRatio = 0.35, narrowRate = 0.52, names = true, measures = true, critical = true } = {}
) {
  const seed = hashSeed(original)
  const origLines = original.split('\n')
  const swappedLines = origLines.map((orig, i) => {
    if (!orig.trim() || isDialogueLine(orig)) return orig
    const pick = createRng((seed + i * 7919) >>> 0)
    const useFull = pick() < fullLineRatio
    const line = swapLine(original, orig, i, useFull ? fullRate : narrowRate, {
      protectMode: useFull ? false : 'narrow',
      seed,
    })
    if (useFull) return applyLineRepair(line, orig, { names, measures: false })
    return applyLineRepair(line, orig, { names, measures })
  })
  let t = swappedLines.join('\n')
  if (critical) t = applyCriticalRepair(t)
  return t
}

function repairText(original, damaged, level = 2) {
  const origLines = original.split('\n')
  const dmgLines = damaged.split('\n')
  const out = []

  for (let i = 0; i < dmgLines.length; i++) {
    const orig = origLines[i] ?? ''
    const dmg = dmgLines[i]
    if (!orig.trim() || isDialogueLine(orig)) {
      out.push(dmg)
      continue
    }

    let t = dmg
    if (level >= 1) {
      // 人名 + 量词（仅当原文含有时）
      if (orig.includes('林晚')) {
        t = t.replace(/晚林/g, '林晚')
        t = t.replace(/林让晚/g, '林晚让')
        t = t.replace(/晚这林/g, '林晚这')
        t = t.replace(/林的晚/g, '林晚')
      }
      if (orig.includes('苏糖')) {
        t = t.replace(/糖苏/g, '苏糖')
      }
      if (orig.includes('三只')) {
        t = t.replace(/只三/g, '三只')
        t = t.replace(/只猫三/g, '三只猫')
        t = t.replace(/([^只])三猫/g, '$1三只猫')
      }
      if (orig.includes('两步')) {
        t = t.replace(/了两步退/g, '退了两步')
      }
    }

    if (level >= 2) {
      for (const [broken, fixed] of GLOBAL_FIXES) {
        if (t.includes(broken)) {
          t = t.split(broken).join(fixed)
        }
      }
    }

    out.push(t)
  }

  return out.join('\n')
}

function writeExperiment(name, content) {
  const outPath = path.join(experimentsDir, `${name}.txt`)
  fs.writeFileSync(outPath, content.endsWith('\n') ? content : content + '\n', 'utf8')
  console.log(`  ✓ ${name} → ${outPath}`)
}

function main() {
  const original = fs.readFileSync(SR30, 'utf8').trimEnd()
  const v5 = fs.existsSync(V5)
    ? fs.readFileSync(V5, 'utf8').trimEnd()
    : swapDocumentSelective(original, 0.45)

  console.log('=== RE 系列：V5 swap + 程序化修复 ===\n')

  // RE0: 极简 — 仅修复人名颠倒（4 条规则）
  let re0 = v5
  re0 = re0.split('\n').map((line, i) => {
    const orig = original.split('\n')[i] ?? ''
    if (!orig.trim() || isDialogueLine(orig)) return line
    let t = line
    if (orig.includes('林晚')) {
      t = t.replace(/晚林/g, '林晚').replace(/林让晚/g, '林晚让').replace(/晚这林/g, '林晚这')
    }
    if (orig.includes('苏糖')) t = t.replace(/糖苏/g, '苏糖')
    return t
  }).join('\n')
  writeExperiment('RE0-V5-repair-minimal', re0)

  // RE5-RE8: swap 梯度 + 极简人名修复
  for (const [label, rate] of [['RE5', 0.48], ['RE6', 0.50], ['RE7', 0.52], ['RE8', 0.55]]) {
    writeExperiment(
      `${label}-swap${Math.round(rate * 100)}-repair-minimal`,
      buildTieredRepair(original, rate, { names: true })
    )
  }

  // RE9-RE12: 分层修复 — 在更高 swap 上逐步增加修复以换可读性
  writeExperiment(
    'RE9-swap52-repair-tier1',
    buildTieredRepair(original, 0.52, { names: true, measures: true })
  )
  writeExperiment(
    'RE10-swap52-repair-tier2',
    buildTieredRepair(original, 0.52, { names: true, measures: true, critical: true })
  )
  writeExperiment(
    'RE11-swap54-repair-tier2',
    buildTieredRepair(original, 0.54, { names: true, measures: true, critical: true })
  )
  writeExperiment(
    'RE12-swap50-repair-tier2',
    buildTieredRepair(original, 0.50, { names: true, measures: true, critical: true })
  )

  // RE13-RE16: 保护虚词 swap — 只打乱实词相邻对，语法破坏大幅减少
  writeExperiment(
    'RE13-swap52-protected-names',
    buildTieredRepair(original, 0.52, { names: true, protectParticles: true })
  )
  writeExperiment(
    'RE14-swap52-protected-tier2',
    buildTieredRepair(original, 0.52, {
      names: true,
      measures: true,
      critical: true,
      protectParticles: true,
    })
  )
  writeExperiment(
    'RE15-swap55-protected-names',
    buildTieredRepair(original, 0.55, { names: true, protectParticles: true })
  )
  writeExperiment(
    'RE16-swap58-protected-names',
    buildTieredRepair(original, 0.58, { names: true, protectParticles: true })
  )

  // RE17-RE18: 扩展规则修复 + 更高 swap 补偿
  writeExperiment(
    'RE17-swap54-repair-extended',
    buildTieredRepair(original, 0.54, { names: true, measures: true, extended: true })
  )
  writeExperiment(
    'RE18-swap56-repair-extended',
    buildTieredRepair(original, 0.56, { names: true, measures: true, extended: true })
  )

  // RE19–RE24：RE14 失败后的补偿（宽保护有效 swap 仅 ~4%，需窄保护或混合行）
  writeExperiment(
    'RE19-swap52-narrow-names',
    buildTieredRepair(original, 0.52, { names: true, protectMode: 'narrow' })
  )
  writeExperiment(
    'RE20-swap52-narrow-tier2',
    buildTieredRepair(original, 0.52, {
      names: true,
      measures: true,
      critical: true,
      protectMode: 'narrow',
    })
  )
  writeExperiment(
    'RE21-swap58-narrow-tier2',
    buildTieredRepair(original, 0.58, {
      names: true,
      measures: true,
      critical: true,
      protectMode: 'narrow',
    })
  )
  writeExperiment(
    'RE22-mix35full65narrow',
    buildMixedRepair(original, { fullLineRatio: 0.35, fullRate: 0.52, narrowRate: 0.52 })
  )
  writeExperiment(
    'RE23-mix45full55narrow',
    buildMixedRepair(original, { fullLineRatio: 0.45, fullRate: 0.52, narrowRate: 0.52 })
  )
  writeExperiment(
    'RE24-mix30full70narrow',
    buildMixedRepair(original, { fullLineRatio: 0.3, fullRate: 0.52, narrowRate: 0.52 })
  )

  // RE25–RE28：虚词靶向 swap — RE19–22 证明「保留虚词位置 = 100%疑似AI」
  writeExperiment(
    'RE25-particle88-names',
    buildTieredRepair(original, 0.88, { names: true, protectMode: 'particle' })
  )
  writeExperiment(
    'RE26-particle95-names',
    buildTieredRepair(original, 0.95, { names: true, protectMode: 'particle' })
  )
  writeExperiment(
    'RE27-dual-particle88-full26',
    buildTieredRepair(original, 0.88, { names: true, dual: true })
  )
  writeExperiment(
    'RE28-dual-particle95-full30',
    buildTieredRepair(original, 0.95, { names: true, dual: true })
  )

  // RE1: V5 + 仅人名/量词修复
  writeExperiment('RE1-V5-repair-names', repairText(original, v5, 1))

  // RE2: V5 + 完整规则修复
  writeExperiment('RE2-V5-repair-full', repairText(original, v5, 2))

  // RE3/RE4: 更高 swap 率 + 完整修复（补偿修复带来的扰动损失）
  for (const [label, rate] of [['RE3', 0.47], ['RE4', 0.48]]) {
    const swapped = swapDocumentSelective(original, rate)
    writeExperiment(`${label}-swap${Math.round(rate * 100)}-repair-full`, repairText(original, swapped, 2))
  }

  // 若 V5 不存在则写入
  if (!fs.existsSync(V5)) {
    writeExperiment('V5-SR30-narr-swap45', v5)
  }

  console.log('\n完成！RE19–22=100%疑似AI → 请测 RE25/RE26（虚词靶向）→ RE27（双 pass）。RE7 仍是全 swap 基准。')
}

main()
