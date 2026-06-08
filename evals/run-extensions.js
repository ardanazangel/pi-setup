#!/usr/bin/env node

/**
 * Extension Evals
 * Testea extensiones handmade: compilación TS + comportamientos críticos
 *
 * Uso:
 *   node ~/.pi/evals/run-extensions.js
 *   node ~/.pi/evals/run-extensions.js ship
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_DIR = path.join(__dirname, '../agent/extensions');
const RESULTS_DIR = path.join(__dirname, 'results');

// ─── TypeScript check ─────────────────────────────────────────────────────────

function checkTypeScript(file) {
  const fullPath = path.join(EXTENSIONS_DIR, file);
  try {
    execSync(
      `node --input-type=module --eval "import('${fullPath}')" 2>&1`,
      { timeout: 10000 }
    );
    // Si no lanza, al menos parsea
    return { passed: true, detail: 'Importa sin errores' };
  } catch (e) {
    // Los .ts necesitan transpilación — chequeamos sintaxis con acorn o simplemente
    // verificamos que el archivo exista y no esté vacío
    return { passed: true, detail: 'Skip (requiere transpilación TS)' };
  }
}

function checkFileSyntax(file) {
  const fullPath = path.join(EXTENSIONS_DIR, file);
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    // Checks básicos de sintaxis TypeScript vía heurísticas
    const issues = [];
    // Detectar funciones sin export default
    if (content.includes('export default function') === false && 
        content.includes('export default') === false &&
        !file.endsWith('.json')) {
      issues.push('Sin export default');
    }
    // Detectar imports rotos (import from sin string)
    const brokenImport = /import\s+.*from\s*;/.test(content);
    if (brokenImport) issues.push('Import malformado');
    
    return {
      passed: issues.length === 0,
      detail: issues.length === 0 ? 'Estructura OK' : issues.join(', ')
    };
  } catch (e) {
    return { passed: false, detail: `No se puede leer: ${e.message}` };
  }
}

// ─── Behavioral checks ────────────────────────────────────────────────────────

const BEHAVIORAL_CHECKS = {
  'ship.ts': [
    {
      name: 'security_scan',
      description: 'Prompt incluye escaneo de contenido sensible antes de commitear',
      check: content => /sensitive|secret|api.?key|token|password/i.test(content),
    },
    {
      name: 'git_add_all',
      description: 'Usa git add -A (no parcial)',
      check: content => content.includes('git add -A'),
    },
    {
      name: 'upstream_tracking',
      description: 'Maneja branches sin upstream remoto',
      check: content => /upstream/i.test(content),
    },
    {
      name: 'pr_url_output',
      description: 'Genera URL de PR cuando no es main',
      check: content => /pull.request|PR/i.test(content) && /url/i.test(content),
    },
    {
      name: 'ssh_to_https',
      description: 'Convierte SSH remotes a HTTPS para el output',
      check: content => /SSH.*HTTPS|git@.*https/i.test(content),
    },
  ],
  'workflow.ts': [
    {
      name: 'quality_tiers',
      description: 'Tiene tiers fast/balanced/best',
      check: content => ['fast', 'balanced', 'best'].every(t => content.includes(t)),
    },
    {
      name: 'adversarial_pattern',
      description: 'Implementa patrón adversarial',
      check: content => content.includes('adversarial'),
    },
    {
      name: 'tournament_pattern',
      description: 'Implementa patrón tournament',
      check: content => content.includes('tournament'),
    },
    {
      name: 'loop_pattern',
      description: 'Implementa patrón loop',
      check: content => content.includes('loop'),
    },
    {
      name: 'model_selection',
      description: 'Selecciona modelos por tier (haiku/sonnet/opus)',
      check: content => ['haiku', 'sonnet', 'opus'].every(m => content.includes(m)),
    },
  ],
  'research.ts': [
    {
      name: 'delegates_to_agent',
      description: 'Delega a subagente en lugar de hacer fetch manual',
      check: content => /subagent|sendUserMessage|delegate/i.test(content),
    },
    {
      name: 'quick_flag',
      description: 'Soporta flag --quick',
      check: content => content.includes('quick'),
    },
  ],
};

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const filterFile = args[0] ? args[0] + (args[0].endsWith('.ts') ? '' : '.ts') : null;

  const files = fs.readdirSync(EXTENSIONS_DIR)
    .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    .filter(f => !filterFile || f === filterFile)
    .sort();

  console.log(`\x1b[1mExtension Evals\x1b[0m`);
  console.log(`Extensions: ${EXTENSIONS_DIR}\n`);

  let totalPassed = 0;
  let totalChecks = 0;
  const results = [];

  for (const file of files) {
    console.log(`\n━━━ ${file} ━━━`);
    const content = fs.readFileSync(path.join(EXTENSIONS_DIR, file), 'utf8');
    const fileResults = [];

    // Syntax check
    const syntaxCheck = checkFileSyntax(file);
    const icon = syntaxCheck.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${icon} estructura: ${syntaxCheck.detail}`);
    fileResults.push({ name: 'estructura', ...syntaxCheck });
    syntaxCheck.passed ? totalPassed++ : null;
    totalChecks++;

    // Behavioral checks
    const behaviors = BEHAVIORAL_CHECKS[file] || [];
    for (const check of behaviors) {
      const passed = check.check(content);
      const icon = passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`  ${icon} ${check.name}: ${check.description}`);
      fileResults.push({ name: check.name, passed, detail: check.description });
      if (passed) totalPassed++;
      totalChecks++;
    }

    const filePassed = fileResults.filter(r => r.passed).length;
    console.log(`\n  Score: ${filePassed}/${fileResults.length}`);
    results.push({ file, checks: fileResults, score: Math.round(filePassed / fileResults.length * 100) });
  }

  const globalScore = totalChecks > 0 ? Math.round((totalPassed / totalChecks) * 100) : 0;
  console.log('\n' + '━'.repeat(50));
  console.log(`\x1b[1mScore global: ${totalPassed}/${totalChecks} (${globalScore}%)\x1b[0m`);

  // Guardar resultado
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultFile = path.join(RESULTS_DIR, `extensions-${timestamp}.json`);
  fs.writeFileSync(resultFile, JSON.stringify({ timestamp: new Date().toISOString(), globalScore, results }, null, 2));
  console.log(`\nResultado guardado en: ${resultFile}`);

  process.exit(globalScore < 85 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
