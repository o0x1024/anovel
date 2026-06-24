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
    const level = match[2];
    const category = match[3];
    const msg = match[4];
    const jsonStr = match[5];
    try {
      const parsed = JSON.parse(jsonStr);
      console.log(`Line ${idx + 1}: [${time}] msg="${msg}" step=${parsed.step} reqId=${parsed.requestId}`);
    } catch (e) {
      console.log(`Line ${idx + 1}: Parse failed. Msg: ${msg}`);
    }
  } else {
    console.log(`Line ${idx + 1}: Preview: ${line.slice(0, 100)}`);
  }
});
