import { docker } from './docker-builder.js';
import { StudioError } from './domain.js';
import { z } from 'zod';
import { verifiedFile } from './publication.js';
import type { BuildJob } from './builder.js';

const selector = z.string().min(1).max(200);
export const browserProbeSchema = z.strictObject({ schemaVersion: z.literal(1), noExtraRequests: z.boolean(), steps: z.array(z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('upload'), selector, file: z.string().min(1).max(200) }),
  z.strictObject({ action: z.literal('click'), selector }),
  z.strictObject({ action: z.literal('fill'), selector, value: z.string().max(1000) }),
  z.strictObject({ action: z.literal('check'), selector, checked: z.boolean() }),
  z.strictObject({ action: z.literal('expectText'), selector, text: z.string().min(1).max(1000) }),
  z.strictObject({ action: z.literal('expectEmpty'), selector }),
])).min(2).max(30) }).refine(p => p.steps.some(s => s.action.startsWith('expect')) && p.steps.some(s => !s.action.startsWith('expect')), 'Probe needs an interaction and an assertion');
export async function loadBrowserProbe(root: string, build: BuildJob) {
  const artifact = build.artifacts.find(a => a.path === 'prototype/browser-checks.json');
  if (!artifact) throw new StudioError('Build lacks a declarative live-browser acceptance probe');
  const probe = browserProbeSchema.parse(JSON.parse((await verifiedFile(root, artifact.file, artifact.sha256, artifact.sizeBytes)).toString()));
  const files: Record<string, string> = {};
  for (const step of probe.steps) if (step.action === 'upload') {
    const f = build.artifacts.find(a => a.path === step.file);
    if (!f || f.sizeBytes > 100000) throw new StudioError('Browser probe needs a bounded verified synthetic file');
    files[step.file] = (await verifiedFile(root, f.file, f.sha256, f.sizeBytes)).toString('base64');
  }
  return { ...probe, files };
}

/** Trusted browser driver; no model shell runs here. Only GETs to the published origin are allowed. */
export async function browserSmoke(url: string, probe?: Awaited<ReturnType<typeof loadBrowserProbe>>) {
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url)) throw new StudioError('Invalid browser inspection URL');
  const script = `const {chromium}=require('/opt/tools/node_modules/playwright-core');
    (async()=>{const origin=process.argv[1],probe=${JSON.stringify(probe ?? null)};let browser;
      try {browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
        const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
        await context.route('**/*',route=>{const r=route.request();let u;try{u=new URL(r.url())}catch{return route.abort()}
          return u.origin===origin && r.method()==='GET' ? route.continue() : route.abort();});
        await context.routeWebSocket('**/*',socket=>socket.close());
        const page=await context.newPage();page.setDefaultTimeout(5000);const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message.slice(0,200)));page.on('request',r=>requests.push(r.url()));
        const response=await page.goto(origin,{waitUntil:'networkidle',timeout:25000});
        const baseline=requests.length;let checked=0;
        if(probe)for(const step of probe.steps){const locator=page.locator(step.selector);
          if(step.action==='upload'){await locator.setInputFiles({name:step.file.split('/').pop(),mimeType:'text/csv',buffer:Buffer.from(probe.files[step.file],'base64')});}
          else if(step.action==='click')await locator.click();
          else if(step.action==='fill')await locator.fill(step.value);
          else if(step.action==='check')await locator.setChecked(step.checked);
          else if(step.action==='expectText'){await locator.filter({hasText:step.text}).waitFor({state:'visible'});}
          else if(step.action==='expectEmpty'){await page.waitForFunction(s=>{const e=document.querySelector(s);return e&&e.textContent.trim()===''},step.selector);}
          checked++;
        }
        if(probe?.noExtraRequests&&requests.length!==baseline)throw Error('File interactions triggered network requests');
        const title=await page.title();const text=(await page.locator('body').innerText()).trim();
        const horizontalOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
        await page.setViewportSize({width:390,height:844});
        const mobileOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
        const result={status:response.status()===200&&text.length>0&&!errors.length?'passed':'failed',httpStatus:response.status(),title,bodyCharacters:text.length,errors,horizontalOverflow,mobileOverflow,browser:browser.version(),
          interactionChecks:probe?{passed:checked,expected:probe.steps.length,noExtraRequests:requests.length===baseline}:null,
          scope:probe?'Live URL rendering plus declarative product interactions, assertions and network checks; not customer evidence.':'Read-only live URL rendering check; not customer evidence.'};
        console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
      } finally {await browser?.close()}
    })().catch(()=>{console.log(JSON.stringify({status:'failed',reason:'Live browser inspection could not complete'}));process.exitCode=1});`;
  const result = await docker(['run', '--rm', '--network', 'bridge', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '768m', '--cpus', '1',
    '--user', '1000:1000', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,uid=1000,gid=1000',
    '--entrypoint', 'node', 'theartist-workshop:1', '-e', script, url], '', 45000);
  try { return { ...JSON.parse(result.output.trim()), exitCode: result.code }; }
  catch { return { status: 'failed', exitCode: result.code, reason: 'Live browser driver did not produce a valid record' }; }
}
