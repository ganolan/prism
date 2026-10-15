// Read-only spike (2026-10-12): which request loads the Schoology rubric that is
// attached to an essay question, when the teacher opens it on an attempt page?
// Every non-GET request is aborted, so the rubric popup can be opened safely.
// Captured responses go to OUT_DIR (they can hold student work: keep them out of the repo).
// Usage: OUT_DIR=<dir> [PRISM_SESSION_DIR=<dir>] node scripts/probe-assessment-rubric.js <attemptPath>
import { sessionStateFile } from '../server/lib/sessionPaths.js';
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
const BASE='https://schoology.hkis.edu.hk';
const OUT=process.env.OUT_DIR;
const b=await chromium.launch({headless:true});
const c=await b.newContext({storageState:sessionStateFile()});
// Read-only guard: abort every non-GET request.
await c.route('**/*', r => r.request().method()==='GET' ? r.continue() : (console.log('BLOCKED', r.request().method(), r.request().url().replace(BASE,'')), r.abort()));
const p=await c.newPage();
const seen=[];
p.on('response', async res => { const u=res.url(); if (/iapi|rubric|grading/i.test(u) && !/\.(js|css|png|svg)/.test(u)) { let body=''; try{ body=await res.text(); }catch{} seen.push({u:u.replace(BASE,''),s:res.status(),len:body.length}); writeFileSync(`${OUT}/xhr-${seen.length}.txt`, u+'\n'+body); }});
await p.goto(BASE + process.argv[2],{waitUntil:'networkidle',timeout:60000});
console.log('before click', JSON.stringify(seen));
const btn = p.locator('.s-grades-rubric-grading-launch-btn').first();
console.log('btn html', (await btn.innerHTML()).slice(0,300));
const clickable = btn.locator('a, button, [role=button], span').first();
await clickable.click({timeout:10000}).catch(e=>console.log('click err',e.message));
await p.waitForTimeout(5000);
console.log('after click', JSON.stringify(seen,null,1));
writeFileSync(`${OUT}/attempt-after-click.html`, await p.content());
await b.close();
