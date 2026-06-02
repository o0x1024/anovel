import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { imageDAO } from '../db'

/**
 * 图片生成 MVP：配置未启用时生成占位 SVG；启用后预留 API 扩展点
 */
export async function generateImage(input: {
  workId: number
  chapterId?: number
  prompt: string
  imageType?: string
}): Promise<{ success: boolean; localPath?: string; imageId?: number; error?: string }> {
  const config = imageDAO.getVolcengineConfig()
  const imagesDir = join(app.getPath('userData'), 'generated-images')
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true })

  const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.svg`
  const localPath = join(imagesDir, filename)

  if (config?.is_enabled && config.access_key) {
    // 火山引擎 API 集成点：当前生成带 Prompt 信息的占位图，避免无密钥时失败
    const svg = buildPlaceholderSvg(input.prompt, '火山引擎配置已保存，完整 API 对接待启用')
    writeFileSync(localPath, svg, 'utf-8')
  } else {
    const svg = buildPlaceholderSvg(input.prompt, '请在设置中配置火山引擎密钥以启用真实生图')
    writeFileSync(localPath, svg, 'utf-8')
  }

  const imageId = imageDAO.create({
    work_id: input.workId,
    chapter_id: input.chapterId,
    prompt: input.prompt,
    local_path: localPath,
    image_type: input.imageType ?? 'illustration'
  })

  return { success: true, localPath, imageId }
}

function buildPlaceholderSvg(prompt: string, subtitle: string): string {
  const safePrompt = prompt.slice(0, 120).replace(/[<>&"]/g, '')
  const safeSub = subtitle.replace(/[<>&"]/g, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#1a1a2e"/>
  <rect x="32" y="32" width="448" height="448" rx="8" fill="#16213e" stroke="#0f3460"/>
  <text x="256" y="200" fill="#e94560" font-size="18" font-family="sans-serif" text-anchor="middle">ANovel 插图占位</text>
  <text x="256" y="240" fill="#a0aec0" font-size="12" font-family="sans-serif" text-anchor="middle">${safeSub}</text>
  <foreignObject x="48" y="280" width="416" height="160">
    <div xmlns="http://www.w3.org/1999/xhtml" style="color:#cbd5e0;font-size:11px;font-family:sans-serif;line-height:1.5;overflow:hidden">${safePrompt}</div>
  </foreignObject>
</svg>`
}
