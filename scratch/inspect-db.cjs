const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join('/Users/like/Library/Application Support/anovel/anovel.db');
console.log('Database path:', dbPath);
if (!fs.existsSync(dbPath)) {
  console.log('Database file does not exist at path!');
  process.exit(1);
}

const db = new Database(dbPath);

console.log('=== Works ===');
const works = db.prepare('SELECT id, title FROM works').all();
console.log(works);

console.log('\n=== Settings (Diagnoses) ===');
const settings = db.prepare('SELECT * FROM settings WHERE type LIKE "diagnosis_%"').all();
settings.forEach(s => {
  console.log(`Work ID: ${s.work_id}, Type: ${s.type}`);
  try {
    const parsed = JSON.parse(s.content);
    console.log('Report outline (first 100 chars):', parsed.report ? parsed.report.slice(0, 100) : 'none');
    console.log('Revised Chapters count:', parsed.revised_chapters ? parsed.revised_chapters.length : 0);
    if (parsed.revised_chapters) {
      parsed.revised_chapters.forEach(rc => {
        console.log(`- Chapter ID: ${rc.chapter_id}, fields: ${Object.keys(rc).join(', ')}`);
        if (rc.chapter_id == 4 || rc.chapter_id === '4') {
          console.log('Chapter 4 details in diagnosis:', JSON.stringify(rc, null, 2));
        }
      });
    }
  } catch (e) {
    console.log('Failed to parse json content:', e.message);
    console.log('Raw content snippet:', s.content ? s.content.slice(0, 200) : 'null');
  }
});

console.log('\n=== Chapter 4 ===');
const chapter4 = db.prepare('SELECT id, volume_id, title, outline, status, update_time FROM chapters WHERE id = 4 OR title LIKE "%第4章%"').all();
console.log(chapter4);

console.log('\n=== Chapter Versions for Chapter 4 ===');
const versions = db.prepare('SELECT id, chapter_id, version_number, create_time FROM chapter_versions WHERE chapter_id = 4').all();
console.log(versions);

db.close();
