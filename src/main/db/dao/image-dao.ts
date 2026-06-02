import { BaseDAO } from './base-dao'

export interface GeneratedImageRow {
  id: number
  work_id: number | null
  chapter_id: number | null
  prompt: string
  local_path: string
  image_type: string | null
  create_time: string
}

export interface VolcengineConfigRow {
  id: number
  access_key: string
  secret_key: string
  region: string
  is_enabled: number
}

export class ImageDAO extends BaseDAO {
  listByWork(workId: number): GeneratedImageRow[] {
    return this.all<GeneratedImageRow>(
      'SELECT * FROM generated_images WHERE work_id = ? ORDER BY create_time DESC',
      [workId]
    )
  }

  create(input: {
    work_id?: number
    chapter_id?: number
    prompt: string
    local_path: string
    image_type?: string
  }): number {
    return this.insert(
      'INSERT INTO generated_images (work_id, chapter_id, prompt, local_path, image_type) VALUES (?, ?, ?, ?, ?)',
      [input.work_id ?? null, input.chapter_id ?? null, input.prompt, input.local_path, input.image_type ?? null]
    )
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM generated_images WHERE id = ?', [id]).changes > 0
  }

  getVolcengineConfig(): VolcengineConfigRow | undefined {
    return this.get<VolcengineConfigRow>('SELECT * FROM volcengine_configs ORDER BY id DESC LIMIT 1')
  }

  upsertVolcengineConfig(accessKey: string, secretKey: string, region?: string, enabled?: boolean): void {
    const existing = this.getVolcengineConfig()
    if (existing) {
      this.run(
        'UPDATE volcengine_configs SET access_key = ?, secret_key = ?, region = ?, is_enabled = ? WHERE id = ?',
        [accessKey, secretKey, region ?? existing.region, enabled !== false ? 1 : 0, existing.id]
      )
    } else {
      this.insert(
        'INSERT INTO volcengine_configs (access_key, secret_key, region, is_enabled) VALUES (?, ?, ?, ?)',
        [accessKey, secretKey, region ?? 'cn-beijing', enabled !== false ? 1 : 0]
      )
    }
  }
}

export const imageDAO = new ImageDAO()
