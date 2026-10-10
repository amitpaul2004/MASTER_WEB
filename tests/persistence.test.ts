import {afterEach,describe,expect,it,vi} from 'vitest';
import request from 'supertest';
import yazl from 'yazl';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let store='';const oldStore=process.env.REPORT_STORE_PATH;
afterEach(async()=>{vi.resetModules();if(oldStore===undefined)delete process.env.REPORT_STORE_PATH;else process.env.REPORT_STORE_PATH=oldStore;if(store){await fs.rm(store,{recursive:true,force:true});store='';}});
function makeZip(){return new Promise<Buffer>((resolve,reject)=>{const zip=new yazl.ZipFile();const chunks:Buffer[]=[];zip.outputStream.on('data',(chunk:Buffer)=>chunks.push(chunk));zip.outputStream.on('error',reject);zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));zip.addBuffer(Buffer.from('export const saved = true;'),'src/saved.ts');zip.end();});}
describe('persistent report store',()=>{
 it('reopens a stored report after the process-local report map is reset',async()=>{store=await fs.mkdtemp(path.join(os.tmpdir(),'reposcope-store-test-'));process.env.REPORT_STORE_PATH=store;vi.resetModules();let {app}=await import('../server/src/index');const archive=await makeZip();const uploaded=await request(app).post('/api/analyze/zip').attach('archive',archive,{filename:'persist.zip',contentType:'application/zip'});const event=JSON.parse(uploaded.text.trim().split('\n').at(-1)!) as {id:string};expect(await fs.readdir(store)).toHaveLength(1);vi.resetModules();({app}=await import('../server/src/index'));const reopened=await request(app).get(`/api/analysis/${event.id}`);expect(reopened.status).toBe(200);expect(reopened.body.repository.name).toBe('persist');});
 it('treats a corrupted on-disk report as unavailable without exposing its path',async()=>{store=await fs.mkdtemp(path.join(os.tmpdir(),'reposcope-corrupt-test-'));process.env.REPORT_STORE_PATH=store;const id='123e4567-e89b-42d3-a456-426614174000';await fs.writeFile(path.join(store,`${id}.json`),'{broken json');vi.resetModules();const {app}=await import('../server/src/index');const response=await request(app).get(`/api/analysis/${id}`);expect(response.status).toBe(404);expect(response.body.message).toMatch(/not found or expired/i);expect(response.text).not.toContain(store);});
});
