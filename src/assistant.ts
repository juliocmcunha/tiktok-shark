/**
 * assistant.ts
 * -----------------------------------------------------------------------------
 * Assistente de configuração + infraestrutura do console interativo.
 *
 * - Detecta o ambiente (config.decideUiMode) e escolhe:
 *     gui      -> abre uma PÁGINA WEB local no navegador (assistente visual)
 *     console  -> pergunta pelo terminal
 *     headless -> instrui a editar o .env
 * - Também expõe o console de comandos (ask/startConsole) usado pelo server.
 *
 * A página de configuração só aceita conexões locais (loopback), então mesmo
 * com o servidor exposto por ngrok ninguém de fora altera a configuração.
 */

import type { Express, Request, Response } from 'express';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  ENV_PATH,
  applyEnvUpdates,
  boolEnv,
  configComplete,
  decideUiMode,
  errMessage,
  generateKey,
  maskKey,
  readEnvMap,
  settings,
} from './config.js';

// ---- infraestrutura do console ---------------------------------------------

let rl: readline.Interface | null = null;
let wizardActive = false;
let commandHandler: ((line: string) => void) | null = null;
let onCloseCb: (() => void) | null = null;

function ensureReadline(): readline.Interface {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'tiktok> ' });
  rl.on('line', (line) => {
    if (wizardActive) return; // durante o assistente, as perguntas cuidam do input
    if (commandHandler) {
      try {
        commandHandler(line);
      } catch (e) {
        console.log('Erro ao processar comando: ' + errMessage(e));
      }
    }
    if (rl && !wizardActive && commandHandler) rl.prompt();
  });
  rl.on('close', () => {
    if (onCloseCb) onCloseCb();
  });
  return rl;
}

export function ask(query: string): Promise<string> {
  const r = ensureReadline();
  return new Promise((resolve) => r.question(query, resolve));
}

export function startConsole(onCommand: (line: string) => void, onClose?: () => void): void {
  commandHandler = onCommand;
  onCloseCb = onClose ?? null;
  const r = ensureReadline();
  r.prompt();
}

export function closeConsole(): void {
  if (rl) {
    try {
      rl.close();
    } catch {
      /* ignora */
    }
  }
}

// ---- sinalização de "configuração concluída" -------------------------------

let onConfigured: (() => void) | null = null;
function signalConfigured(): void {
  if (onConfigured) {
    const fn = onConfigured;
    onConfigured = null;
    fn();
  }
}
function waitUntilConfigured(): Promise<void> {
  if (configComplete()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    onConfigured = resolve;
  });
}

// ---- assistente de CONSOLE --------------------------------------------------

async function runConsoleWizard(): Promise<void> {
  wizardActive = true;
  const cur = readEnvMap();
  try {
    console.log('\n=============================================');
    console.log('  ASSISTENTE DE CONFIGURAÇÃO (console)');
    console.log('=============================================');
    console.log('(Enter mantém o valor entre [colchetes])\n');

    const simDefault = boolEnv(cur.SIMULATE_ONLY, false);
    const simAns = (await ask(`Rodar em modo TESTE, sem conectar no TikTok? [${simDefault ? 's' : 'n'}]: `))
      .trim()
      .toLowerCase();
    const simulate = simAns === '' ? simDefault : /^(s|sim|y|yes|1|true)$/.test(simAns);

    const updates: Record<string, string> = { SIMULATE_ONLY: simulate ? 'true' : 'false' };

    if (!simulate) {
      const uDefault = cur.TIKTOK_USERNAME ?? '';
      const u = (await ask(`Usuário do TikTok (sem @) [${uDefault}]: `)).trim().replace(/^@/, '');
      updates.TIKTOK_USERNAME = u || uDefault;
    }

    const hasKey = typeof cur.API_SECRET_KEY === 'string' && cur.API_SECRET_KEY.length >= 16;
    const keyPrompt = hasKey
      ? `Chave secreta da API [manter ${maskKey(cur.API_SECRET_KEY)}] (Enter mantém): `
      : 'Chave secreta da API (Enter = gerar uma forte automaticamente): ';
    const keyAns = (await ask(keyPrompt)).trim();
    if (keyAns) updates.API_SECRET_KEY = keyAns;
    else if (!hasKey) updates.API_SECRET_KEY = generateKey();

    const portDefault = cur.PORT ?? '3000';
    const portAns = (await ask(`Porta do servidor [${portDefault}]: `)).trim();
    updates.PORT = portAns && !Number.isNaN(Number(portAns)) ? portAns : portDefault;

    applyEnvUpdates(updates);

    console.log('\n✅ Configuração salva em: ' + ENV_PATH);
    console.log('   Modo teste : ' + (settings.simulateOnly ? 'SIM' : 'não'));
    if (!settings.simulateOnly) console.log('   Usuário    : @' + settings.username);
    console.log('   Porta      : ' + settings.port);
    console.log('   API key    : ' + settings.apiKey);
    console.log('   >> Use ESTA MESMA API key no Config.ApiKey do Roblox.\n');
  } finally {
    wizardActive = false;
  }
  if (configComplete()) signalConfigured();
}

