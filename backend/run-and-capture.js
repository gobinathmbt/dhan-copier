// Run backtest as child process, capture output to file
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const outFile = path.resolve(__dirname, '_test_output.txt');

console.log('Running backtest with args:', args.join(' '));
const stream = fs.createWriteStream(outFile, { flags: 'w' });
const proc = spawn('node', ['scripts/backtest-hybrid.js', ...args], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', d => stream.write(d));
proc.stderr.on('data', d => stream.write(d));
proc.on('close', code => {
  stream.end();
  console.log('Exit code:', code, '-- output saved to', outFile);
});
