<script setup lang="ts">
import { ref } from 'vue'

const activeTab = ref<'facade' | 'pitfalls' | 'trends'>('facade')
</script>

<template>
  <div class="card bg-base-200 border border-base-300 shadow-sm p-4 h-full flex flex-col min-h-0 select-none">
    <div class="flex items-center gap-2 mb-4 shrink-0">
      <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
        <font-awesome-icon icon="compass" class="text-base animate-pulse" />
      </div>
      <div>
        <h4 class="font-bold text-sm text-base-content">短故事创作风向标</h4>
        <p class="text-[11px] text-base-content/40">基于番茄短故事官方课堂沉淀的创作通关秘籍</p>
      </div>
    </div>

    <!-- 选项卡导航 -->
    <div class="tabs tabs-boxed mb-3 bg-base-300/40 p-1 shrink-0">
      <button
        type="button"
        :class="['tab tab-xs flex-1 font-semibold transition-all duration-200', activeTab === 'facade' ? 'tab-active bg-primary text-primary-content' : '']"
        @click="activeTab = 'facade'"
      >
        门面吸睛大法
      </button>
      <button
        type="button"
        :class="['tab tab-xs flex-1 font-semibold transition-all duration-200', activeTab === 'pitfalls' ? 'tab-active bg-primary text-primary-content' : '']"
        @click="activeTab = 'pitfalls'"
      >
        世情避坑指南
      </button>
      <button
        type="button"
        :class="['tab tab-xs flex-1 font-semibold transition-all duration-200', activeTab === 'trends' ? 'tab-active bg-primary text-primary-content' : '']"
        @click="activeTab = 'trends'"
      >
        脑洞/题材风向
      </button>
    </div>

    <!-- 滚动内容区 -->
    <div class="flex-1 overflow-y-auto min-h-0 space-y-3 pr-1 scrollbar-thin">
      <!-- 选项卡 1：门面吸睛大法 -->
      <div v-if="activeTab === 'facade'" class="space-y-4 text-xs">
        <div class="alert alert-info py-2 px-3 text-[11px] bg-info/5 border-info/20 text-info">
          <span>💡 <strong>官方提醒：</strong>好书名与导语负责前 10 秒的读者留存，切忌平淡和卖关子！</span>
        </div>

        <div>
          <h5 class="font-bold text-base-content/80 mb-2 flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-primary"></span>
            书名五大套路模板
          </h5>
          <div class="space-y-2.5">
            <!-- 模板 1 -->
            <div class="border border-base-300/60 rounded-lg p-2 bg-base-100/50">
              <div class="flex justify-between items-center mb-1">
                <span class="font-bold text-primary text-[10px] uppercase tracking-wider">1. 直白爽点型</span>
                <span class="text-[10px] text-base-content/40">打脸/逆袭/爽文首选</span>
              </div>
              <p class="text-base-content/60 leading-relaxed">核心是直接抛出人物矛盾与核心冲突，直击代入感。</p>
              <div class="mt-1.5 space-y-1 text-[11px]">
                <div class="text-success"><span class="font-semibold">✓ 优秀：</span>《未婚夫亲妈消费38万逼我结账？我当场报警》</div>
                <div class="text-base-content/40"><span class="font-semibold">✗ 踩坑：</span>《高额账单》（无冲突，过于平淡）</div>
              </div>
            </div>

            <!-- 模板 2 -->
            <div class="border border-base-300/60 rounded-lg p-2 bg-base-100/50">
              <div class="flex justify-between items-center mb-1">
                <span class="font-bold text-primary text-[10px] uppercase tracking-wider">2. 反差对立型</span>
                <span class="text-[10px] text-base-content/40">言情/重生/甜宠/虐文</span>
              </div>
              <p class="text-base-content/60 leading-relaxed">打造身份、性格、处境的极致反差，制造记忆爽点。</p>
              <div class="mt-1.5 space-y-1 text-[11px]">
                <div class="text-success"><span class="font-semibold">✓ 优秀：</span>《被送去和亲后，我选择摆烂，暴君傻眼了》</div>
                <div class="text-base-content/40"><span class="font-semibold">✗ 踩坑：</span>《和亲王妃的生活》（模糊描述，无反差感）</div>
              </div>
            </div>

            <!-- 模板 3 -->
            <div class="border border-base-300/60 rounded-lg p-2 bg-base-100/50">
              <div class="flex justify-between items-center mb-1">
                <span class="font-bold text-primary text-[10px] uppercase tracking-wider">3. 悬念留白型</span>
                <span class="text-[10px] text-base-content/40">悬疑/脑洞/强反转</span>
              </div>
              <p class="text-base-content/60 leading-relaxed">用疑问句、留白制造探索悬念，抛问题不给答案。</p>
              <div class="mt-1.5 space-y-1 text-[11px]">
                <div class="text-success"><span class="font-semibold">✓ 优秀：</span>《高考前夜，班主任让我千万别在答题卡上写名字》</div>
                <div class="text-base-content/40"><span class="font-semibold">✗ 踩坑：</span>《一桩离奇的怪事》（表述空洞，悬念感薄弱）</div>
              </div>
            </div>

            <!-- 模板 4 -->
            <div class="border border-base-300/60 rounded-lg p-2 bg-base-100/50">
              <div class="flex justify-between items-center mb-1">
                <span class="font-bold text-primary text-[10px] uppercase tracking-wider">4. 场景直击型</span>
                <span class="text-[10px] text-base-content/40">全题材通用</span>
              </div>
              <p class="text-base-content/60 leading-relaxed">截取故事的名场面动作，用鲜明画面让读者身临其境。</p>
              <div class="mt-1.5 space-y-1 text-[11px]">
                <div class="text-success"><span class="font-semibold">✓ 优秀：</span>《偷刷我会员卡请客？我反手销卡，你自己买单吧》</div>
                <div class="text-base-content/40"><span class="font-semibold">✗ 踩坑：</span>《一场难忘的经历》（无细节无画面）</div>
              </div>
            </div>

            <!-- 模板 5 -->
            <div class="border border-base-300/60 rounded-lg p-2 bg-base-100/50">
              <div class="flex justify-between items-center mb-1">
                <span class="font-bold text-primary text-[10px] uppercase tracking-wider">5. IP 质感型</span>
                <span class="text-[10px] text-base-content/40">古言/宅斗/精品向</span>
              </div>
              <p class="text-base-content/60 leading-relaxed">简约富有诗意与画面感的短句，呈现作品的高级IP潜质。</p>
              <div class="mt-1.5 space-y-1 text-[11px]">
                <div class="text-success"><span class="font-semibold">✓ 优秀：</span>《太子侧妃生存手册》《校花她重走花路》</div>
                <div class="text-base-content/40"><span class="font-semibold">✗ 踩坑：</span>《侧妃》《娇养》（过于抽象，难以获取有效信息）</div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <h5 class="font-bold text-base-content/80 mb-2 flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-primary"></span>
            黄金导语四要素 (The Hook)
          </h5>
          <div class="space-y-2 bg-base-100/30 p-3 border border-base-300 rounded-lg">
            <div class="flex gap-2">
              <span class="font-bold text-primary">01</span>
              <div>
                <p class="font-bold text-base-content/90">开篇即冲突，拒绝铺垫</p>
                <p class="text-base-content/50 mt-0.5">前三行必须进入矛盾与名场面，摒弃冗长环境描写和背景介绍。</p>
              </div>
            </div>
            <div class="flex gap-2 border-t border-base-300/40 pt-2">
              <span class="font-bold text-primary">02</span>
              <div>
                <p class="font-bold text-base-content/90">人设清晰立体，快速代入</p>
                <p class="text-base-content/50 mt-0.5">三言两语交代主角独特标签、艰难处境和性格闪光点，调动同频情绪。</p>
              </div>
            </div>
            <div class="flex gap-2 border-t border-base-300/40 pt-2">
              <span class="font-bold text-primary">03</span>
              <div>
                <p class="font-bold text-base-content/90">埋设强烈的“钩子”</p>
                <p class="text-base-content/50 mt-0.5">抛出巨大悬念、认知错位或者反直觉现象（如“听懂婴儿吐槽扎肉”），引诱读者下翻。</p>
              </div>
            </div>
            <div class="flex gap-2 border-t border-base-300/40 pt-2">
              <span class="font-bold text-primary">04</span>
              <div>
                <p class="font-bold text-base-content/90">紧贴核心主线与亮点</p>
                <p class="text-base-content/50 mt-0.5">导语高潮必须与书名、正文主攻方向高度一致，不铺垫无关支线剧情。</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 选项卡 2：世情避坑指南 -->
      <div v-if="activeTab === 'pitfalls'" class="space-y-3.5 text-xs">
        <div class="collapse collapse-arrow bg-base-100 border border-base-300/60 rounded-lg">
          <input type="checkbox" checked />
          <summary class="collapse-title font-bold text-base-content/90 py-2.5 min-h-0">
            避坑 1：导语切入点须具象，量化矛盾
          </summary>
          <div class="collapse-content text-[11px] text-base-content/60 space-y-1.5 pb-3">
            <p><span class="badge badge-warning badge-xs">问题</span> 泛化概括（如“我从小被偏心”），没有具体细节，代入感极差。</p>
            <p><span class="badge badge-success badge-xs">对策</span> 切入点 = <strong>具体事件 + 利益损失/尊严伤害 + 情绪锚点</strong>。用可量化的矛盾（例如“姐姐彩礼120万，我只有一条被子”）拉动情绪。</p>
          </div>
        </div>

        <div class="collapse collapse-arrow bg-base-100 border border-base-300/60 rounded-lg">
          <input type="checkbox" />
          <summary class="collapse-title font-bold text-base-content/90 py-2.5 min-h-0">
            避坑 2：主线极度聚焦，避免支线杂乱
          </summary>
          <div class="collapse-content text-[11px] text-base-content/60 space-y-1.5 pb-3">
            <p><span class="badge badge-warning badge-xs">问题</span> 支线杂乱，冲突对象频换，导致读者抓不住爽感核心。</p>
            <p><span class="badge badge-success badge-xs">对策</span> 集中火力锚定“核心利益被占——觉醒反击——彻底清算”主线，聚焦1-2个核心冲突对象（自私老公或偏心原生家庭），做足减法。</p>
          </div>
        </div>

        <div class="collapse collapse-arrow bg-base-100 border border-base-300/60 rounded-lg">
          <input type="checkbox" />
          <summary class="collapse-title font-bold text-base-content/90 py-2.5 min-h-0">
            避坑 3：冲突爆发要有伏笔，避免突然翻脸
          </summary>
          <div class="collapse-content text-[11px] text-base-content/60 space-y-1.5 pb-3">
            <p><span class="badge badge-warning badge-xs">问题</span> 毫无情绪铺垫直接决裂，或者因为一件鸡毛蒜皮的小事瞬间走极端，使读者觉得逻辑断裂。</p>
            <p><span class="badge badge-success badge-xs">对策</span> 遵循“细节隐隐委屈 -> 事件摩擦升级 -> 触及核心底线爆开”的合理弧度，确保爆发是压垮骆驼的最后一根稻草。</p>
          </div>
        </div>

        <div class="collapse collapse-arrow bg-base-100 border border-base-300/60 rounded-lg">
          <input type="checkbox" />
          <summary class="collapse-title font-bold text-base-content/90 py-2.5 min-h-0">
            避坑 4：冲突阶梯式升级，拒绝单纯吵架
          </summary>
          <div class="collapse-content text-[11px] text-base-content/60 space-y-1.5 pb-3">
            <p><span class="badge badge-warning badge-xs">问题</span> 从头到尾都是主角跟极品亲属的口水仗，无实质利益交锋，剧情踏步。</p>
            <p><span class="badge badge-success badge-xs">对策</span> 从表面的情绪吵闹，升级到<strong>核心财产/人身权利的抢夺</strong>（法律维权、经济脱钩、收集出轨证据），用动作、反制行为代替苍白的口头吵架。</p>
          </div>
        </div>

        <div class="collapse collapse-arrow bg-base-100 border border-base-300/60 rounded-lg">
          <input type="checkbox" />
          <summary class="collapse-title font-bold text-base-content/90 py-2.5 min-h-0">
            避坑 5：反击要讲逻辑，避免无端降智
          </summary>
          <div class="collapse-content text-[11px] text-base-content/60 space-y-1.5 pb-3">
            <p><span class="badge badge-warning badge-xs">问题</span> 主角无逻辑开挂，反派如同弱智，爽感脱离现实，失去真实的人情温度。</p>
            <p><span class="badge badge-success badge-xs">对策</span> 主角反击要有底气（资源/实力/证据/金手指限制），反派作恶也要有合理动机（自私图财/性格缺陷而非单纯神经质），爽感最终指向自我成长与脱离毒害环境。</p>
          </div>
        </div>
      </div>

      <!-- 选项卡 3：脑洞/题材风向 -->
      <div v-if="activeTab === 'trends'" class="space-y-4 text-xs">
        <!-- 风向 1 -->
        <div class="border border-base-300 rounded-lg p-3 bg-base-100/40">
          <div class="flex items-center gap-1.5 mb-1.5">
            <span class="badge badge-primary badge-sm">古言/脑洞</span>
            <span class="font-bold text-base-content/90">信息差破局 (弹幕/系统/读心术)</span>
          </div>
          <p class="text-base-content/60 leading-relaxed mb-2">
            传统宅斗、退婚或和亲题材的微创新。核心爽点在于**上帝视角**降维打击！
          </p>
          <div class="bg-base-200/50 p-2 rounded text-[11px] text-base-content/60">
            <span class="font-semibold text-primary">脑洞示例：</span>
            陆砚臣第三次拿离婚协议砸我，态度冰冷。我正要提笔，忽然看到一行行红色弹幕。原来，发送者是十年后 35 岁的他，他正在为我得绝症去世的消息而疯狂刷屏哭求：【阿宁，求求你别签！】
          </div>
        </div>

        <!-- 风向 2 -->
        <div class="border border-base-300 rounded-lg p-3 bg-base-100/40">
          <div class="flex items-center gap-1.5 mb-1.5">
            <span class="badge badge-primary badge-sm">年代文/爽文</span>
            <span class="font-bold text-base-content/90">年代逆袭与女性觉醒</span>
          </div>
          <p class="text-base-content/60 leading-relaxed mb-2">
            将主角置于落后的年代家庭中，因重男轻女、名额被顶替或替嫁产生危机，主角极速脱离、大干事业逆袭。
          </p>
          <div class="bg-base-200/50 p-2 rounded text-[11px] text-base-content/60">
            <span class="font-semibold text-primary">核心元素：</span>
            高考录取通知书、供销社岗位、手艺（屠宰、修机器）、反道德绑架的清醒女主、断绝血缘关系。
          </div>
        </div>

        <!-- 风向 3 -->
        <div class="border border-base-300 rounded-lg p-3 bg-base-100/40">
          <div class="flex items-center gap-1.5 mb-1.5">
            <span class="badge badge-primary badge-sm">悬疑/世情</span>
            <span class="font-bold text-base-content/90">生活日常起步与极限拉扯</span>
          </div>
          <p class="text-base-content/60 leading-relaxed mb-2">
            从生活中极其日常、细微的信息（电费暴涨、奇怪账单、摄像头画面）嗅出端倪，层层推进剥开阴谋，在接近真相时受挫，最后绝地回击。
          </p>
          <div class="bg-base-200/50 p-2 rounded text-[11px] text-base-content/60">
            <span class="font-semibold text-primary">名家分享（江行舟）：</span>
            三层钩子设计——第一层：情夫是谁？第二层：他们是如何在我眼皮子底下偷情的？第三层情绪钩子：我什么时候才能撕破伪装摊牌清算？
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