// ---- assistente VISUAL (página web local) ----------------------------------

function isLocal(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function buildConfigHtml(): string {
  const cur = readEnvMap();
  const current = {
    simulate: boolEnv(cur.SIMULATE_ONLY, settings.simulateOnly),
    username: cur.TIKTOK_USERNAME ?? settings.username ?? '',
    hasKey: (cur.API_SECRET_KEY?.length ?? 0) >= 16 || settings.apiKey.length >= 16,
    port: cur.PORT ?? String(settings.port),
  };
  const CUR = JSON.stringify(current);

  // Observação: o JS do cliente evita template literals (${}) de propósito,
  // para não conflitar com esta template string do servidor.
  return [
    '<!doctype html><html lang="pt-br"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Configuração — TikTok Roblox Bridge</title><style>',
    ':root{color-scheme:dark}*{box-sizing:border-box}',
    'body{margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1020;color:#eee;',
    'display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}',
    '.card{width:100%;max-width:440px;background:#1a1b2e;border:1px solid #2a2c45;border-radius:16px;padding:26px}',
    'h1{font-size:20px;margin:0 0 4px}p.sub{margin:0 0 20px;color:#9aa;font-size:13px}',
    'label{display:block;font-size:13px;margin:14px 0 6px;color:#ccd}',
    'input[type=text],input[type=number]{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #33365a;',
    'background:#0f1020;color:#fff;font-size:14px}',
    '.row{display:flex;gap:8px}.row input{flex:1}',
    'button{cursor:pointer;border:0;border-radius:10px;padding:11px 14px;font-size:14px;font-weight:600}',
    '.gen{background:#33365a;color:#fff}',
    '.save{width:100%;margin-top:22px;background:#ff2e63;color:#fff;padding:13px}',
    '.chk{display:flex;align-items:center;gap:8px;margin:16px 0}',
    '.hide{display:none}.ok{color:#5fd67a}.warn{color:#ffcc55}',
    '.box{margin-top:16px;padding:12px;border-radius:10px;background:#0f1020;border:1px solid #33365a;',
    'font-size:13px;word-break:break-all}code{color:#9fe}',
    '</style></head><body><div class="card">',
    '<h1>Configuração</h1><p class="sub">Preencha e salve. Isto grava o arquivo de configuração automaticamente.</p>',
    '<div class="chk"><input type="checkbox" id="sim"><label for="sim" style="margin:0">Modo teste (sem conectar no TikTok)</label></div>',
    '<div id="userWrap"><label for="user">Usuário do TikTok (sem @)</label><input type="text" id="user" placeholder="ex: meucanal"></div>',
    '<label for="key">Chave secreta da API</label>',
    '<div class="row"><input type="text" id="key" placeholder="(em branco = gerar/manter)"><button class="gen" id="genBtn" type="button">Gerar</button></div>',
    '<label for="port">Porta</label><input type="number" id="port" value="3000">',
    '<button class="save" id="saveBtn" type="button">Salvar e iniciar</button>',
    '<div id="result" class="box hide"></div>',
    '</div><script>',
    'var CUR=', CUR, ';',
    'var sim=document.getElementById("sim"),user=document.getElementById("user"),key=document.getElementById("key"),',
    'port=document.getElementById("port"),userWrap=document.getElementById("userWrap"),result=document.getElementById("result");',
    'sim.checked=CUR.simulate;user.value=CUR.username||"";port.value=CUR.port||"3000";',
    'if(CUR.hasKey){key.placeholder="(em branco = manter a atual)";}',
    'function syncUser(){userWrap.style.display=sim.checked?"none":"block";}sim.addEventListener("change",syncUser);syncUser();',
    'document.getElementById("genBtn").addEventListener("click",function(){',
    'var b=new Uint8Array(24);crypto.getRandomValues(b);var s="";for(var i=0;i<b.length;i++){s+=("0"+b[i].toString(16)).slice(-2);}key.value=s;});',
    'document.getElementById("saveBtn").addEventListener("click",async function(){',
    'var body={SIMULATE_ONLY:sim.checked?"true":"false",TIKTOK_USERNAME:user.value.trim(),API_SECRET_KEY:key.value.trim(),PORT:port.value.trim()};',
    'result.className="box";result.textContent="Salvando...";',
    'try{var r=await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});',
    'var j=await r.json();',
    'if(j.ok&&j.complete){result.innerHTML="<span class=ok>Configuração salva!</span><br>Cole esta chave no <b>Config.ApiKey</b> do Roblox:<br><code>"+j.apiKey+"</code><br><br>Pode fechar esta aba — o servidor já está rodando.";}',
    'else if(j.ok){result.innerHTML="<span class=warn>Salvo, mas falta o usuário do TikTok</b> (ou marque o modo teste).</span>";}',
    'else{result.innerHTML="<span class=warn>Erro: "+(j.error||"desconhecido")+"</span>";}',
    '}catch(e){result.innerHTML="<span class=warn>Falha ao salvar: "+e+"</span>";}});',
    '</script></body></html>',
  ].join('');
}

export function registerConfigRoutes(app: Express): void {
  app.get('/config', (req: Request, res: Response) => {
    if (!isLocal(req)) {
      res.status(403).send('A página de configuração só pode ser aberta localmente (neste computador).');
      return;
    }
    res.type('html').send(buildConfigHtml());
  });

  app.post('/api/config', (req: Request, res: Response): void => {
    if (!isLocal(req)) {
      res.status(403).json({ ok: false, error: 'Só é permitido configurar localmente.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cur = readEnvMap();
    const hadKey = typeof cur.API_SECRET_KEY === 'string' && cur.API_SECRET_KEY.length >= 16;

    const updates: Record<string, string> = {};
    updates.SIMULATE_ONLY = boolEnv(String(body.SIMULATE_ONLY ?? ''), false) ? 'true' : 'false';
    if (typeof body.TIKTOK_USERNAME === 'string') {
      updates.TIKTOK_USERNAME = body.TIKTOK_USERNAME.replace(/^@/, '').trim();
    }
    const keyInput = typeof body.API_SECRET_KEY === 'string' ? body.API_SECRET_KEY.trim() : '';
    if (keyInput) updates.API_SECRET_KEY = keyInput;
    else if (!hadKey) updates.API_SECRET_KEY = generateKey();
    if (typeof body.PORT === 'string' && body.PORT.trim() && !Number.isNaN(Number(body.PORT))) {
      updates.PORT = body.PORT.trim();
    }

    applyEnvUpdates(updates);
    const complete = configComplete();
    res.json({ ok: true, complete, apiKey: settings.apiKey });
    if (complete) signalConfigured();
  });
}

// ---- abrir o navegador (sem dependências extras) ---------------------------

export function openBrowser(url: string): void {
  try {
    let cmd: string;
    let args: string[];
    if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* silencioso: a URL é impressa como alternativa */
    });
    child.unref();
  } catch {
    /* silencioso */
  }
}

// ---- orquestrador -----------------------------------------------------------

// Roda o assistente adequado ao ambiente e resolve quando a configuração estiver
// completa (no caso inicial). Com force=true, reabre mesmo já configurado.
export async function runSetupAssistant(opts: { baseUrl: string; force?: boolean }): Promise<void> {
  const initial = !configComplete();
  if (!initial && !opts.force) return;

  const mode = decideUiMode();
  const url = opts.baseUrl.replace(/\/$/, '') + '/config';

  if (mode === 'console') {
    await runConsoleWizard();
    return;
  }

  if (mode === 'gui') {
    console.log('\n🖥️  Abrindo o assistente de configuração no navegador:');
    console.log('    ' + url);
    console.log('    (se não abrir sozinho, copie e cole esse endereço no navegador)\n');
    openBrowser(url);
  } else {
    // headless
    if (initial) {
      console.error('\n[ATENÇÃO] Sem interface gráfica e sem terminal interativo.');
      console.error('Edite o arquivo abaixo (defina ao menos API_SECRET_KEY e TIKTOK_USERNAME):');
      console.error('  ' + ENV_PATH);
      console.error('Ou rode em um computador com navegador. Encerrando.\n');
      process.exit(1);
      return;
    }
    console.log('Assistente web disponível (apenas local) em: ' + url);
  }

  if (initial) await waitUntilConfigured();
}
