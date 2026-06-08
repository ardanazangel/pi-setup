#!/usr/bin/env node

/**
 * Pi Agent Eval Runner
 * Evalúa si el agente sigue los comportamientos definidos en SYSTEM.md
 *
 * Usa el CLI de pi para las llamadas LLM — funciona con cualquier provider
 * configurado en agent/settings.json (Anthropic, OpenAI, Gemini, etc.)
 *
 * Uso:
 *   node ~/.pi/evals/run.js              # todos los casos
 *   node ~/.pi/evals/run.js 01-no-slop   # caso específico
 *   node ~/.pi/evals/run.js --compare    # compara últimos dos runs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, 'cases');
const RESULTS_DIR = path.join(__dirname, 'results');
const SYSTEM_MD = path.join(__dirname, '../agent/SYSTEM.md');

// ─── LLM call via pi CLI ──────────────────────────────────────────────────────
// Delega al CLI de pi, que usa el provider/model de settings.json.
// Funciona con cualquier provider sin cambiar este archivo.

async function callLLM(systemPrompt, userPrompt) {
  const tmpSystem = path.join(RESULTS_DIR, `_tmp_system_${Date.now()}.md`);
  fs.writeFileSync(tmpSystem, systemPrompt);
  try {
    const output = execSync(
      `pi --print --no-session --system-prompt ${JSON.stringify(tmpSystem)} ${JSON.stringify(userPrompt)}`,
      { encoding: 'utf8', timeout: 60000 }
    );
    return output.trim();
  } finally {
    try { fs.unlinkSync(tmpSystem); } catch {}
  }
}

// ─── Checkers ─────────────────────────────────────────────────────────────────

function checkDeterministic(response, check) {
  if (check.pattern) {
    const flags = check.flags || 'i';
    const re = new RegExp(check.pattern, flags);
    const matches = re.test(response);
    const passed = check.expect ? matches : !matches;
    return {
      name: check.name,
      description: check.description,
      passed,
      detail: matches ? `Patrón encontrado: /${check.pattern}/` : `Patrón no encontrado: /${check.pattern}/`,
    };
  }
  if (check.maxLength !== undefined) {
    const passed = response.length <= check.maxLength;
    return {
      name: check.name,
      description: check.description,
      passed,
      detail: `Longitud: ${response.length} chars (máx ${check.maxLength})`,
    };
  }
  return { name: check.name, passed: false, detail: 'Check mal configurado' };
}

async function checkLLMJudge(response, check) {
  const judgePrompt = `${check.prompt}\n\n---\nRESPUESTA DEL AGENTE:\n${response}`;
  const judgment = await callLLM(
    'Eres un evaluador estricto. Responde únicamente con PASS o FAIL seguido de una línea de explicación. Nada más.',
    judgePrompt
  );
  const passed = judgment.trim().startsWith('PASS');
  return {
    name: check.name,
    description: check.prompt.slice(0, 80) + '...',
    passed,
    detail: judgment.trim(),
  };
}

// ─── Run a single case ────────────────────────────────────────────────────────

async function runCase(caseFile, systemPrompt) {
  const casePath = path.join(CASES_DIR, caseFile.endsWith('.json') ? caseFile : `${caseFile}.json`);
  const testCase = JSON.parse(fs.readFileSync(casePath, 'utf8'));

  console.log(`\n━━━ ${testCase.id} ━━━`);
  console.log(`${testCase.description}`);

  const results = [];

  for (const [promptIdx, prompt] of testCase.prompts.entries()) {
    console.log(`\n  Prompt ${promptIdx + 1}: "${prompt.slice(0, 60)}..."`);

    let response;
    try {
      response = await callLLM(systemPrompt, prompt);
      console.log(`  → Respuesta: ${response.slice(0, 100).replace(/\n/g, ' ')}...`);
    } catch (e) {
      console.error(`  ✗ Error en API: ${e.message}`);
      results.push({ promptIdx, prompt, error: e.message, checks: [] });
      continue;
    }

    const checkResults = [];
    for (const check of testCase.checks) {
      if (check.promptIndex !== undefined && check.promptIndex !== promptIdx) continue;

      let result;
      if (check.type === 'deterministic') {
        result = checkDeterministic(response, check);
      } else if (check.type === 'llm-judge') {
        result = await checkLLMJudge(response, check);
      } else {
        result = { name: check.name, passed: false, detail: `Tipo de check desconocido: ${check.type}` };
      }

      const icon = result.passed ? '✓' : '✗';
      const color = result.passed ? '\x1b[32m' : '\x1b[31m';
      console.log(`  ${color}${icon}\x1b[0m ${result.name}: ${result.detail}`);
      checkResults.push(result);
    }

    results.push({ promptIdx, prompt, response, checks: checkResults });
  }

  const total = results.flatMap(r => r.checks).length;
  const passed = results.flatMap(r => r.checks).filter(c => c.passed).length;
  const score = total > 0 ? Math.round((passed / total) * 100) : 0;

  console.log(`\n  Score: ${passed}/${total} (${score}%)`);

  return {
    id: testCase.id,
    description: testCase.description,
    results,
    score,
    passed,
    total,
    timestamp: new Date().toISOString(),
  };
}

// ─── Compare ──────────────────────────────────────────────────────────────────

function compareRuns() {
  const files = fs.readdirSync(RESULTS_DIR)
    .filter(f => f.startsWith('run-') && f.endsWith('.json'))
    .sort()
    .slice(-2);

  if (files.length < 2) {
    console.log('Necesitas al menos 2 runs para comparar.');
    return;
  }

  const [prev, curr] = files.map(f => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8')));

  console.log(`\nComparando:\n  Base:    ${prev.timestamp}\n  Actual:  ${curr.timestamp}\n`);
  console.log('─'.repeat(60));

  let improvements = 0, regressions = 0, unchanged = 0;

  for (const currCase of curr.cases) {
    const prevCase = prev.cases.find(c => c.id === currCase.id);
    if (!prevCase) continue;

    const delta = currCase.score - prevCase.score;
    const icon = delta > 0 ? '↑' : delta < 0 ? '↓' : '=';
    const color = delta > 0 ? '\x1b[32m' : delta < 0 ? '\x1b[31m' : '\x1b[90m';
    console.log(`${color}${icon}\x1b[0m ${currCase.id}: ${prevCase.score}% → ${currCase.score}% (${delta > 0 ? '+' : ''}${delta}%)`);

    if (delta > 0) improvements++;
    else if (delta < 0) regressions++;
    else unchanged++;
  }

  const prevTotal = prev.cases.reduce((s, c) => s + c.score, 0) / prev.cases.length;
  const currTotal = curr.cases.reduce((s, c) => s + c.score, 0) / curr.cases.length;
  const totalDelta = Math.round(currTotal - prevTotal);

  console.log('─'.repeat(60));
  console.log(`\nScore global: ${Math.round(prevTotal)}% → ${Math.round(currTotal)}% (${totalDelta > 0 ? '+' : ''}${totalDelta}%)`);
  console.log(`Mejoras: ${improvements} | Regresiones: ${regressions} | Sin cambio: ${unchanged}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--compare')) {
    compareRuns();
    return;
  }

  const systemPrompt = fs.readFileSync(SYSTEM_MD, 'utf8');
  console.log(`\x1b[1mPi Agent Evals\x1b[0m`);
  console.log(`System prompt: ${SYSTEM_MD} (${systemPrompt.length} chars)\n`);

  let caseFiles = fs.readdirSync(CASES_DIR).filter(f => f.endsWith('.json')).sort();
  if (args.length > 0 && !args[0].startsWith('--')) {
    caseFiles = caseFiles.filter(f => f.includes(args[0]));
    if (caseFiles.length === 0) {
      console.error(`No se encontró caso: ${args[0]}`);
      process.exit(1);
    }
  }

  console.log(`Corriendo ${caseFiles.length} caso(s)...`);

  const runResults = {
    timestamp: new Date().toISOString(),
    systemMdLength: systemPrompt.length,
    cases: [],
  };

  for (const caseFile of caseFiles) {
    const result = await runCase(caseFile, systemPrompt);
    runResults.cases.push(result);
  }

  const totalPassed = runResults.cases.reduce((s, c) => s + c.passed, 0);
  const totalChecks = runResults.cases.reduce((s, c) => s + c.total, 0);
  const globalScore = totalChecks > 0 ? Math.round((totalPassed / totalChecks) * 100) : 0;
  runResults.globalScore = globalScore;

  console.log('\n' + '━'.repeat(50));
  console.log(`\x1b[1mScore global: ${totalPassed}/${totalChecks} (${globalScore}%)\x1b[0m`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultFile = path.join(RESULTS_DIR, `run-${timestamp}.json`);
  fs.writeFileSync(resultFile, JSON.stringify(runResults, null, 2));
  console.log(`\nResultado guardado en: ${resultFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
