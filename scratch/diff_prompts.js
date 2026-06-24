import fs from 'fs';

const logPath = '/Users/like/code/anovel/logs/anovel-llm-2026-06-16.log';
if (!fs.existsSync(logPath)) {
  console.log('Log file does not exist');
  process.exit(0);
}

const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split('\n').filter(Boolean);

lines.forEach((line, idx) => {
  const match = line.match(/^\[(.*?)\] \[(.*?)\] \[(.*?)\] (.*?) ({.*})$/);
  if (match) {
    const time = match[1];
    const msg = match[4];
    const jsonStr = match[5];
    if (msg === 'LLM 请求已发送') {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.step === 'incubator_score_candidates') {
          // Extract ids from userPrompt
          const ids = [];
          const regex = /"id":\s*(\d+)/g;
          let m;
          while ((m = regex.exec(parsed.userPrompt)) !== null) {
            ids.push(m[1]);
          }
          console.log(`Line ${idx + 1}: (${time}) reqId=${parsed.requestId} scored ids = [${ids.join(', ')}]`);
        }
      } catch (e) {
        console.log(`Line ${idx + 1}: Parse failed`);
      }
    }
  }
});
