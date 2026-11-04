import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/lib/homing-notification.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {HomingNotification}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const tracker=new HomingNotification();
const state={motion_owner:0,motion_active:false,drive:0,pending_action:0,fault:0,last_error:0,config_verified:true,limits_valid:true,home_neg_valid:true,home_pos_valid:true};
const reply=(patch={},extra={})=>({boot_id:'1',pending:false,motor:{...state,...patch},...extra});
const start=()=>tracker.observe(9,reply({motion_owner:2,motion_active:true}));
assert.equal(tracker.observe(9,reply()),null); // connection is not completion
start();assert.equal(tracker.observe(9,reply({drive:1})),null); // cleanup unfinished
assert.equal(tracker.observe(9,reply()).tone,'ok');
assert.equal(tracker.observe(9,reply()),null); // one toast per task
start();assert.equal(tracker.observe(9,reply({fault:32})).tone,'error');
start();assert.equal(tracker.observe(9,reply({home_neg_valid:false,home_pos_valid:false})).tone,'error');
start();assert.equal(tracker.observe(9,reply({}, {boot_id:'2'})),null); // reboot is not success
start();assert.equal(tracker.observe(1,reply()),null);assert.equal(tracker.observe(9,reply({home_pos_valid:false})).tone,'ok');
console.log('PASS home notification: completion, cleanup, failure/cancel, dedup, reboot and motor isolation');
