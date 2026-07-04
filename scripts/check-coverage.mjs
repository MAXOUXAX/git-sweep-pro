import fs from 'node:fs';
import path from 'node:path';

const coverageDir = process.argv[2] ?? 'coverage';
const threshold = Number(process.argv[3] ?? 85);

const summaryPath = path.resolve(coverageDir, 'coverage-summary.json');

if (!fs.existsSync(summaryPath)) {
	console.error(`Coverage summary not found at: ${summaryPath}`);
	console.error('Run the matching coverage script before checking coverage.');
	process.exit(1);
}

const raw = fs.readFileSync(summaryPath, 'utf8');
const summary = JSON.parse(raw);
const total = summary.total;

if (typeof total?.lines?.pct !== 'number' || !Number.isFinite(total.lines.pct)) {
	console.error('Invalid coverage summary: total.lines.pct is not a number.');
	console.error('This usually means no tests ran and no coverage was collected.');
	process.exit(1);
}

if ((total.lines.total ?? 0) === 0) {
	console.error('Coverage gate failed: no lines were instrumented (0 tests likely ran).');
	process.exit(1);
}

const metrics = {
	lines: total.lines.pct,
	statements: total.statements?.pct ?? 0,
	functions: total.functions?.pct ?? 0,
	branches: total.branches?.pct ?? 0,
};

console.log('Coverage summary:');
console.log(`- Directory: ${coverageDir}`);
console.log(`- Lines: ${metrics.lines}%`);
console.log(`- Statements: ${metrics.statements}%`);
console.log(`- Functions: ${metrics.functions}%`);
console.log(`- Branches: ${metrics.branches}%`);

if (metrics.lines < threshold) {
	console.error(`\nCoverage gate failed: lines ${metrics.lines}% < ${threshold}%`);
	process.exit(1);
}

console.log(`\nCoverage gate passed: lines ${metrics.lines}% >= ${threshold}%`);
