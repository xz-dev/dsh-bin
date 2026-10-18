// Public P test-profile plugin: invokes installed services, not an interactive model/CLI acceptance task.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search';
export const inject=['tools','subprocess','profileContext','appReady','appExit'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function apply(ctx){ctx.appReady.onReady(()=>{void(async()=>{
 await ctx.root.loader.await();
 const R=realpathSync(dirname(process.execPath)), binary=await resolveRgPath(), actual=realpathSync(binary), component=dirname(dirname(actual));
 assert.equal(process.platform,'freebsd');assert.equal(process.arch,'x64');assert.equal(process.getuid(),1001);
 assert.equal(process.env.PATH,join(R,'bin'));assert.deepEqual(readdirSync(join(R,'bin')).sort(),['node','pnpm']);
 for(const name of ['HOME','TMPDIR','XDG_CACHE_HOME'])assert.ok(process.env[name]?.startsWith('/var/tmp/dsh-freebsd-installed-search/'));
 assert.equal(actual,join(R,'app/node_modules/@vscode/ripgrep-freebsd-x64/bin/rg'));
 const sha256=hash(readFileSync(actual));assert.equal(sha256,'9f2e97934c481f3ed4440ed8a30e9bf6192ec976cebf83c9df4875ebb8d103c1');
 assert.equal(hash(readFileSync(join(component,'build-receipt.json'))),'0291c5c257ccc4a20f191d2d3635da48a697dc21ce8f14099b0d22c05a99099a');
 assert.equal(hash(readFileSync(join(component,'THIRD_PARTY_NOTICES'))),'0a765420fa69cc4c361b11e4b9db15e209a961a5071c55c227025788dce376f3');
 const cwd=join(process.env.HOME,`search-${process.pid}`);mkdirSync(cwd,{recursive:true});writeFileSync(join(cwd,'space 文件.txt'),'needle 世界\n');
 let counter=0;const call=(name,args,signal=new AbortController().signal)=>ctx.tools.execute({callId:`installed-search-${++counter}`,name,arguments:args,signal,agent:{session:{header:{id:'installed-search',cwd}}}});
 const text=r=>r.content.filter(x=>x.type==='text').map(x=>x.text).join('');const results=[];
 for(const [name,args,output,code]of [['glob',{pattern:'*.txt'},'space 文件.txt'],['glob',{pattern:'*.absent'},'No files found'],['glob',{pattern:'['},null,'SEARCH_INVALID_PATTERN'],['grep',{pattern:'needle'},'space 文件.txt\nLine 1: needle 世界'],['grep',{pattern:'absent'},'No matches found'],['grep',{pattern:'(unclosed'},null,'SEARCH_INVALID_PATTERN']]){
  const r=await call(name,args);assert.equal(r.isError,!!code,JSON.stringify(r));if(code)assert.equal(r.error?.info?.code,code);else assert.ok(text(r).includes(output));results.push({name,args,result:r});
 }
 const fifo=join(cwd,'cancel fifo');assert.equal(spawnSync('/usr/bin/mkfifo',[fifo]).status,0);
 const controller=new AbortController(),pending=call('grep',{pattern:'needle',path:fifo},controller.signal);let pid;
 try{for(let i=0;i<200&&!pid;i++){await new Promise(r=>setTimeout(r,10));const ps=spawnSync('/bin/ps',['-axww','-o','pid,args'],{encoding:'utf8'});assert.equal(ps.status,0);const row=ps.stdout.split('\n').find(line=>line.includes(actual)&&line.includes(fifo));if(row)pid=Number(row.trim().split(/\s+/)[0]);}assert.ok(pid,'actual installed rg must reach running FIFO search');}finally{controller.abort();}
 const cancelled=await pending;assert.equal(cancelled.error?.info?.code,'SEARCH_ABORTED',JSON.stringify(cancelled));
 for(let i=0;i<100;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')break;throw e;}await new Promise(r=>setTimeout(r,10));}
 assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');assert.throws(()=>process.kill(-pid,0),e=>e.code==='ESRCH');
 assert.equal(text(await call('grep',{pattern:'absent',path:'space 文件.txt'})),'No matches found');
 console.log('INSTALLED_SEARCH_REPORT '+JSON.stringify({scope:'public P test-profile plugin, actual installed services; not normal interactive CLI acceptance',R,profile:ctx.profileContext.dir,binary,actual,sha256,noticeSha256:hash(readFileSync(join(component,'THIRD_PARTY_NOTICES'))),PATH:process.env.PATH,home:process.env.HOME,tmp:process.env.TMPDIR,cache:process.env.XDG_CACHE_HOME,uid:process.getuid(),bun:process.versions.bun,results,cancellation:{pid,result:cancelled,childAbsent:true,groupAbsent:true,nextSearchPassed:true}}));ctx.appExit(0);
 })().catch(error=>{console.error('INSTALLED_SEARCH_FAILURE',error);ctx.appExit(1);});});}
