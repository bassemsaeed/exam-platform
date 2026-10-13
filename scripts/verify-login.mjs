import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
function chromiumPath(){if(process.env.CHROMIUM_EXECUTABLE_PATH)return process.env.CHROMIUM_EXECUTABLE_PATH;for(const p of['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'])if(existsSync(p))return p;try{const w=execSync('which chromium || which chromium-browser || which google-chrome',{encoding:'utf8'}).trim().split('\n')[0]?.trim();if(w)return w;}catch{}return undefined;}
const BASE_URL=process.env.BASE_URL||process.env.API_URL||'http://localhost:4000';
const SHOT_DIR=process.env.SCREENSHOT_DIR||'/tmp';
(async () => {
 const browser = await chromium.launch({executablePath:chromiumPath(),headless:true,args:['--no-sandbox']});
 const page = await browser.newPage({viewport:{width:1440,height:960}});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(BASE_URL);
 assert.equal(await page.getByText('Explore the preview').count(),0);
 assert.equal((await page.request.get(BASE_URL+'/api/v1/ready')).status(),200);
 assert.equal((await page.request.get(BASE_URL+'/api/v1/me')).status(),401);
 await page.locator('#username').fill('stu1');
 await page.locator('#password').fill('IncorrectPassword');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('alert').waitFor();
 assert.equal((await page.request.get(BASE_URL+'/api/v1/me')).status(),401);
 for (const [username,role,firstName] of [['stu1','student','Student'],['doc1','doctor','Doctor'],['ta1','ta','TA'],['admin1','admin','Admin']]) {
  await page.locator('#username').fill(username.toUpperCase());
  await page.locator('#password').fill('Password123');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:`Welcome, ${firstName}.`}).waitFor({timeout:15000});
  const me=await page.request.get(BASE_URL+'/api/v1/me');
  assert.equal(me.status(),200);assert.equal((await me.json()).role,role);
  const cookies=await page.context().cookies();
  assert.ok(cookies.some(c=>c.name.includes('session_token')&&c.httpOnly));
  await page.reload();
  await page.getByRole('heading',{name:`Welcome, ${firstName}.`}).waitFor();
  if(role==='student') await page.screenshot({path:process.env.LOGIN_SCREENSHOT_PATH || SHOT_DIR+'/o6u-real-login-success.png',fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).last().click();
  await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
  assert.equal((await page.request.get(BASE_URL+'/api/v1/me')).status(),401);
 }
 assert.deepEqual(errors,[]);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:process.env.LOGIN_MOBILE_SCREENSHOT_PATH || SHOT_DIR+'/o6u-real-login-mobile.png',fullPage:true});
 console.log('PASS: real PostgreSQL/Better Auth sign-in for student, doctor, TA and admin; HttpOnly cookie sessions; reload restoration; invalid password rejected; logout revokes session; demo disabled; mobile layout; no browser errors.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
