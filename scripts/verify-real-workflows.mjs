import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
function chromiumPath(){if(process.env.CHROMIUM_EXECUTABLE_PATH)return process.env.CHROMIUM_EXECUTABLE_PATH;for(const p of['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'])if(existsSync(p))return p;try{const w=execSync('which chromium || which chromium-browser || which google-chrome',{encoding:'utf8'}).trim().split('\n')[0]?.trim();if(w)return w;}catch{}return undefined;}
const BASE_URL=process.env.BASE_URL||process.env.API_URL||'http://localhost:4000';
const browser=await chromium.launch({executablePath:chromiumPath(),args:['--no-sandbox']});const page=await browser.newPage({baseURL:BASE_URL});let examId='',questionId='',departmentId='';const suffix=Date.now().toString(36);const errors=[];page.on('pageerror',e=>errors.push(e.message));
async function login(username){await page.goto(BASE_URL);await page.locator('#username').fill(username);await page.locator('#password').fill('Password123');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.locator('.workspace').waitFor();}
async function logout(){await page.getByRole('button',{name:'Sign out',exact:true}).last().click();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();}
try{
 await login('doc1');await page.getByRole('link',{name:'Question bank',exact:true}).click();await page.getByRole('button',{name:'Add question'}).click();
 await page.locator('#field-text').fill('Frontend verification question '+suffix);await page.locator('#field-options').fill('Correct\nIncorrect');await page.locator('#field-correctAnswer').fill('Correct');await page.getByRole('button',{name:'Save changes'}).click();await page.getByRole('heading',{name:'Frontend verification question '+suffix}).waitFor();
 const subjectId=await page.getByLabel('Subject',{exact:true}).inputValue();const response=await page.request.get('/api/v1/question-bank?subject_id='+subjectId+'&search='+suffix);questionId=(await response.json()).rows[0].id;
 await page.getByRole('link',{name:'Exams & quizzes'}).click();await page.getByRole('link',{name:'Create exam'}).click();await page.locator('#subject').selectOption(subjectId);
 const datetime=offset=>new Date(Date.now()+offset-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);await page.locator('#start').fill(datetime(86400000));await page.locator('#end').fill(datetime(93600000));await page.getByRole('button',{name:'Submit for approval'}).click();await page.getByRole('heading',{name:'Question pool preview'}).waitFor();examId=new URL(page.url()).pathname.split('/').pop();
 await logout();await login('admin1');await page.goto(BASE_URL+'/exams/'+examId);await page.getByRole('button',{name:'Approve exam'}).click();await page.locator('.exam-summary .badge-approved').waitFor();
 await page.getByRole('button',{name:'Manage entry code'}).click();await page.locator('#field-code').fill('987654');await page.getByRole('button',{name:'Save changes'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Live monitor'}).click();await page.getByRole('heading',{name:'Live sittings'}).waitFor();
 await page.getByRole('link',{name:'Departments',exact:true}).click();await page.getByRole('button',{name:'Add department'}).click();await page.locator('#field-code').fill('T'+suffix);await page.locator('#field-name').fill('Verification '+suffix);await page.getByRole('button',{name:'Save changes'}).click();await page.getByRole('cell',{name:'Verification '+suffix}).waitFor();
 const departments=await page.request.get('/api/v1/admin/departments?search='+suffix);departmentId=(await departments.json()).rows[0].id;
 for(const name of ['Users','Subjects','Sections','Academic terms','Assignments','Browser security','Audit log']){await page.getByRole('link',{name,exact:true}).click();await page.waitForTimeout(200);assert.equal(await page.getByRole('alert').count(),0,name);}
 assert.deepEqual(errors,[]);console.log('PASS: real database question creation, exam creation, admin approval, entry-code settings, live monitoring, department creation, and admin list contracts.');
}finally{
 // Remove only verification records created by this test.
 if(examId) await page.request.post('/api/v1/admin/exams/'+examId+'/reject',{data:{reason:'Verification cleanup'}});
 for(const path of [examId&&'/api/v1/admin/exams/'+examId,questionId&&'/api/v1/question-bank/'+questionId,departmentId&&'/api/v1/admin/departments/'+departmentId].filter(Boolean)){const r=await page.request.delete(path);if(!r.ok())console.error('Cleanup failed:',path,r.status());}
 await browser.close();
}
