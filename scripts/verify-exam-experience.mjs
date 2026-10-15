import { chromium } from "playwright";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync), headless: true });
const base = process.env.FRONTEND_URL || "http://127.0.0.1:5189";
const errors = [];
async function examTest(notesEnabled) {
  const page = await browser.newPage({viewport: notesEnabled ? {width: 1440,height: 1000} : {width: 390,height: 844}});
  page.setDefaultTimeout(10000);
  console.log("Testing notes enabled:", notesEnabled);
  page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
  page.on('dialog', d => d.accept());
  let notes = '', submitted = false;
  const tokens = [];
  const questions = Array.from({length:7}, (_,i) => ({id:`q${i}`,questionId:`q${i}`,text:`Question text ${i+1}`,options:['First','Second','Third'],grade:1,questionType:'mcq',selectedAnswer:null,isFlagged:false}));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    let data = {};
    if(path.endsWith('/me')) data={id:'student-test',name:'Test Student',email:'student@example.test',role:'student'};
    else if(path.endsWith('/readiness')) data={subject:{name:'Math',code:'M1'},durationMinutes:30,startTime:new Date(Date.now()-60000).toISOString(),endTime:new Date(Date.now()+1800000).toISOString(),ready:true,resumable:tokens.length>0,submitted,requiresCode:false,sebVerified:true,serverTime:new Date().toISOString()};
    else if(path.endsWith('/start')) {tokens.push(body.entryToken);data={id:'attempt-test',examId:'test',status:'in_progress',remainingSeconds:1800,questions,notesEnabled,notes};}
    else if(path.endsWith('/answer')) { questions.find(q=>q.questionId===body.questionId).selectedAnswer=body.selectedAnswer;data={ok:true};}
    else if(path.endsWith('/notes')) { assert.equal(notesEnabled,true);notes=body.notes;data={ok:true}; }
    else if(path.endsWith('/submit')) {submitted=true;data={totalGrade:7,status:'submitted'};}
    else if(path.endsWith('/heartbeat')) data={remainingSeconds:1800};
    else if(path.endsWith('/events')) { await route.fulfill({status:200,contentType:'text/event-stream',body:': connected\n\n'});return; }
    else data={rows:[],total:0,page:1,limit:10};
    await route.fulfill({json:data});
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  console.log('Opening app');
  await page.goto(base+'/exams', {waitUntil:'domcontentloaded'});
  await page.goto(base+'/exams/test/take', {waitUntil:'domcontentloaded'});
  console.log('Starting attempt');
  await page.getByLabel('I understand the exam rules').check();
  await page.getByRole('button',{name:'Start or resume exam',exact:true}).click();
  await page.locator('.exam-question').first().waitFor();
  assert.equal(await page.locator('#portal-sidebar').count(),0);
  assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).count(),0);
  assert.equal(await page.locator('.workspace-footer').count(),0);
  assert.equal(await page.locator('.workspace-header button').count(),1);
  assert.equal(await page.locator('.exam-question').count(),4);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Exam should fit the viewport');
  await page.getByLabel('Theme',{exact:true}).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.getByRole('button',{name:'Calculator',exact:true}).click();
  const calc=page.locator('.exam-calculator');
  for(const key of ['7','+','3','=']) await calc.getByRole('button',{name:key,exact:true}).click();
  assert.equal(await calc.locator('output').innerText(),'10');
  assert.equal(await page.getByRole('button',{name:'Notes',exact:true}).count(),notesEnabled?1:0);
  if(notesEnabled) {
    await page.getByRole('button',{name:'Notes',exact:true}).click();
    await page.getByLabel('Private scratch notes (not graded)').fill('Working: 2 + 2 = 4');
    await page.getByText('Notes saved',{exact:true}).waitFor();
    assert.equal(notes,'Working: 2 + 2 = 4');
  }
  console.log('Answering page');
  for(const q of await page.locator('.exam-question').all()) await q.getByRole('radio').first().check();
  await page.getByText('Answers synced',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Next',exact:true}).click();
  assert.equal(await page.locator('.exam-question').count(),3);
  assert.equal(await page.getByRole('button',{name:'Next',exact:true}).count(),0);
  assert.equal(await page.locator('.runner-controls').getByRole('button',{name:'Submit assessment',exact:true}).isDisabled(),true);
  console.log('Answering page');
  for(const q of await page.locator('.exam-question').all()) await q.getByRole('radio').first().check();
  await page.getByText('Answers synced',{exact:true}).waitFor();
  await page.locator('.runner-controls').getByRole('button',{name:'Submit assessment',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(submitted,false);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(submitted,false);
  // Browser history cannot navigate out while an attempt is active.
  await page.evaluate(()=>{history.pushState({},'', '/');window.dispatchEvent(new PopStateEvent('popstate'));});
  await page.waitForURL('**/exams/test/take');
  console.log('Checking submission');
  if (process.env.EXAM_SCREENSHOTS === "true") await page.screenshot({path:`scripts/exam-${notesEnabled?'notes':'no-notes'}.png`,fullPage:true});
  await page.locator('.runner-controls').getByRole('button',{name:'Submit assessment',exact:true}).click();
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await page.getByRole('heading',{name:'Submission complete',exact:true}).waitFor();
  assert.equal(submitted,true);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('active-exam-student-test')),null);
  await page.close();
}
async function bankTest() {
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  let selected = false, created = 0, patches = 0, uploads = 0, question = null;
  await page.route('**/api/**', async route => {
    const req=route.request(), url=new URL(req.url()), path=url.pathname;
    let data={rows:[],total:0,page:1,limit:10};
    if(path.endsWith('/me')) data={id:'doctor-test',name:'Test Doctor',email:'doctor@example.test',role:'doctor'};
    else if(path.includes('/notifications')) data=[];
    else if(path.endsWith('/subjects')) data={rows:[{id:'subject-test',name:'Mathematics',code:'M1'}],total:1,page:1,limit:100};
    else if(path.endsWith('/image')) {
      uploads++; assert.ok(req.postDataBuffer().includes(Buffer.from('image')));
      if(uploads===1) {await route.fulfill({status:500,json:{error:'Simulated upload failure'}});return;}
      question.imageUrl='/uploads/test.png';data={imageUrl:question.imageUrl};
    } else if(path.includes('/question-bank')) {
      assert.equal(selected,true,'Bank requests must wait for subject selection');
      if(req.method()==='POST') {created++;question={id:'created-test',...req.postDataJSON()};data=question;}
      else if(req.method()==='PATCH') {patches++;question={...question,...req.postDataJSON()};data=question;}
      else {assert.equal(url.searchParams.get('subject_id'),'subject-test');data={rows:question?[question]:[],total:question?1:0,page:1,limit:10};}
    }
    await route.fulfill({json:data});
  });
  await page.goto(base+'/questions',{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Question bank',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Add question',exact:true}).isDisabled(),true);
  selected=true;
  await page.getByRole('button',{name:'Subject',exact:true}).click();
  await page.getByRole('option',{name:'M1'}).click();
  await page.getByRole('button',{name:'Add question',exact:true}).click();
  await page.getByLabel('Question text',{exact:true}).fill('What is two plus two?');
  await page.getByTitle('Mark as correct').first().click();
  await page.getByLabel('Attach question image').setInputFiles({name:'diagram.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=','base64')});
  await page.getByRole('button',{name:'Save question',exact:true}).click();
  await page.getByText('Simulated upload failure',{exact:true}).waitFor();
  assert.equal(created,1);
  await page.getByRole('button',{name:'Save question',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('heading',{name:'What is two plus two?',exact:true}).waitFor();
  assert.equal(created,1);assert.equal(patches,1);assert.equal(uploads,2);
  assert.equal(question.subjectId,'subject-test');
  await page.goto(base+'/exams/new',{waitUntil:'domcontentloaded'});
  await page.getByLabel('Allow student notes').check();
  await page.getByLabel('Maximum re-entries (excluding the first entry)').fill('2');
  await page.close();
  console.log('PASS: subject-first bank, create-time image attachment, upload retry without duplicate, and doctor exam settings. API responses mocked.');
}
try {
  if (!process.env.BANK_ONLY) { await examTest(true); await examTest(false); } await bankTest();
  assert.deepEqual(errors,[]);
  console.log('PASS: exam isolation, theme, four-question pages, calculator, optional notes, save, navigation lock, final-page submit, cancel/confirm, and unlock after submission. API responses mocked.');
} finally {await browser.close();}
