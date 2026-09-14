import { docker } from './docker-builder.js';
import { StudioError } from './domain.js';

/** Trusted browser driver; no model shell runs here. Only GETs to the published origin are allowed. */
export async function browserSmoke(url: string) {
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url)) throw new StudioError('Invalid browser inspection URL');
  const script = `const {chromium}=require('/opt/tools/node_modules/playwright-core');
    (async()=>{const origin=process.argv[1];let browser;
      try {browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
        const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
        await context.route('**/*',route=>{const r=route.request();let u;try{u=new URL(r.url())}catch{return route.abort()}
          return u.origin===origin && r.method()==='GET' ? route.continue() : route.abort();});
        await context.routeWebSocket('**/*',socket=>socket.close());
        const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message.slice(0,200)));
        const response=await page.goto(origin,{waitUntil:'networkidle',timeout:25000});
        const title=await page.title();const text=(await page.locator('body').innerText()).trim();
        const horizontalOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
        await page.setViewportSize({width:390,height:844});
        const mobileOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
        const result={status:response.status()===200&&text.length>0&&!errors.length?'passed':'failed',httpStatus:response.status(),title,bodyCharacters:text.length,errors,horizontalOverflow,mobileOverflow,browser:browser.version(),
          scope:'Read-only live URL rendering check. Product interactions are covered by the separate recorded workshop tests; this is not customer evidence.'};
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
